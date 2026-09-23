import type { ConnectionManager } from "@/connection/connection-manager";
import {
  isRpcRequest,
  NexusMessageType,
  type NexusMessage,
  type RpcRequest,
  type RpcMessage,
} from "@/types/message";
import type { AdapterModel } from "@/types/adapter-model";
import { NexusDisconnectedError } from "@/errors/call-errors";
import { Logger } from "@/logger";
import { CallProcessor } from "./call-processor";
import { MessageHandler, type AuthorizedCall } from "./message/message-handler";
import { PayloadProcessor } from "./payload/payload-processor";
import { PendingCallManager } from "./pending-call-manager";
import { ProxyFactory } from "./proxy-factory";
import { ResourceManager } from "./resource-manager";
import {
  getServiceInvocationHook,
  SERVICE_ON_DISCONNECT,
} from "./service-invocation-hooks";
import { Result } from "better-result";
import {
  NexusError,
  NexusProtocolError,
  NexusUsageError,
  serializeFrameworkError,
  toFrameworkProtocolError,
} from "../errors";
import { ResourceScopes } from "./resource-scopes";
import {
  ResourceScopeHandle,
  scopeClosedError,
  type ResourceScope,
} from "./resource-scope";
import {
  RelayForwarder,
  relayBudget,
  type RelayRegistration,
  type RelayPeer,
} from "./relay-forwarder";
import type { DispatchCallOptions } from "./call-processor";
import type {
  NexusAuthorizationPolicy,
  ServiceProvider,
} from "@/api/types/config";
import type { Connection } from "@/api/connection";

export class Engine<M extends AdapterModel> {
  private readonly logger = new Logger("L3 --- Engine");

  // Session-owned resources and outbound call lifecycle.
  private readonly resourceManager = new ResourceManager();
  private readonly pendingCallManager = new PendingCallManager();
  private readonly scopes = new ResourceScopes((scope, notifyPeer) =>
    this.closeScope(scope, notifyPeer),
  );
  private readonly relays = new Map<string, RelayRegistration>();
  private readonly forwards = new Map<ResourceScopeHandle, RelayForwarder>();
  private readonly routes = new Map<
    ResourceScopeHandle,
    (message: RpcMessage, receivedAt: number) => Result<void, Error>
  >();

  // Expose only the factory's creation capability, not the factory itself.
  public readonly createServiceProxy: ProxyFactory["createServiceProxy"];
  private readonly messageHandler: MessageHandler<M>;

  /** One L2-to-call error boundary shared by calls, replies and releases. */
  private readonly safeSendMessage = (
    message: NexusMessage,
    connectionId: string,
  ): Result<void, Error> => {
    if (
      "scopeId" in message &&
      message.scopeId &&
      !(message.type === NexusMessageType.RELEASE && message.target === "scope")
    ) {
      const scope = this.scopes.get(connectionId, message.scopeId);
      if (!scope || scope.closed)
        return Result.err(
          scope
            ? scopeClosedError(scope)
            : new NexusProtocolError("Unknown outbound resource scope."),
        );
    }
    return this.connectionManagerState
      .safeSendMessage(message, connectionId)
      .mapError((error) =>
        error.code === "E_CONN_CLOSED" &&
        !(error instanceof NexusDisconnectedError)
          ? new NexusDisconnectedError(
              error.message,
              "E_CONN_CLOSED",
              error.context,
              error.cause,
            )
          : error,
      );
  };

  /** Local release is final; remote notification is best effort, without an ACK. */
  private readonly dispatchRelease = (
    resourceId: string,
    connectionId: string,
    scope?: ResourceScope,
  ): void => {
    if (scope?.closed) return;
    this.safeSendMessage(
      {
        type: NexusMessageType.RELEASE,
        id: null,
        resourceId,
        ...(scope ? { scopeId: scope.id } : {}),
      },
      connectionId,
    ).tapError((error) =>
      this.logger.warn(
        `Failed to dispatch release for resource #${resourceId} to ${connectionId}.`,
        error,
      ),
    );
  };

