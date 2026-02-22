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
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";

type DispatchCallBase = {
  target: CallTarget<any, any>;
  resourceId: string | null;
  path: (string | number)[];
  strategy?: "one" | "first" | "all" | "stream";
  timeout?: number;
  proxyOptions?: CreateProxyOptions<any>;
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

  private messageIdSeq = 1;

  constructor(
    private readonly connectionManagerState: ConnectionManager<U, P>,
    config: { services?: Record<string, object> } = {},
  ) {
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
    return this.proxyFactory.createServiceProxy(serviceName, options);
  }

  public registerServices(services: Record<string, object>): void {
    for (const [name, service] of Object.entries(services)) {
      this.resourceManager.registerExposedService(name, service);
    }
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
    this.resourceManager.cleanupConnection(connectionId);
    this.pendingCallManager.onDisconnect(connectionId);
  }
}
