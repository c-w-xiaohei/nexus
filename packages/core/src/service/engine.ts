import type { ConnectionManager } from "@/connection/connection-manager";
import type { NexusMessage, ReleaseMessage } from "@/types/message";
import { NexusMessageType } from "@/types/message";
import type {
  AdapterModel,
  ConnectionMetaOf,
  ConnectionWhere,
  ContextMetaOf,
} from "@/types/adapter-model";
import { NexusDisconnectedError } from "@/errors/call-errors";
import { Logger } from "@/logger";
import { CallProcessor, type DispatchCallOptions } from "./call-processor";
import { MessageHandler } from "./message/message-handler";
import { PayloadProcessor } from "./payload/payload-processor";
import { PendingCallManager } from "./pending-call-manager";
import { type CreateProxyOptions, ProxyFactory } from "./proxy-factory";
import { ResourceManager } from "./resource-manager";
import {
  getServiceInvocationHook,
  isServiceWithHooks,
  SERVICE_ON_DISCONNECT,
} from "./service-invocation-hooks";
import {
  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
} from "@/types/symbols";
import { installProxyLifecycle } from "./proxy-lifecycle";
import { Result } from "better-result";
const { err, ok } = Result;
import type { NexusAuthorizationPolicy } from "@/api/types/config";

type TargetStaleSubscription<M extends AdapterModel> = {
  readonly callback: () => void;
  readonly staleTarget?: {
    readonly where?: ConnectionWhere<M>;
  };
};

export class Engine<M extends AdapterModel> {
  private readonly logger = new Logger("L3 --- Engine");
  private readonly resourceManager: ResourceManager;
  private readonly payloadProcessor: PayloadProcessor;
  private readonly proxyFactory: ProxyFactory;
  private readonly messageHandler: MessageHandler<M>;
  private readonly pendingCallManager: PendingCallManager;
  private readonly callProcessor: CallProcessor;

  private readonly disconnectListeners = new Map<string, Set<() => void>>();
  private readonly targetStaleListeners = new Map<
    string,
    Set<TargetStaleSubscription<M>>
  >();

