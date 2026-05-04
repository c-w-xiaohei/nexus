import type { ConnectionManager } from "@/connection/connection-manager";
import type {
  MessageId,
  NexusMessage,
  ReleaseMessage,
  SerializedError,
} from "@/types/message";
import { NexusMessageType } from "@/types/message";
import type { PlatformMetadata, UserMetadata } from "@/types/identity";
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
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import type { NexusAuthorizationPolicy } from "@/api/types/config";

type DispatchCallBase = {
  target: CallTarget<any, any>;
  resourceId: string | null;
  path: (string | number)[];
  strategy?: "one" | "first" | "all" | "stream";
  timeout?: number;
  proxyOptions?: CreateProxyOptions<any>;
  invocationServiceName?: string;
};

type TargetStaleSubscription<U extends UserMetadata> = {
  readonly callback: () => void;
  readonly staleTarget?: {
    readonly descriptor?: Partial<U>;
    readonly matcher?: (identity: U) => boolean;
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

export interface MessageHandlerCallbacks<U extends UserMetadata> {
  safeSendMessage(
    message: NexusMessage,
    target: MessageTarget<U> | string,
  ): Result<string[], Error>;
  handleResponse(
    id: MessageId,
    result: any,
    error: SerializedError | null,
    sourceConnectionId?: string,
    isTimeout?: boolean,
  ): void;
}

export class Engine<
  U extends UserMetadata,
  P extends PlatformMetadata,
> implements MessageHandlerCallbacks<U> {
  private readonly logger = new Logger("L3 --- Engine");
  private readonly resourceManager: ResourceManager.Runtime;
  private readonly payloadProcessor: PayloadProcessor.Runtime<U, P>;
  private readonly proxyFactory: ProxyFactory<U>;
  private readonly messageHandler: MessageHandler.Runtime;
  private readonly pendingCallManager: PendingCallManager.Runtime;
  private readonly callProcessor: CallProcessor.Runtime;
  private readonly policy?: NexusAuthorizationPolicy<U, P>;

  private messageIdSeq = 1;
  private readonly disconnectListeners = new Map<string, Set<() => void>>();
  private readonly targetStaleListeners = new Map<
    string,
    Set<TargetStaleSubscription<U>>
  >();

  constructor(
    private readonly connectionManagerState: ConnectionManager<U, P>,
    config: {
      services?: Record<
        string,
        { implementation: object; policy?: NexusAuthorizationPolicy<U, P> }
      >;
      policy?: NexusAuthorizationPolicy<U, P>;
    } = {},
  ) {
    this.policy = config.policy;
    this.resourceManager = ResourceManager.create();

    if (config.services) {
      this.registerServices(config.services);
    }

    this.proxyFactory = new ProxyFactory<U>(
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
      },
      resourceManager: this.resourceManager,
      payloadProcessor: this.payloadProcessor,
      policy: this.policy,
      getConnectionAuthContext: (connectionId) =>
        this.connectionManagerState.getConnectionAuthSnapshot(connectionId),
    });
    this.callProcessor = CallProcessor.create({
      nextMessageId: () => this.nextMessageId(),
      resolveConnection: (options) =>
        this.connectionManagerState.safeResolveConnection(options),
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
    options: CreateProxyOptions<U>,
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

      proxy[NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL] = (callback) => {
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
      };

      proxy[NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL] = (callback) => {
        let listeners = this.targetStaleListeners.get(connectionId);
        if (!listeners) {
          listeners = new Set();
          this.targetStaleListeners.set(connectionId, listeners);
        }

        const entry: TargetStaleSubscription<U> = {
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
      };
    }

    return proxy;
  }

  public registerServices(
    services: Record<
      string,
      { implementation: object; policy?: NexusAuthorizationPolicy<U, P> }
    >,
  ): void {
    const result = this.safeProvideServicesBatch(services);
    if (result.isErr()) {
      throw result.error;
    }
  }

  public safeProvideServicesBatch(
    services: Record<
      string,
      { implementation: object; policy?: NexusAuthorizationPolicy<U, P> }
    >,
  ): Result<void, Error> {
    return this.resourceManager.safeRegisterExposedServicesBatch(
      Object.entries(services).map(([name, registration]) => ({
        name,
        service: registration.implementation,
        policy: registration.policy,
      })),
    );
  }

  public safeDispatchCall(
    options: DispatchCallOptions,
  ): ResultAsync<any, globalThis.Error> {
    return this.callProcessor.safeProcess(options);
  }

  public dispatchRelease(resourceId: string, connectionId: string): void {
    const message: ReleaseMessage = {
      type: NexusMessageType.RELEASE,
      id: null,
      resourceId,
    };
    this.safeSendMessage(message, { connectionId }).match(
      () => undefined,
      (error) => {
        this.logger.warn(
          `Failed to dispatch release for resource #${resourceId} to ${connectionId}.`,
          error,
        );
      },
    );
  }

  public safeOnMessage(
    message: NexusMessage,
    sourceConnectionId: string,
  ): ResultAsync<void, globalThis.Error> {
    this.logger.debug(
      `<- Received message #${message.id ?? "N/A"} from connection ${sourceConnectionId}`,
      message,
    );

    return this.messageHandler
      .safeHandleMessage(message, sourceConnectionId)
      .orElse((error) => {
        this.logger.error(
          `CRITICAL - Unhandled error in message handler for type ${message.type}.`,
          error,
        );

        if (!message.id) {
          return okAsync(undefined);
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
          return errAsync(sendResult.error);
        }

        return okAsync(undefined);
      });
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
    target: MessageTarget<U> | string,
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
    newIdentity: U,
    oldIdentity: U,
  ): void {
    const listeners = this.targetStaleListeners.get(connectionId);
    if (!listeners) {
      return;
    }

    const staleEntries: TargetStaleSubscription<U>[] = [];

    for (const entry of Array.from(listeners)) {
      if (
        shouldMarkTargetStale({
          staleTarget: entry.staleTarget,
          newIdentity,
          oldIdentity,
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

function shouldMarkTargetStale<U extends UserMetadata>(input: {
  readonly staleTarget?: {
    readonly descriptor?: Partial<U>;
    readonly matcher?: (identity: U) => boolean;
  };
  readonly newIdentity: U;
  readonly oldIdentity: U;
}): boolean {
  const { staleTarget, newIdentity, oldIdentity } = input;

  if (!staleTarget) {
    return true;
  }

  const wasMatching = isIdentityMatchingTarget(oldIdentity, staleTarget);
  const isStillMatching = isIdentityMatchingTarget(newIdentity, staleTarget);

  return wasMatching && !isStillMatching;
}

function isIdentityMatchingTarget<U extends UserMetadata>(
  identity: U,
  target: {
    readonly descriptor?: Partial<U>;
    readonly matcher?: (identity: U) => boolean;
  },
): boolean {
  if (target.matcher && !target.matcher(identity)) {
    return false;
  }

  if (target.descriptor && !isDeepMatch(identity, target.descriptor)) {
    return false;
  }

  return true;
}

function isDeepMatch(target: any, source: any): boolean {
  if (target === source) {
    return true;
  }

  if (
    source === null ||
    typeof source !== "object" ||
    target === null ||
    typeof target !== "object"
  ) {
    return target === source;
  }

  for (const key of Object.keys(source)) {
    if (
      !Object.prototype.hasOwnProperty.call(target, key) ||
      !isDeepMatch(target[key], source[key])
    ) {
      return false;
    }
  }

  return true;
}
