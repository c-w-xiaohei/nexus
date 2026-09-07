import type { MessageId, SerializedError } from "../types/message.js";
import { Logger } from "../logger.js";
import { RELEASE_PROXY_SYMBOL } from "../types/symbols.js";
import { Result } from "better-result";
import {
  NexusDisconnectedError,
  NexusCallTimeoutError,
} from "@/errors/call-errors";

const releaseQueuedResourceCapabilities = (
  values: readonly unknown[],
): void => {
  const visited = new WeakSet<object>();
  const visit = (nestedValue: unknown): void => {
    if (
      (typeof nestedValue !== "object" || nestedValue === null) &&
      typeof nestedValue !== "function"
    ) {
      return;
    }
    if (visited.has(nestedValue)) return;
    visited.add(nestedValue);

    const release = (nestedValue as { [RELEASE_PROXY_SYMBOL]?: unknown })[
      RELEASE_PROXY_SYMBOL
    ];
    if (typeof release === "function") {
      try {
        release();
      } catch {
        // Continue draining the queue when one release capability fails.
      }
      return;
    }

    if (Array.isArray(nestedValue)) {
      nestedValue.forEach(visit);
      return;
    }
    const prototype = Object.getPrototypeOf(nestedValue);
    if (prototype === Object.prototype || prototype === null) {
      Object.values(nestedValue).forEach(visit);
    }
  };

  values.forEach(visit);
};

/**
 * A helper to create an AsyncIterable and control it externally.
 * Kept class-based to follow JavaScript async iterator protocol ergonomically.
 */
class AsyncIteratorController<T> {
  private pullQueue: ((result: IteratorResult<T>) => void)[] = [];
  private pushQueue: IteratorResult<T>[] = [];
  private isFinished = false;
  private hasReturned = false;

  constructor(private readonly onReturn?: () => readonly unknown[]) {}

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

