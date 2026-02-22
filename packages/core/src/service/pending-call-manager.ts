import type { MessageId, SerializedError } from "@/types/message";
import { Logger } from "@/logger";

/**
 * A helper to create an AsyncIterable and control it externally.
 * Kept class-based to follow JavaScript async iterator protocol ergonomically.
 */
class AsyncIteratorController<T> {
  private pullQueue: ((result: IteratorResult<T>) => void)[] = [];
  private pushQueue: IteratorResult<T>[] = [];
  private isFinished = false;

  public push(value: T) {
    if (this.isFinished) {
      return;
    }
    const result: IteratorResult<T> = { done: false, value };
    if (this.pullQueue.length > 0) {
      const nextResolve = this.pullQueue.shift();
      if (nextResolve) {
        nextResolve(result);
      }
      return;
    }
    this.pushQueue.push(result);
  }

  public end() {
    if (this.isFinished) {
      return;
    }
    this.isFinished = true;
    const result: IteratorResult<T> = { done: true, value: undefined };
    this.pullQueue.forEach((resolve) => resolve(result));
    this.pullQueue = [];
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.pushQueue.length > 0) {
          const queuedResult = this.pushQueue.shift();
          if (queuedResult) {
            return Promise.resolve(queuedResult);
          }
        }
        if (this.isFinished) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => {
          this.pullQueue.push(resolve);
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

export namespace PendingCallManager {
  type ErrorCode = "E_CALL_TIMEOUT" | "E_CONN_CLOSED";

  type ErrorOptions = {
    readonly context?: Record<string, unknown>;
  };

  class BaseError extends globalThis.Error {
    readonly code: ErrorCode;
    readonly context?: Record<string, unknown>;

    constructor(message: string, code: ErrorCode, options: ErrorOptions = {}) {
      super(message);
      this.name = "PendingCallManagerError";
      this.code = code;
      this.context = options.context;
    }
  }

  class TimeoutError extends BaseError {
    constructor(message: string, options: ErrorOptions = {}) {
      super(message, "E_CALL_TIMEOUT", options);
      this.name = "PendingCallTimeoutError";
    }
  }

  class DisconnectedError extends BaseError {
    constructor(message: string, options: ErrorOptions = {}) {
      super(message, "E_CONN_CLOSED", options);
      this.name = "PendingCallDisconnectedError";
    }
  }

  export const Error = {
    Base: BaseError,
    Timeout: TimeoutError,
    Disconnected: DisconnectedError,
  } as const;

  export type BroadcastStrategy = "all" | "stream";

  type SettledResult =
    | { status: "fulfilled"; value: any; from: string }
    | { status: "rejected"; reason: any; from: string };

  interface PendingCallBase {
    readonly messageId: MessageId;
    readonly isBroadcast: boolean;
    readonly targetConnectionIds: string[];
    expectedResponses: number;
    readonly timeoutHandle: ReturnType<typeof setTimeout>;
  }

  interface CollectPendingCall extends PendingCallBase {
    readonly strategy: "all";
    readonly resolve: (value: SettledResult[]) => void;
    readonly reject: (reason?: any) => void;
    readonly promise: Promise<SettledResult[]>;
    readonly results: SettledResult[];
  }

  interface StreamPendingCall extends PendingCallBase {
    readonly strategy: "stream";
    readonly iteratorController: AsyncIteratorController<SettledResult>;
    receivedResponses: number;
  }

  type PendingCall = CollectPendingCall | StreamPendingCall;

  export interface RegisterCallOptions {
    strategy: BroadcastStrategy;
    isBroadcast: boolean;
    sentConnectionIds: string[];
    timeout: number;
  }

  export interface Runtime {
    register(
      messageId: MessageId,
      options: RegisterCallOptions,
    ): Promise<any> | AsyncIterable<any>;
    handleResponse(
      id: MessageId,
      result: any,
      error: SerializedError | null,
      sourceConnectionId?: string,
      isTimeout?: boolean,
    ): void;
    onDisconnect(connectionId: string): void;
  }

  export const create = (): Runtime => {
    const pendingCalls = new Map<MessageId, PendingCall>();
    const logger = new Logger("L3 --- PendingCallManager");

    const rejectSafely = (
      pending: CollectPendingCall,
      error: InstanceType<typeof Error.Base>,
    ): void => {
      pending.promise.catch((promiseError) => {
        logger.error(
          `Unhandled pending call rejection for #${pending.messageId}.`,
          promiseError,
        );
      });
      pending.reject(error);
    };

    const createSettledResult = (
      result: any,
      error: SerializedError | null,
      sourceConnectionId?: string,
    ): SettledResult => {
      if (error) {
        return {
          status: "rejected",
          reason: error,
          from: sourceConnectionId ?? "unknown",
        };
      }

      return {
        status: "fulfilled",
        value: result,
        from: sourceConnectionId ?? "unknown",
      };
    };

    const finalizeCall = (messageId: MessageId): void => {
      pendingCalls.delete(messageId);
    };

    const handleStreamResponse = (
      pending: StreamPendingCall,
      settledResult: SettledResult | null,
      isTimeout: boolean,
    ): void => {
      if (isTimeout) {
        pending.iteratorController.end();
        finalizeCall(pending.messageId);
        return;
      }

      if (settledResult) {
        pending.iteratorController.push(settledResult);
      }

      pending.receivedResponses += 1;
      if (pending.receivedResponses >= pending.expectedResponses) {
        clearTimeout(pending.timeoutHandle);
        pending.iteratorController.end();
        finalizeCall(pending.messageId);
      }
    };

    const handleCollectResponse = (
      pending: CollectPendingCall,
      settledResult: SettledResult | null,
      isTimeout: boolean,
    ): void => {
      if (isTimeout) {
        clearTimeout(pending.timeoutHandle);
        logger.warn(`Call #${pending.messageId} timed out.`, {
          isBroadcast: pending.isBroadcast,
        });
        if (pending.isBroadcast) {
          pending.resolve(pending.results);
        } else {
          rejectSafely(
            pending,
            new Error.Timeout(
              `Call #${pending.messageId} timed out after timeout.`,
              {
                context: { messageId: pending.messageId },
              },
            ),
          );
        }
        finalizeCall(pending.messageId);
        return;
      }

      if (settledResult) {
        pending.results.push(settledResult);
      }

      if (pending.results.length >= pending.expectedResponses) {
        clearTimeout(pending.timeoutHandle);
        logger.debug(
          `Call #${pending.messageId} fulfilled. Got ${pending.results.length} of ${pending.expectedResponses} expected responses.`,
        );
        pending.resolve(pending.results);
        finalizeCall(pending.messageId);
      }
    };

    const handleResponse = (
      id: MessageId,
      result: any,
      error: SerializedError | null,
      sourceConnectionId?: string,
      isTimeout = false,
    ): void => {
      const pending = pendingCalls.get(id);
      if (!pending) {
        logger.debug(
          `Received response for call #${id}, but it was not pending. Ignoring.`,
        );
        return;
      }

      logger.debug(
        `Handling response for call #${id}. From: ${
          sourceConnectionId ?? "internal"
        }, Timeout: ${isTimeout}`,
        { result, error },
      );

      const settledResult =
        isTimeout && error === null
          ? null
          : createSettledResult(result, error, sourceConnectionId);

      switch (pending.strategy) {
        case "stream":
          handleStreamResponse(pending, settledResult, isTimeout);
          break;
        case "all":
          handleCollectResponse(pending, settledResult, isTimeout);
          break;
      }
    };

    const register = (
      messageId: MessageId,
      options: RegisterCallOptions,
    ): Promise<any> | AsyncIterable<any> => {
      const { strategy, isBroadcast, sentConnectionIds, timeout } = options;

      logger.debug(
        `Registering call #${messageId} with strategy '${strategy}'. Expecting ${sentConnectionIds.length} response(s).`,
        { isBroadcast, timeout },
      );

      if (strategy === "stream") {
        const controller = new AsyncIteratorController<any>();
        const timeoutHandle = setTimeout(() => {
          handleResponse(messageId, null, null, undefined, true);
        }, timeout);
        const pendingCall: StreamPendingCall = {
          strategy,
          messageId,
          isBroadcast,
          targetConnectionIds: sentConnectionIds,
          iteratorController: controller,
          receivedResponses: 0,
          expectedResponses: sentConnectionIds.length,
          timeoutHandle,
        };
        pendingCalls.set(messageId, pendingCall);
        return controller[Symbol.asyncIterator]();
      }

      let resolveCall!: (value: SettledResult[]) => void;
      let rejectCall!: (reason?: any) => void;
      const promise: Promise<SettledResult[]> = new Promise(
        (resolve, reject) => {
          resolveCall = resolve;
          rejectCall = reject;
        },
      );

      const timeoutHandle = setTimeout(() => {
        handleResponse(messageId, null, null, undefined, true);
      }, timeout);

      const pendingCall: CollectPendingCall = {
        strategy: "all",
        messageId,
        isBroadcast,
        targetConnectionIds: sentConnectionIds,
        resolve: resolveCall,
        reject: rejectCall,
        promise,
        results: [],
        expectedResponses: sentConnectionIds.length,
        timeoutHandle,
      };

      pendingCalls.set(messageId, pendingCall);
      return promise;
    };

    const onDisconnect = (connectionId: string): void => {
      logger.info(
        `Cleaning up pending calls for disconnected connection: ${connectionId}`,
      );

      for (const [id, pending] of pendingCalls.entries()) {
        if (!pending.targetConnectionIds.includes(connectionId)) {
          continue;
        }

        logger.debug(
          `Found pending call #${id} affected by disconnect of ${connectionId}`,
        );

        if (!pending.isBroadcast) {
          if (pending.strategy === "all") {
            clearTimeout(pending.timeoutHandle);
            rejectSafely(
              pending,
              new Error.Disconnected(
                `Call #${id} failed. The connection "${connectionId}" was closed.`,
                { context: { connectionId, messageId: id } },
              ),
            );
          } else {
            clearTimeout(pending.timeoutHandle);
            pending.iteratorController.end();
          }
          logger.warn(`Rejected unicast call #${id} due to disconnect.`);
          pendingCalls.delete(id);
          continue;
        }

        pending.expectedResponses -= 1;

        if (pending.strategy === "stream") {
          if (pending.receivedResponses >= pending.expectedResponses) {
            clearTimeout(pending.timeoutHandle);
            logger.debug(
              `Stream call #${id} finished due to disconnect. Ending stream.`,
            );
            pending.iteratorController.end();
            pendingCalls.delete(id);
          }
          continue;
        }

        if (pending.results.length >= pending.expectedResponses) {
          clearTimeout(pending.timeoutHandle);
          logger.debug(
            `Broadcast call #${id} finished due to disconnect. Resolving with results.`,
          );
          if (pending.results.length === 0 && pending.expectedResponses <= 0) {
            rejectSafely(
              pending,
              new Error.Disconnected(
                `Broadcast call #${id} failed as all target connections were lost.`,
                { context: { messageId: id } },
              ),
            );
            logger.warn(
              `Broadcast call #${id} failed. All targets disconnected.`,
            );
          } else {
            pending.resolve(pending.results);
          }
          pendingCalls.delete(id);
        }
      }
    };

    return {
      register,
      handleResponse,
      onDisconnect,
    };
  };
}