  /** Compose service, payload, call, and message processing around one manager. */
  constructor(
    private readonly connectionManagerState: Pick<
      ConnectionManager<M>,
      | "safeSendMessage"
      | "isConnectionReady"
      | "getConnectionAuthSnapshot"
      | "publishProviders"
      | "removeProviders"
    >,
    config: {
      policy?: NexusAuthorizationPolicy<M>;
      getConnection: (id: string) => Connection<M>;
      callTimeout?: number;
    },
  ) {
    const proxyFactory = new ProxyFactory(
      {
        // Construction never dispatches: this closes the proxy/payload/call cycle
        // without making Engine a second call-processing entry point.
        safeDispatchCall: (options) => this.dispatch(callProcessor, options),
        dispatchRelease: this.dispatchRelease,
      },
      this.resourceManager,
      config.getConnection,
      config.callTimeout,
    );
    this.createServiceProxy =
      proxyFactory.createServiceProxy.bind(proxyFactory);
    const payloadProcessor = new PayloadProcessor(
      this.resourceManager,
      proxyFactory,
    );
    this.messageHandler = new MessageHandler({
      safeSendMessage: this.safeSendMessage,
      dispatchRelease: this.dispatchRelease,
      pendingCalls: this.pendingCallManager,
      resourceManager: this.resourceManager,
      payloadProcessor,
      policy: config.policy,
      getConnectionAuthContext: (connectionId) =>
        this.connectionManagerState.getConnectionAuthSnapshot(connectionId),
    });
    const callProcessor = new CallProcessor({
      isConnectionReady: (id) =>
        this.connectionManagerState.isConnectionReady(id),
      safeSendMessage: this.safeSendMessage,
      payloadProcessor,
      pendingCallManager: this.pendingCallManager,
    });
  }

  /** Atomically register providers locally, then announce their availability. */
  public provideServices(
    providers: readonly ServiceProvider<object, M>[],
  ): void {
    if (providers.some(({ token }) => this.relays.has(token.id)))
      throw new NexusUsageError("A relay already owns this service entry.");
    const registrations = providers.map(({ token, service, policy }) => ({
      name: token.id,
      service,
      policy,
    }));
    this.resourceManager.registerExposedServices(registrations);
    this.connectionManagerState.publishProviders(
      registrations.map(({ name }) => name),
    );
  }

  /** Consumes inbound processing failures locally; completion never promotes an RPC error to session failure. */
  public async onMessage(
    message: NexusMessage,
    sourceConnectionId: string,
  ): Promise<void> {
    const started = performance.now();
    const root =
      isRpcRequest(message) && message.resourceId === null
        ? message
        : undefined;
    const resolved = this.resolveScope(message, sourceConnectionId);
    if (resolved.isErr()) {
      if (isRpcRequest(message))
        this.reject(message, sourceConnectionId, resolved.error);
      return;
    }
    const scope = resolved.value;
    let authorization: AuthorizedCall<M> | undefined;
    if (scope && "scopeId" in message) {
      if (
        message.type === NexusMessageType.RELEASE &&
        message.target === "scope"
      ) {
        scope.close();
        return;
      }
      const route = this.routes.get(scope);
      if (route) {
        route(message, started).tapError(() => scope.close());
        return;
      }
      const registration = this.relays.get(scope.serviceId);
      let forwarder = this.forwards.get(scope);
      if (registration && scope.direction === "provider") {
        if (!forwarder) {
          if (!root) return;
          // Bind registration disposal before application authorization can await.
          // Construction owns only lifecycle; forwarding acquires the upstream.
          forwarder = new RelayForwarder(
            scope,
            registration,
            (reply) => this.safeSendMessage(reply, sourceConnectionId),
            () => this.scopes.reserveWaiter(sourceConnectionId),
          );
          this.forwards.set(scope, forwarder);
        }
        if (root) {
          const budget = relayBudget(root);
          if (budget.isErr()) {
            this.reject(root, sourceConnectionId, budget.error);
            scope.close();
            return;
          }
        }
      }
      if (root) {
        const allowed = await this.authorizeScope(
          root,
          sourceConnectionId,
          scope,
        );
        if (allowed.isErr()) {
          this.reject(root, sourceConnectionId, allowed.error);
          this.scopes.rejectAdmission(scope);
          return;
        }
        if (scope.closed) return;
        const admitted = this.scopes.admit(scope);
        if (admitted.isErr()) {
          this.reject(root, sourceConnectionId, admitted.error);
          scope.close();
          return;
        }
        authorization = allowed.value;
      }
      if (forwarder) {
        (await forwarder.forward(message, started)).tapError((error) =>
          this.logger.debug("Relay forwarding failed", error),
        );
        return;
      }
    } else if (root && this.relays.has(String(root.path[0]))) {
      this.reject(
        root,
        sourceConnectionId,
        new NexusProtocolError("Relay requires a resource scope."),
      );
      return;
    }
    const result = await this.messageHandler.safeHandleMessage(
      message,
      sourceConnectionId,
      scope,
      authorization,
    );
    if (result.isErr()) {
      try {
        this.logger.error("Incoming message handling failed", result.error);
      } catch {
        // The original failure is already consumed; do not replace it with a log failure.
      }
    }
  }

