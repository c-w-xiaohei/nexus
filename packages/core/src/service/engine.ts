import type { ConnectionManager } from "@/connection/connection-manager";
import type {
  MessageId,
  NexusMessage,
  ReleaseMessage,
  SerializedError,
} from "@/types/message";
import { NexusMessageType } from "@/types/message";
import type {
  AdapterModel,
  ConnectionMetaOf,
  ConnectionWhere,
  ContextMetaOf,
} from "@/types/adapter-model";
import type { CallTarget, MessageTarget } from "@/connection/types";
import { Logger } from "@/logger";
import { toSerializedError } from "@/utils/error";
import { CallProcessor } from "./call-processor";
import { MessageHandler } from "./message/message-handler";
import { PayloadProcessor } from "./payload/payload-processor";
import { PendingCallManager } from "./pending-call-manager";
import { CreateProxyOptions, ProxyFactory } from "./proxy-factory";
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
import { Result } from "better-result";
const { err, ok } = Result;
import type { NexusAuthorizationPolicy } from "@/api/types/config";

type DispatchCallBase = {
  target: CallTarget<any>;
  resourceId: string | null;
  path: (string | number)[];
  strategy?: "one" | "first" | "all" | "stream";
  timeout?: number;
  proxyOptions?: CreateProxyOptions<any>;
  invocationServiceName?: string;
};

type TargetStaleSubscription<M extends AdapterModel> = {
  readonly callback: () => void;
  readonly staleTarget?: {
    readonly where?: ConnectionWhere<M>;
  };
};

type DispatchGetCallOptions = DispatchCallBase & {
  type: "GET";
};

type DispatchSetCallOptions = DispatchCallBase & {
  type: "SET";
  value: any;
};

type DispatchApplyCallOptions = DispatchCallBase & {
  type: "APPLY";
  args: any[];
};

export type DispatchCallOptions =
  | DispatchGetCallOptions
  | DispatchSetCallOptions
  | DispatchApplyCallOptions;

export interface MessageHandlerCallbacks<M extends AdapterModel> {
  safeSendMessage(
    message: NexusMessage,
    target: MessageTarget<M> | string,
  ): Result<string[], Error>;
  handleResponse(
    id: MessageId,
    result: any,
    error: SerializedError | null,
    sourceConnectionId?: string,
    isTimeout?: boolean,
  ): void;
  canHandleResponse(id: MessageId, sourceConnectionId: string): boolean;
  dispatchRelease(resourceId: string, connectionId: string): void;
}

export class Engine<M extends AdapterModel> {
  private readonly logger = new Logger("L3 --- Engine");
  private readonly resourceManager: ResourceManager.Runtime;
  private readonly payloadProcessor: PayloadProcessor.Runtime<M>;
  private readonly proxyFactory: ProxyFactory<M>;
  private readonly messageHandler: MessageHandler.Runtime;
  private readonly pendingCallManager: PendingCallManager.Runtime;
  private readonly callProcessor: CallProcessor.Runtime;
  private readonly policy?: NexusAuthorizationPolicy<M>;

  private messageIdSeq = 1;
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
    this.policy = config.policy;
    this.resourceManager = ResourceManager.create();

    if (config.providers) {
      this.registerServices(config.providers);
    }

    this.proxyFactory = new ProxyFactory<M>(
      {
        safeDispatchCall: (options) => this.safeDispatchCall(options),
        dispatchRelease: (resourceId, connectionId) =>
          this.dispatchRelease(resourceId, connectionId),
      },
      this.resourceManager,
    );
    this.payloadProcessor = PayloadProcessor.create(
      this.resourceManager,
      this.proxyFactory,
    );
    this.pendingCallManager = PendingCallManager.create();
    this.messageHandler = MessageHandler.create({
      engine: {
        safeSendMessage: (message, target) =>
          this.safeSendMessage(message, target),
        handleResponse: (id, result, error, sourceConnectionId, isTimeout) =>
          this.handleResponse(id, result, error, sourceConnectionId, isTimeout),
        canHandleResponse: (id, sourceConnectionId) =>
          this.pendingCallManager.canHandleResponse(id, sourceConnectionId),
        dispatchRelease: (resourceId, connectionId) =>
          this.dispatchRelease(resourceId, connectionId),
      },
      resourceManager: this.resourceManager,
      payloadProcessor: this.payloadProcessor,
      policy: this.policy,
      getConnectionAuthContext: (connectionId) =>
        this.connectionManagerState.getConnectionAuthSnapshot(connectionId),
    });
    this.callProcessor = CallProcessor.create({
      nextMessageId: () => this.nextMessageId(),
      getReadyConnectionIds: (target) =>
        this.connectionManagerState.safeGetReadyConnectionIds(target),
      sendMessage: (target, message) =>
        this.connectionManagerState.safeSendMessage(target, message),
      payloadProcessor: this.payloadProcessor,
      pendingCallManager: this.pendingCallManager,
    });
  }

  private nextMessageId(): number {
    return this.messageIdSeq++;
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

  public safeDispatchCall(
    options: DispatchCallOptions,
  ): Promise<Result<any, globalThis.Error>> {
    return this.callProcessor.safeProcess(options);
  }

  public dispatchRelease(resourceId: string, connectionId: string): void {
    const message: ReleaseMessage = {
      type: NexusMessageType.RELEASE,
      id: null,
      resourceId,
    };
    this.safeSendMessage(message, { connectionId }).match({
      ok: () => undefined,
      err: (error) => {
        this.logger.warn(
          `Failed to dispatch release for resource #${resourceId} to ${connectionId}.`,
          error,
        );
      },
    });
  }

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
      .then((handled) =>
        handled.match({
          ok: () => ok(undefined),
          err: (error) => {
            this.logger.error(
              `CRITICAL - Unhandled error in message handler for type ${message.type}.`,
              error,
            );

            if (!message.id) {
              return ok(undefined);
            }

            const sendResult = this.safeSendMessage(
              {
                type: NexusMessageType.ERR,
                id: message.id,
                error: toSerializedError(error),
              },
              sourceConnectionId,
            );

            if (sendResult.isErr()) {
              this.logger.error(
                `Failed to send ERR response for message #${message.id}.`,
                sendResult.error,
              );
              return err(sendResult.error);
            }

            return ok(undefined);
          },
        }),
      );
  }

  public handleResponse(
    id: MessageId,
    result: any,
    error: SerializedError | null,
    sourceConnectionId?: string,
    isTimeout = false,
  ): void {
    this.pendingCallManager.handleResponse(
      id,
      result,
      error,
      sourceConnectionId,
      isTimeout,
    );
  }

  public safeSendMessage(
    message: NexusMessage,
    target: MessageTarget<M> | string,
  ): Result<string[], Error> {
    const messageTarget =
      typeof target === "string" ? { connectionId: target } : target;

    const sendResult = this.connectionManagerState.safeSendMessage(
      messageTarget,
      message,
    );

    if (sendResult.isErr()) {
      return err(sendResult.error);
    }

    return ok(sendResult.value);
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

    for (const service of this.resourceManager.listExposedServices()) {
      if (isServiceWithHooks(service)) {
        const onDisconnect = getServiceInvocationHook(
          service,
          SERVICE_ON_DISCONNECT,
        ) as ((connectionId: string) => void) | undefined;
        onDisconnect?.(connectionId);
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
