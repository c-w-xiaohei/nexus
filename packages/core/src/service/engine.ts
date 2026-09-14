import type { ConnectionManager } from "@/connection/connection-manager";
import type { NexusMessage, ReleaseMessage } from "@/types/message";
import { NexusMessageType } from "@/types/message";
import type { AdapterModel } from "@/types/adapter-model";
import { NexusDisconnectedError } from "@/errors/call-errors";
import { Logger } from "@/logger";
import {
  CallProcessor,
  type CallBinding,
  type DispatchCallOptions,
} from "./call-processor";
import { MessageHandler } from "./message/message-handler";
import { PayloadProcessor } from "./payload/payload-processor";
import { PendingCallManager } from "./pending-call-manager";
import { ProxyFactory } from "./proxy-factory";
import { ResourceManager } from "./resource-manager";
import {
  getServiceInvocationHook,
  SERVICE_ON_DISCONNECT,
} from "./service-invocation-hooks";
import { installProxyLifecycle } from "./proxy-lifecycle";
import { Result } from "better-result";
import type { NexusAuthorizationPolicy } from "@/api/types/config";
import type { Connection } from "@/api/connection";
import type { NexusCallError } from "@/errors";

export class Engine<M extends AdapterModel> {
  private readonly logger = new Logger("L3 --- Engine");
  private readonly resourceManager: ResourceManager;
  private readonly payloadProcessor: PayloadProcessor;
  private readonly proxyFactory: ProxyFactory;
  private readonly messageHandler: MessageHandler<M>;
  private readonly pendingCallManager: PendingCallManager;
  private readonly callProcessor: CallProcessor;

  private readonly disconnectListeners = new Map<string, Set<() => void>>();
  private readonly staleListeners = new Map<string, Set<() => void>>();

  /** Compose service, payload, call, and message processing around one manager. */
  constructor(
    private readonly connectionManagerState: ConnectionManager<M>,
    config: {
      providers?: Record<
        string,
        { service: object; policy?: NexusAuthorizationPolicy<M> }
      >;
      policy?: NexusAuthorizationPolicy<M>;
      getConnection: (id: string) => Connection<M>;
      callTimeout?: number;
    },
  ) {
    this.resourceManager = new ResourceManager();

    if (config.providers) {
      this.registerServices(config.providers);
    }

    this.proxyFactory = new ProxyFactory(
      this,
      this.resourceManager,
      config.getConnection,
      config.callTimeout,
    );
    this.payloadProcessor = new PayloadProcessor(
      this.resourceManager,
      this.proxyFactory,
    );
    this.pendingCallManager = new PendingCallManager();
    this.messageHandler = new MessageHandler({
      safeSendMessage: (message, connectionId) =>
        this.safeSendMessage(message, connectionId),
      dispatchRelease: (resourceId, connectionId) =>
        this.dispatchRelease(resourceId, connectionId),
      pendingCalls: this.pendingCallManager,
      resourceManager: this.resourceManager,
      payloadProcessor: this.payloadProcessor,
      policy: config.policy,
      getConnectionAuthContext: (connectionId) =>
        this.connectionManagerState.getConnectionAuthSnapshot(connectionId),
    });
    this.callProcessor = new CallProcessor({
      isConnectionReady: (id) =>
        this.connectionManagerState.isConnectionReady(id),
      sendMessage: (message, connectionId) =>
        this.safeSendMessage(message, connectionId),
      payloadProcessor: this.payloadProcessor,
      pendingCallManager: this.pendingCallManager,
    });
  }

  /** Create a service proxy and attach observers for its bound session. */
  public createServiceProxy<T extends object>(
    serviceName: string,
    options: CallBinding,
  ): T {
    const proxy = this.proxyFactory.createServiceProxy<T>(serviceName, options);
    const { connectionId } = options;
    installProxyLifecycle(proxy, serviceName, connectionId, {
      subscribeDisconnect: (callback) =>
        this.subscribeDisconnect(connectionId, callback),
      subscribeStale: (callback) => this.subscribeStale(connectionId, callback),
    });
    return proxy;
  }

  /** Observes L3 disconnect cleanup; cancellation removes only this subscription. */
  private subscribeDisconnect(
    connectionId: string,
    callback: () => void,
  ): () => void {
    let listeners = this.disconnectListeners.get(connectionId);
    if (!listeners)
      this.disconnectListeners.set(connectionId, (listeners = new Set()));
    listeners.add(callback);
    return () => {
      listeners?.delete(callback);
      if (listeners?.size === 0) this.disconnectListeners.delete(connectionId);
    };
  }