  /** Resolve identity and direction before authorization, resource access, or forwarding. */
  private resolveScope(
    message: NexusMessage,
    source: string,
  ): Result<ResourceScopeHandle | undefined, Error> {
    if (!("scopeId" in message) || !message.scopeId)
      return Result.ok(undefined);
    const root =
      isRpcRequest(message) && message.resourceId === null
        ? message
        : undefined;
    const scope = this.scopes.get(source, message.scopeId);
    if (!scope) {
      if (!root || typeof root.path[0] !== "string")
        return Result.err(new NexusProtocolError("Unknown resource scope."));
      const service = root.path[0];
      if (
        !this.relays.has(service) &&
        !this.resourceManager.getExposedServiceRecord(service)
      )
        return Result.err(new NexusProtocolError("Unknown scoped service."));
      if (this.relays.has(service)) {
        const budget = relayBudget(root);
        if (budget.isErr()) return budget;
      }
      return this.scopes.reserve(source, service, message.scopeId);
    }
    if (scope.closed) return Result.err(scopeClosedError(scope));
    if (
      root &&
      (scope.direction !== "provider" || root.path[0] !== scope.serviceId)
    )
      return Result.err(
        new NexusProtocolError("Root operation does not belong to this scope."),
      );
    if (
      !root &&
      !this.scopes.isAdmitted(scope) &&
      !(message.type === NexusMessageType.RELEASE && message.target === "scope")
    )
      return Result.err(
        new NexusProtocolError("Resource scope has not been admitted."),
      );
    return Result.ok(scope);
  }

  /** Release session-owned state before notifying service and proxy observers. */
  public onDisconnect(connectionId: string): void {
    this.pendingCallManager.onDisconnect(connectionId);
    this.scopes.closeConnection(connectionId);
    this.resourceManager.cleanupConnection(connectionId);
    for (const service of this.resourceManager.listExposedServices()) {
      try {
        getServiceInvocationHook(
          service,
          SERVICE_ON_DISCONNECT,
        )?.(connectionId);
      } catch (error) {
        this.logger.error("Exposed service disconnect hook failed.", error);
      }
    }
  }

  public safeCreateScope(
    connectionId: string,
    serviceId: string,
  ): Result<ResourceScopeHandle, Error> {
    if (!this.connectionManagerState.isConnectionReady(connectionId))
      return Result.err(
        new NexusDisconnectedError("The connection is closed."),
      );
    return this.scopes.safeCreate(connectionId, serviceId);
  }

  public ownsScope(
    connectionId: string,
    serviceId: string,
    scope: ResourceScope,
  ): boolean {
    return this.scopes.owns(connectionId, serviceId, scope);
  }

