import type { MessageId, SerializedError } from "@/types/message";
import { Logger } from "@/logger";
import { NexusCallTimeoutError, NexusDisconnectedError } from "@/errors";

/**
 * A helper class to create an AsyncIterable and control it from the outside.
 * @internal
 */
class AsyncIteratorController<T> {
  private pullQueue: ((result: IteratorResult<T>) => void)[] = [];
  private pushQueue: IteratorResult<T>[] = [];
  private isFinished = false;

  public push(value: T) {
    if (this.isFinished) return;
    const result: IteratorResult<T> = { done: false, value };
    if (this.pullQueue.length > 0) {
      this.pullQueue.shift()!(result);
    } else {
      this.pushQueue.push(result);
    }
  }

  public error(err: any) {
    if (this.isFinished) return;
    this.isFinished = true;
    const result: IteratorResult<T> = {
      done: false,
      value: Promise.reject(err) as any,
    };
    if (this.pullQueue.length > 0) {
      this.pullQueue.shift()!(result);
    } else {
      // If we push an error before anyone is listening, it will be unhandled.
      // This is a complex issue, for now we queue it.
      this.pushQueue.push(result);
    }
  }

  public end() {
    if (this.isFinished) return;
    this.isFinished = true;
    const result: IteratorResult<T> = { done: true, value: undefined };
    this.pullQueue.forEach((resolve) => resolve(result));
    this.pullQueue = [];
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.pushQueue.length > 0) {
          return Promise.resolve(this.pushQueue.shift()!);
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

export type BroadcastStrategy = "all" | "stream";

/** Represents the state of a call awaiting one or more responses. */
interface PendingCall {
  strategy: BroadcastStrategy;
  messageId: MessageId;
  isBroadcast: boolean;
  targetConnectionIds: string[]; // Track which connections are part of this call
  // For 'all' strategy
  resolve?: (value: any) => void;
  reject?: (reason?: any) => void;
  results?: (
    | { status: "fulfilled"; value: any; from: string }
    | { status: "rejected"; reason: any; from: string }
  )[];
  expectedResponses?: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  // For 'stream' strategy
  iteratorController?: AsyncIteratorController<any>;
  receivedResponses?: number;
}

export interface RegisterCallOptions {
  strategy: BroadcastStrategy;
  isBroadcast: boolean;
  sentConnectionIds: string[];
  timeout: number;
}

export class PendingCallManager {
  private readonly pendingCalls = new Map<MessageId, PendingCall>();
  private readonly logger = new Logger("L3 --- PendingCallManager");

  /**
   * Registers a new pending call and returns a Promise or AsyncIterable
   * that will be resolved/rejected when the response arrives.
   */
  public register(
    messageId: MessageId,
    options: RegisterCallOptions
  ): Promise<any> | AsyncIterable<any> {
    const { strategy, isBroadcast, sentConnectionIds, timeout } = options;

    this.logger.debug(
      `Registering call #${messageId} with strategy '${strategy}'. Expecting ${sentConnectionIds.length} response(s).`,
      { isBroadcast, timeout }
    );

    const pendingCall: PendingCall = {
      strategy,
      messageId,
      isBroadcast,
      targetConnectionIds: sentConnectionIds,
    };

    if (strategy === "stream") {
      const controller = new AsyncIteratorController<any>();
      pendingCall.iteratorController = controller;
      pendingCall.receivedResponses = 0;
      pendingCall.expectedResponses = sentConnectionIds.length;
      pendingCall.timeoutHandle = setTimeout(() => {
        this.handleResponse(messageId, null, null, undefined, true);
      }, timeout);
      this.pendingCalls.set(messageId, pendingCall);
      return controller[Symbol.asyncIterator]();
    }

    // 'all' strategy
    return new Promise((resolve, reject) => {
      pendingCall.resolve = resolve;
      pendingCall.reject = reject;
      pendingCall.results = [];
      pendingCall.expectedResponses = sentConnectionIds.length;
      pendingCall.timeoutHandle = setTimeout(() => {
        this.handleResponse(messageId, null, null, undefined, true);
      }, timeout);
      this.pendingCalls.set(messageId, pendingCall);
    });
  }

  /**
   * Handles a response (success or error) for a pending call.
   */
  public handleResponse(
    id: MessageId,
    result: any,
    error: SerializedError | null,
    sourceConnectionId?: string,
    isTimeout = false
  ): void {
    const pending = this.pendingCalls.get(id);
    if (!pending) {
      this.logger.debug(
        `Received response for call #${id}, but it was not pending. Ignoring.`
      );
      return;
    }

    this.logger.debug(
      `Handling response for call #${id}. From: ${
        sourceConnectionId ?? "internal"
      }, Timeout: ${isTimeout}`,
      { result, error }
    );

    if (pending.strategy === "stream") {
      if (isTimeout) {
        pending.iteratorController?.end();
        this.pendingCalls.delete(id);
        return;
      }

      // For stream, push a standard settlement object, just like 'all' strategy.
      // This ensures a consistent data structure for consumers of streams.
      if (error) {
        pending.iteratorController?.push({
          status: "rejected",
          reason: error,
          from: sourceConnectionId ?? "unknown",
        });
      } else {
        pending.iteratorController?.push({
          status: "fulfilled",
          value: result,
          from: sourceConnectionId ?? "unknown",
        });
      }

      // Check if we have received all expected responses
      pending.receivedResponses!++;
      if (pending.receivedResponses! >= pending.expectedResponses!) {
        clearTimeout(pending.timeoutHandle);
        pending.iteratorController?.end();
        this.pendingCalls.delete(id);
      }
      return;
    }

    // 'all' strategy
    if (pending.strategy === "all") {
      if (isTimeout) {
        clearTimeout(pending.timeoutHandle);
        this.logger.warn(`Call #${id} timed out.`, {
          isBroadcast: pending.isBroadcast,
        });
        // For broadcast, resolve with what we have. For a single-target call, reject.
        if (pending.isBroadcast) {
          pending.resolve!(pending.results);
        } else {
          pending.reject!(
            new NexusCallTimeoutError(
              `Call #${id} timed out after ${
                (pending.timeoutHandle as any)?._idleTimeout ?? "N/A"
              }ms.`,
              "E_CALL_TIMEOUT",
              { messageId: id }
            )
          );
        }
        this.pendingCalls.delete(id);
        return;
      }

      // Aggregate results for ALL calls, both single-target and broadcast.
      // This creates a consistent return format for the Engine to process.
      if (error) {
        pending.results!.push({
          status: "rejected",
          reason: error,
          from: sourceConnectionId ?? "unknown",
        });
      } else {
        pending.results!.push({
          status: "fulfilled",
          value: result,
          from: sourceConnectionId ?? "unknown",
        });
      }

      if (pending.results!.length >= pending.expectedResponses!) {
        clearTimeout(pending.timeoutHandle);
        this.logger.debug(
          `Call #${id} fulfilled. Got ${pending.results!.length} of ${pending.expectedResponses} expected responses.`
        );
        pending.resolve!(pending.results);
        this.pendingCalls.delete(id);
      }
    }
  }

  /**
   * Cleans up any pending calls related to a disconnected endpoint.
   */
  public onDisconnect(connectionId: string): void {
    this.logger.info(
      `Cleaning up pending calls for disconnected connection: ${connectionId}`
    );
    for (const [id, pending] of this.pendingCalls.entries()) {
      if (!pending.targetConnectionIds.includes(connectionId)) {
        continue;
      }

      this.logger.debug(
        `Found pending call #${id} affected by disconnect of ${connectionId}`
      );

      // If a single-target call, reject it immediately.
      if (!pending.isBroadcast) {
        clearTimeout(pending.timeoutHandle);
        pending.reject?.(
          new NexusDisconnectedError(
            `Call #${id} failed. The connection "${connectionId}" was closed.`,
            "E_CONN_CLOSED",
            { connectionId, messageId: id }
          )
        );
        this.logger.warn(`Rejected unicast call #${id} due to disconnect.`);
        this.pendingCalls.delete(id);
        continue;
      }

      // If a broadcast/stream call, decrement expected and check for completion.
      pending.expectedResponses = (pending.expectedResponses ?? 1) - 1;

      if (pending.strategy === "stream") {
        if (pending.receivedResponses! >= pending.expectedResponses!) {
          clearTimeout(pending.timeoutHandle);
          this.logger.debug(
            `Stream call #${id} finished due to disconnect. Ending stream.`
          );
          pending.iteratorController?.end();
          this.pendingCalls.delete(id);
        }
      } else if (pending.strategy === "all") {
        if (pending.results!.length >= pending.expectedResponses!) {
          clearTimeout(pending.timeoutHandle);
          this.logger.debug(
            `Broadcast call #${id} finished due to disconnect. Resolving with results.`
          );
          // If a broadcast resolves because all remaining connections disconnected
          // but we have no actual results, it should be a rejection.
          if (
            pending.results!.length === 0 &&
            pending.expectedResponses! <= 0
          ) {
            pending.reject?.(
              new NexusDisconnectedError(
                `Broadcast call #${id} failed as all target connections were lost.`,
                "E_CONN_CLOSED",
                { messageId: id }
              )
            );
            this.logger.warn(
              `Broadcast call #${id} failed. All targets disconnected.`
            );
          } else {
            pending.resolve?.(pending.results);
          }
          this.pendingCalls.delete(id);
        }
      }
    }
  }
}