  /** Observe identity changes for proxies bound to one session. */
  private subscribeStale(
    connectionId: string,
    callback: () => void,
  ): () => void {
    let listeners = this.staleListeners.get(connectionId);
    if (!listeners)
      this.staleListeners.set(connectionId, (listeners = new Set()));
    listeners.add(callback);
    return () => {
      listeners?.delete(callback);
      if (listeners?.size === 0) this.staleListeners.delete(connectionId);
    };
  }

  /** Register providers through the safe batch path and throw at this boundary. */
  public registerServices(
    providers: Record<
      string,
      { service: object; policy?: NexusAuthorizationPolicy<M> }
    >,
  ): void {
    const result = this.safeProvideServicesBatch(providers);
    if (result.isErr()) {
      throw result.error;
    }
  }

  /** Atomically register providers locally, then announce their availability. */
  public safeProvideServicesBatch(
    providers: Record<
      string,
      { service: object; policy?: NexusAuthorizationPolicy<M> }
    >,
  ): Result<void, Error> {
    return this.resourceManager
      .safeRegisterExposedServicesBatch(
        Object.entries(providers).map(([name, registration]) => ({
          name,
          service: registration.service,
          policy: registration.policy,
        })),
      )
      .andThen(() =>
        this.connectionManagerState.safePublishProviders(
          Object.keys(providers),
        ),
      );
  }

  /** Dispatches an already-bound proxy operation; acquisition and routing remain outside L3. */
  public safeDispatchCall(
    options: DispatchCallOptions,
  ): Promise<Result<any, NexusCallError>> {
    return this.callProcessor.safeProcess(options);
  }

  /** Best-effort notification after local release; logs send failure without waiting for a remote ACK. */
  public dispatchRelease(resourceId: string, connectionId: string): void {
    const message: ReleaseMessage = {
      type: NexusMessageType.RELEASE,
      id: null,
      resourceId,
    };
    const result = this.safeSendMessage(message, connectionId);
    if (result.isErr())
      this.logger.warn(
        `Failed to dispatch release for resource #${resourceId} to ${connectionId}.`,
        result.error,
      );
  }

  /** Handles an incoming message and reports local failures without manufacturing a second reply. */
  public safeOnMessage(
    message: NexusMessage,
    sourceConnectionId: string,
  ): Promise<Result<void, globalThis.Error>> {
    this.logger.debug(
      `<- Received message #${message.id ?? "N/A"} from connection ${sourceConnectionId}`,
      message,
    );

    return this.messageHandler
      .safeHandleMessage(message, sourceConnectionId)
      .then((result) => {
        if (result.isErr())
          this.logger.error("Incoming message handling failed", result.error);
        return result;
      });
  }

  /**
   * Hands a message to exactly one live session.
   * Success means local acceptance, not remote execution.
   */
  public safeSendMessage(
    message: NexusMessage,
    connectionId: string,
  ): Result<void, Error> {
    const result = this.connectionManagerState.safeSendMessage(
      connectionId,
      message,
    );
    if (result.isErr()) {
      const error = result.error;
      if (
        error.code === "E_CONN_CLOSED" &&
        !(error instanceof NexusDisconnectedError)
      ) {
        return Result.err(
          new NexusDisconnectedError(
            error.message,
            "E_CONN_CLOSED",
            error.context,
          ),
        );
      }
    }
    return result;
  }

  /** Release session-owned state before notifying service and proxy observers. */
  public onDisconnect(connectionId: string): void {
    this.resourceManager.cleanupConnection(connectionId);
    this.pendingCallManager.onDisconnect(connectionId);
    const listeners = this.disconnectListeners.get(connectionId);
    if (listeners) {
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch {
          // listener isolation
        }
      }
      this.disconnectListeners.delete(connectionId);
    }
    this.staleListeners.delete(connectionId);

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

  /** Mark all proxies on a session stale after an accepted identity update. */
  public onConnectionIdentityUpdated(connectionId: string): void {
    const listeners = this.staleListeners.get(connectionId);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        // listener isolation
      }
    }
    this.staleListeners.delete(connectionId);
  }
}