  public installRelay(registration: RelayRegistration): Result<void, Error> {
    if (
      registration.services.some(
        (id) =>
          this.relays.has(id) ||
          this.resourceManager.getExposedServiceRecord(id),
      )
    )
      return Result.err(
        new NexusUsageError(
          "Relay service conflicts with an existing provider.",
        ),
      );
    for (const id of registration.services) this.relays.set(id, registration);
    this.connectionManagerState.publishProviders(registration.services);
    return Result.ok(undefined);
  }

  public removeRelay(registration: RelayRegistration): void {
    const removed = registration.services.filter(
      (id) => this.relays.get(id) === registration,
    );
    for (const id of removed) this.relays.delete(id);
    if (removed.length) this.connectionManagerState.removeProviders(removed);
  }

  public relayPeer(connectionId: string): RelayPeer {
    return {
      createScope: (serviceId) => this.safeCreateScope(connectionId, serviceId),
      send: (message, scope) =>
        scope.closed
          ? Result.err(scopeClosedError(scope))
          : this.safeSendMessage(message, connectionId),
      bind: (scope, receive) => this.routes.set(scope, receive),
    };
  }

  private dispatch(processor: CallProcessor, options: DispatchCallOptions) {
    if (!options.scope && options.resourceId === null) {
      if (!this.connectionManagerState.isConnectionReady(options.connectionId))
        return processor.safeProcess(options);
      const scope = this.scopes.safeDefault(
        options.connectionId,
        String(options.path[0]),
      );
      if (scope.isErr())
        return Promise.resolve(
          Result.err(toFrameworkProtocolError(scope.error)),
        );
      return processor.safeProcess({ ...options, scope: scope.value });
    }
    return processor.safeProcess(options);
  }

  private async authorizeScope(
    message: RpcRequest,
    source: string,
    scope: ResourceScopeHandle,
  ): Promise<Result<AuthorizedCall<M>, Error>> {
    if (this.scopes.isAdmitted(scope))
      return this.messageHandler.authorize(message, source, scope);
    const reserved = this.scopes.reserveWaiter(source);
    if (reserved.isErr()) return reserved;
    let stop = () => {};
    try {
      const authorization = this.messageHandler.authorize(
        message,
        source,
        scope,
      );
      if (!(authorization instanceof Promise)) return authorization;
      const ended = new Promise<Result<never, Error>>((resolve) => {
        stop = scope.onClosed(() =>
          resolve(Result.err(scopeClosedError(scope))),
        );
      });
      return await Promise.race([authorization, ended]);
    } finally {
      stop();
      reserved.value();
    }
  }

  private closeScope(scope: ResourceScopeHandle, notifyPeer: boolean): void {
    this.routes.delete(scope);
    this.forwards.delete(scope);
    this.resourceManager.cleanupScope(scope);
    this.pendingCallManager.onScopeClosed(scope);
    if (
      notifyPeer &&
      this.connectionManagerState.isConnectionReady(scope.connectionId)
    )
      this.safeSendMessage(
        {
          type: NexusMessageType.RELEASE,
          id: null,
          target: "scope",
          scopeId: scope.id,
        },
        scope.connectionId,
      ).tapError((error) =>
        this.logger.debug("Scope closure notification failed", error),
      );
  }

  private reject(message: RpcRequest, source: string, error: Error): void {
    const framework =
      error instanceof NexusError ? error : toFrameworkProtocolError(error);
    // Rejections can address an unknown/closed scope; bypass the outgoing liveness guard.
    this.connectionManagerState
      .safeSendMessage(
        {
          type: NexusMessageType.ERR,
          id: message.id,
          error: serializeFrameworkError(framework),
          ...(message.scopeId ? { scopeId: message.scopeId } : {}),
        },
        source,
      )
      .tapError((failure) =>
        this.logger.debug("Relay rejection could not be sent", failure),
      );
  }
}
