import type { MessageId, SerializedError } from "../types/message.js";
import { Logger } from "../logger.js";

/**
 * A helper to create an AsyncIterable and control it externally.
 * Kept class-based to follow JavaScript async iterator protocol ergonomically.
 */
class AsyncIteratorController<T> {
  private pullQueue: ((result: IteratorResult<T>) => void)[] = [];
  private pushQueue: IteratorResult<T>[] = [];
  private isFinished = false;
  private hasReturned = false;

  constructor(private readonly onReturn?: () => void) {}

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

  public end(discardQueuedResults = false) {
    if (this.isFinished) {
      return;
    }
    this.isFinished = true;
    if (discardQueuedResults) {
      this.pushQueue = [];
    }
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
      return: (): Promise<IteratorResult<T>> => {
        this.end(true);
        if (!this.hasReturned) {
          this.hasReturned = true;
          this.onReturn?.();
        }
        return Promise.resolve({ done: true, value: undefined });
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
    | { status: "fulfilled"; value: any }
    | { status: "rejected"; reason: any };

  interface PendingCallBase {
    readonly messageId: MessageId;
    readonly isBroadcast: boolean;
    readonly targetConnectionIds: string[];
    readonly respondedConnectionIds: Set<string>;
    readonly disconnectedConnectionIds: Set<string>;
    readonly resultsByConnectionId: Map<string, SettledResult>;
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
    nextResultIndex: number;
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
    canHandleResponse(id: MessageId, sourceConnectionId: string): boolean;
    onDisconnect(connectionId: string): void;
    fail(messageId: MessageId, error: globalThis.Error): void;
  }

  export const create = (): Runtime => {
    const pendingCalls = new Map<MessageId, PendingCall>();
    const logger = new Logger("L3 --- PendingCallManager");

    const rejectSafely = (
      pending: CollectPendingCall,
      error: globalThis.Error,
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
    ): SettledResult => {
      if (error) {
        return {
          status: "rejected",
          reason: error,
        };
      }

      return {
        status: "fulfilled",
        value: result,
      };
    };

    const finalizeCall = (messageId: MessageId): void => {
      pendingCalls.delete(messageId);
    };

    const orderedResults = (pending: PendingCallBase): SettledResult[] =>
      pending.targetConnectionIds.flatMap((connectionId) => {
        const result = pending.resultsByConnectionId.get(connectionId);
        return result ? [result] : [];
      });

    const flushStreamResults = (pending: StreamPendingCall): void => {
      while (pending.nextResultIndex < pending.targetConnectionIds.length) {
        const connectionId =
          pending.targetConnectionIds[pending.nextResultIndex];
        const nextResult = pending.resultsByConnectionId.get(connectionId);
        if (
          !nextResult &&
          !pending.disconnectedConnectionIds.has(connectionId)
        ) {
          break;
        }
        if (nextResult) pending.iteratorController.push(nextResult);
        pending.nextResultIndex += 1;
      }
    };

    const handleStreamResponse = (
      pending: StreamPendingCall,
      settledResult: SettledResult | null,
      isTimeout: boolean,
      sourceConnectionId?: string,
    ): void => {
      if (isTimeout) {
        for (
          let index = pending.nextResultIndex;
          index < pending.targetConnectionIds.length;
          index += 1
        ) {
          const result = pending.resultsByConnectionId.get(
            pending.targetConnectionIds[index],
          );
          if (result) {
            pending.iteratorController.push(result);
          }
        }
        pending.iteratorController.end();
        finalizeCall(pending.messageId);
        return;
      }

      if (settledResult) {
        if (sourceConnectionId) {
          pending.resultsByConnectionId.set(sourceConnectionId, settledResult);
        }
        flushStreamResults(pending);
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
      sourceConnectionId?: string,
    ): void => {
      if (isTimeout) {
        clearTimeout(pending.timeoutHandle);
        logger.warn(`Call #${pending.messageId} timed out.`, {
          isBroadcast: pending.isBroadcast,
        });
        if (pending.isBroadcast) {
          pending.resolve(orderedResults(pending));
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
        if (sourceConnectionId) {
          pending.resultsByConnectionId.set(sourceConnectionId, settledResult);
        }
      }

      if (pending.results.length >= pending.expectedResponses) {
        clearTimeout(pending.timeoutHandle);
        logger.debug(
          `Call #${pending.messageId} fulfilled. Got ${pending.results.length} of ${pending.expectedResponses} expected responses.`,
        );
        pending.resolve(orderedResults(pending));
        finalizeCall(pending.messageId);
      }
    };

    const isExpectedResponse = (
      pending: PendingCall,
      sourceConnectionId: string,
    ): boolean =>
      pending.targetConnectionIds.includes(sourceConnectionId) &&
      !pending.respondedConnectionIds.has(sourceConnectionId) &&
      !pending.disconnectedConnectionIds.has(sourceConnectionId);

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

      if (!isTimeout) {
        if (
          !sourceConnectionId ||
          !isExpectedResponse(pending, sourceConnectionId)
        ) {
          logger.warn(`Ignoring invalid response for call #${id}.`, {
            sourceConnectionId,
          });
          return;
        }

        pending.respondedConnectionIds.add(sourceConnectionId);
      }

      logger.debug(
        `Handling response for call #${id}. From: ${
          sourceConnectionId ?? "internal"
        }, Timeout: ${isTimeout}`,
        { result, error },
      );

      const settledResult =
        isTimeout && error === null ? null : createSettledResult(result, error);

      switch (pending.strategy) {
        case "stream":
          handleStreamResponse(
            pending,
            settledResult,
            isTimeout,
            sourceConnectionId,
          );
          break;
        case "all":
          handleCollectResponse(
            pending,
            settledResult,
            isTimeout,
            sourceConnectionId,
          );
          break;
      }
    };

    const canHandleResponse = (
      id: MessageId,
      sourceConnectionId: string,
    ): boolean => {
      const pending = pendingCalls.get(id);
      return (
        pending !== undefined && isExpectedResponse(pending, sourceConnectionId)
      );
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
        const controller = new AsyncIteratorController<any>(() => {
          // Iterator cancellation is local only; the remote invocation may continue.
          clearTimeout(timeoutHandle);
          finalizeCall(messageId);
        });
        const timeoutHandle = setTimeout(() => {
          handleResponse(messageId, null, null, undefined, true);
        }, timeout);
        const pendingCall: StreamPendingCall = {
          strategy,
          messageId,
          isBroadcast,
          targetConnectionIds: sentConnectionIds,
          respondedConnectionIds: new Set(),
          disconnectedConnectionIds: new Set(),
          resultsByConnectionId: new Map(),
          iteratorController: controller,
          receivedResponses: 0,
          nextResultIndex: 0,
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
        respondedConnectionIds: new Set(),
        disconnectedConnectionIds: new Set(),
        resultsByConnectionId: new Map(),
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

        const alreadyResponded =
          pending.respondedConnectionIds.has(connectionId);
        if (!alreadyResponded) {
          pending.expectedResponses -= 1;
          pending.disconnectedConnectionIds.add(connectionId);
        }

        if (pending.strategy === "stream") {
          flushStreamResults(pending);
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
            pending.resolve(orderedResults(pending));
          }
          pendingCalls.delete(id);
        }
      }
    };

    const fail = (messageId: MessageId, error: globalThis.Error): void => {
      const pending = pendingCalls.get(messageId);
      if (!pending) return;

      clearTimeout(pending.timeoutHandle);
      if (pending.strategy === "all") {
        rejectSafely(pending, error);
      } else {
        pending.iteratorController.end();
      }
      finalizeCall(messageId);
    };

    return {
      register,
      handleResponse,
      canHandleResponse,
      onDisconnect,
      fail,
    };
  };
}