  public end(discardQueuedResults = false, buffered: readonly unknown[] = []) {
    if (discardQueuedResults) {
      releaseQueuedResourceCapabilities([
        ...buffered,
        ...this.pushQueue.map((result) => result.value),
      ]);
      this.pushQueue = [];
    }
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
      return: (): Promise<IteratorResult<T>> => {
        if (!this.hasReturned) {
          this.hasReturned = true;
          const buffered = this.onReturn?.() ?? [];
          this.end(true, buffered);
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
  export type BroadcastStrategy = "all" | "stream";

  type SettledResult =
    | { status: "fulfilled"; value: any }
    | { status: "rejected"; reason: any };

  interface PendingCallBase {
    readonly messageId: MessageId;
    readonly isBroadcast: boolean;
    readonly targetConnectionIds: readonly string[];
    readonly disconnectedConnectionIds: Set<string>;
    readonly resultsByConnectionId: Map<string, SettledResult>;
    readonly timeoutHandle: ReturnType<typeof setTimeout>;
  }

  interface CollectPendingCall extends PendingCallBase {
    readonly strategy: "all";
    readonly resolve: (
      value: Result<SettledResult[], globalThis.Error>,
    ) => void;
  }

  interface StreamPendingCall extends PendingCallBase {
    readonly strategy: "stream";
    readonly iteratorController: AsyncIteratorController<SettledResult>;
    nextResultIndex: number;
  }

  type PendingCall = CollectPendingCall | StreamPendingCall;

  export interface RegisterCallOptions {
    strategy: BroadcastStrategy;
    isBroadcast: boolean;
    sentConnectionIds: readonly string[];
    timeout: number;
  }

  export interface Runtime {
    /**
     * Registers before dispatch and settles through Result.
     * Unicast timeout/disconnect fails; multicast retains partial-result semantics.
     */
    register(
      messageId: MessageId,
      options: RegisterCallOptions & { strategy: "all" },
    ): Promise<Result<SettledResult[], globalThis.Error>>;
    /**
     * Creates an ordered stream. Early return stops reception and releases only
     * undelivered capabilities; normal completion keeps queued results readable.
     */
    register(
      messageId: MessageId,
      options: RegisterCallOptions & { strategy: "stream" },
    ): AsyncIterableIterator<SettledResult>;
    /**
     * Accepts one response per bound session.
     * Foreign, duplicate and disconnected senders cannot settle the call.
     */
    handleResponse(
      id: MessageId,
      result: any,
      error: SerializedError | null,
      sourceConnectionId?: string,
      isTimeout?: boolean,
    ): void;
    /** Checks eligibility before the message handler allocates remote resource facades. */
    canHandleResponse(id: MessageId, sourceConnectionId: string): boolean;
    onDisconnect(connectionId: string): void;
    /** Aborts local dispatch and releases received results that cannot reach the caller. */
    fail(messageId: MessageId, error: globalThis.Error): void;
  }

  export const create = (): Runtime => {
    const pendingCalls = new Map<MessageId, PendingCall>();
    const logger = new Logger("L3 --- PendingCallManager");

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

    /**
     * Removes reception state and its timer without discarding a finished
     * stream's readable queue. Cancellation owns that separate cleanup.
     */
    const finalizeCall = (messageId: MessageId): void => {
      const pending = pendingCalls.get(messageId);
      if (pending) clearTimeout(pending.timeoutHandle);
      pendingCalls.delete(messageId);
    };

    const isComplete = (pending: PendingCallBase): boolean =>
      pending.resultsByConnectionId.size +
        pending.disconnectedConnectionIds.size >=
      pending.targetConnectionIds.length;

    const orderedResults = (pending: PendingCallBase): SettledResult[] =>
      pending.targetConnectionIds.flatMap((connectionId) => {
        const result = pending.resultsByConnectionId.get(connectionId);
        return result ? [result] : [];
      });

    /**
     * Moves the contiguous ready prefix into the iterator.
     * A missing earlier response blocks later ones until disconnect or timeout.
     */
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
        // These results now belong to the iterator queue, not the ordering buffer.
        pending.nextResultIndex = pending.targetConnectionIds.length;
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

      if (isComplete(pending)) {
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
        logger.warn(`Call #${pending.messageId} timed out.`, {
          isBroadcast: pending.isBroadcast,
        });
        if (pending.isBroadcast) {
          pending.resolve(Result.ok(orderedResults(pending)));
        } else {
          pending.resolve(
            Result.err(
              new NexusCallTimeoutError(
                `Call #${pending.messageId} timed out after timeout.`,
                "E_CALL_TIMEOUT",
                { messageId: pending.messageId },
              ),
            ),
          );
        }
        finalizeCall(pending.messageId);
        return;
      }

      if (settledResult) {
        if (sourceConnectionId) {
          pending.resultsByConnectionId.set(sourceConnectionId, settledResult);
        }
      }

      if (isComplete(pending)) {
        logger.debug(`Call #${pending.messageId} fulfilled.`);
        pending.resolve(Result.ok(orderedResults(pending)));
        finalizeCall(pending.messageId);
      }
    };

    const isExpectedResponse = (
      pending: PendingCall,
      sourceConnectionId: string,
    ): boolean =>
      pending.targetConnectionIds.includes(sourceConnectionId) &&
      !pending.resultsByConnectionId.has(sourceConnectionId) &&
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

    function register(
      messageId: MessageId,
      options: RegisterCallOptions & { strategy: "all" },
    ): Promise<Result<SettledResult[], globalThis.Error>>;
    function register(
      messageId: MessageId,
      options: RegisterCallOptions & { strategy: "stream" },
    ): AsyncIterableIterator<SettledResult>;
    function register(
      messageId: MessageId,
      options: RegisterCallOptions,
    ):
      | Promise<Result<SettledResult[], globalThis.Error>>
      | AsyncIterableIterator<SettledResult> {
      const { strategy, isBroadcast, sentConnectionIds, timeout } = options;

      logger.debug(
        `Registering call #${messageId} with strategy '${strategy}'. Expecting ${sentConnectionIds.length} response(s).`,
        { isBroadcast, timeout },
      );

      if (strategy === "stream") {
        const controller = new AsyncIteratorController<any>(() => {
          // Iterator cancellation is local only; the remote invocation may continue.
          finalizeCall(messageId);
          return pendingCall.targetConnectionIds
            .slice(pendingCall.nextResultIndex)
            .flatMap((id) => {
              const result = pendingCall.resultsByConnectionId.get(id);
              return result ? [result] : [];
            });
        });
        const timeoutHandle = setTimeout(() => {
          handleResponse(messageId, null, null, undefined, true);
        }, timeout);
        const pendingCall: StreamPendingCall = {
          strategy,
          messageId,
          isBroadcast,
          targetConnectionIds: [...sentConnectionIds],
          disconnectedConnectionIds: new Set(),
          resultsByConnectionId: new Map(),
          iteratorController: controller,
          nextResultIndex: 0,
          timeoutHandle,
        };
        pendingCalls.set(messageId, pendingCall);
        return controller[Symbol.asyncIterator]();
      }

      let resolveCall!: (
        value: Result<SettledResult[], globalThis.Error>,
      ) => void;
      const promise = new Promise<Result<SettledResult[], globalThis.Error>>(
        (resolve) => {
          resolveCall = resolve;
        },
      );

      const timeoutHandle = setTimeout(() => {
        handleResponse(messageId, null, null, undefined, true);
      }, timeout);

      const pendingCall: CollectPendingCall = {
        strategy: "all",
        messageId,
        isBroadcast,
        targetConnectionIds: [...sentConnectionIds],
        disconnectedConnectionIds: new Set(),
        resultsByConnectionId: new Map(),
        resolve: resolveCall,
        timeoutHandle,
      };

      pendingCalls.set(messageId, pendingCall);
      return promise;
    }

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
            pending.resolve(
              Result.err(
                new NexusDisconnectedError(
                  `Call #${id} failed. The connection "${connectionId}" was closed.`,
                  "E_CONN_CLOSED",
                  { connectionId, messageId: id },
                ),
              ),
            );
          } else {
            pending.iteratorController.end();
          }
          logger.warn(`Rejected unicast call #${id} due to disconnect.`);
          finalizeCall(id);
          continue;
        }

        const alreadyResponded =
          pending.resultsByConnectionId.has(connectionId);
        if (!alreadyResponded) {
          pending.disconnectedConnectionIds.add(connectionId);
        }

        if (pending.strategy === "stream") {
          flushStreamResults(pending);
          if (isComplete(pending)) {
            logger.debug(
              `Stream call #${id} finished due to disconnect. Ending stream.`,
            );
            pending.iteratorController.end();
            finalizeCall(id);
          }
          continue;
        }

        if (isComplete(pending)) {
          logger.debug(
            `Broadcast call #${id} finished due to disconnect. Resolving with results.`,
          );
          if (pending.resultsByConnectionId.size === 0) {
            pending.resolve(
              Result.err(
                new NexusDisconnectedError(
                  `Broadcast call #${id} failed as all target connections were lost.`,
                  "E_CONN_CLOSED",
                  { messageId: id },
                ),
              ),
            );
            logger.warn(
              `Broadcast call #${id} failed. All targets disconnected.`,
            );
          } else {
            pending.resolve(Result.ok(orderedResults(pending)));
          }
          finalizeCall(id);
        }
      }
    };

    const fail = (messageId: MessageId, error: globalThis.Error): void => {
      const pending = pendingCalls.get(messageId);
      if (!pending) return;

      // Stop accepting responses before resource releases can reenter the transport.
      finalizeCall(messageId);
      if (pending.strategy === "all") {
        // Dispatch failed before the caller could receive any collected results.
        releaseQueuedResourceCapabilities([
          ...pending.resultsByConnectionId.values(),
        ]);
        pending.resolve(Result.err(error));
      } else {
        void pending.iteratorController[Symbol.asyncIterator]().return?.();
      }
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