  constructor(
    private readonly connectionManagerState: ConnectionManager<M>,
    config: {
      providers?: Record<
        string,
        { service: object; policy?: NexusAuthorizationPolicy<M> }
      >;
      policy?: NexusAuthorizationPolicy<M>;
    } = {},
  ) {
    this.resourceManager = new ResourceManager();

    if (config.providers) {
      this.registerServices(config.providers);
    }

    this.proxyFactory = new ProxyFactory(this, this.resourceManager);
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
      getReadyConnectionIds: (target) =>
        this.connectionManagerState.safeGetReadyConnectionIds(target),
      sendMessage: (message, connectionId) =>
        this.safeSendMessage(message, connectionId),
      payloadProcessor: this.payloadProcessor,
      pendingCallManager: this.pendingCallManager,
    });
  }

  public createServiceProxy<T extends object>(
    serviceName: string,
    options: CreateProxyOptions<M>,
  ): T {
    const proxy = this.proxyFactory.createServiceProxy(
      serviceName,
      options,
    ) as T & {
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]?: (
        callback: () => void,
      ) => () => void;
      [NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL]?: (
        callback: () => void,
      ) => () => void;
    };

    if ("connectionId" in options.target) {
      const connectionId = options.target.connectionId;

      Object.defineProperty(
        proxy,
        NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
        {
          configurable: true,
          value: (callback: () => void) => {
            let listeners = this.disconnectListeners.get(connectionId);
            if (!listeners) {
              listeners = new Set();
              this.disconnectListeners.set(connectionId, listeners);
            }

            listeners.add(callback);
            return () => {
              const current = this.disconnectListeners.get(connectionId);
              if (!current) {
                return;
              }

              current.delete(callback);
              if (current.size === 0) {
                this.disconnectListeners.delete(connectionId);
              }
            };
          },
        },
      );

      Object.defineProperty(
        proxy,
        NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
        {
          configurable: true,
          value: (callback: () => void) => {
            let listeners = this.targetStaleListeners.get(connectionId);
            if (!listeners) {
              listeners = new Set();
              this.targetStaleListeners.set(connectionId, listeners);
            }

            const entry: TargetStaleSubscription<M> = {
              callback,
              staleTarget: options.staleTarget,
            };
            listeners.add(entry);
            return () => {
              const current = this.targetStaleListeners.get(connectionId);
              if (!current) {
                return;
              }

              current.delete(entry);
              if (current.size === 0) {
                this.targetStaleListeners.delete(connectionId);
              }
            };
          },
        },
      );
      installProxyLifecycle(proxy, serviceName, connectionId);
    }

    return proxy;
  }

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
  ): Promise<Result<any, globalThis.Error>> {
    return this.callProcessor.safeProcess(options);
  }

  /** Best-effort notification after local release; logs send failure without waiting for a remote ACK. */
  public dispatchRelease(resourceId: string, connectionId: string): void {
    const message: ReleaseMessage = {
      type: NexusMessageType.RELEASE,
      id: null,
      resourceId,
    };
    this.safeSendMessage(message, connectionId).match({
      ok: () => undefined,
      err: (error) => {
        this.logger.warn(
          `Failed to dispatch release for resource #${resourceId} to ${connectionId}.`,
          error,
        );
      },
    });
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
   * Success means local acceptance, not remote execution; empty/other recipients fail.
   */
  public safeSendMessage(
    message: NexusMessage,
    connectionId: string,
  ): Result<void, Error> {
    const sendResult = this.connectionManagerState.safeSendMessage(
      { connectionId },
      message,
    );

    if (sendResult.isErr()) {
      const error = sendResult.error;
      return err(
        error.code === "E_CONN_CLOSED" &&
          !(error instanceof NexusDisconnectedError)
          ? new NexusDisconnectedError(
              error.message,
              "E_CONN_CLOSED",
              error.context,
            )
          : error,
      );
    }

    return sendResult.value.length === 1 && sendResult.value[0] === connectionId
      ? ok(undefined)
      : err(
          new NexusDisconnectedError(
            "Connection did not accept the message.",
            "E_CONN_CLOSED",
            { connectionId, messageId: message.id },
          ),
        );
  }

  public onDisconnect(connectionId: string): void {
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
    this.targetStaleListeners.delete(connectionId);

    for (const service of this.resourceManager.listExposedServices()) {
      if (isServiceWithHooks(service)) {
        const onDisconnect = getServiceInvocationHook(
          service,
          SERVICE_ON_DISCONNECT,
        ) as ((connectionId: string) => void) | undefined;
        try {
          onDisconnect?.(connectionId);
        } catch (error) {
          this.logger.error("Exposed service disconnect hook failed.", error);
        }
      }
    }

    this.resourceManager.cleanupConnection(connectionId);
    this.pendingCallManager.onDisconnect(connectionId);
  }

  public onConnectionTargetStale(
    connectionId: string,
    newIdentity: ContextMetaOf<M>,
    oldIdentity: ContextMetaOf<M>,
    connectionMeta: ConnectionMetaOf<M>,
  ): void {
    const listeners = this.targetStaleListeners.get(connectionId);
    if (!listeners) {
      return;
    }

    const staleEntries: TargetStaleSubscription<M>[] = [];

    for (const entry of Array.from(listeners)) {
      try {
        if (
          shouldMarkTargetStale({
            staleTarget: entry.staleTarget,
            newIdentity,
            oldIdentity,
            connectionMeta,
          })
        ) {
          staleEntries.push(entry);
        }
      } catch (error) {
        this.logger.error("Stale target predicate failed.", error);
      }
    }

    for (const entry of staleEntries) {
      try {
        entry.callback();
      } catch {
        // listener isolation
      }
      listeners.delete(entry);
    }

    if (listeners.size === 0) {
      this.targetStaleListeners.delete(connectionId);
    }
  }
}

function shouldMarkTargetStale<M extends AdapterModel>(input: {
  readonly staleTarget?: {
    readonly where?: ConnectionWhere<M>;
  };
  readonly newIdentity: ContextMetaOf<M>;
  readonly oldIdentity: ContextMetaOf<M>;
  readonly connectionMeta: ConnectionMetaOf<M>;
}): boolean {
  const { staleTarget, newIdentity, oldIdentity, connectionMeta } = input;

  if (!staleTarget) {
    return true;
  }

  return (
    (staleTarget.where?.(oldIdentity, connectionMeta) ?? true) &&
    !(staleTarget.where?.(newIdentity, connectionMeta) ?? true)
  );
}
