import type { MessageId, SerializedError } from "@/types/message";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { Result } from "better-result";
import {
  NexusDisconnectedError,
  NexusCallTimeoutError,
} from "@/errors/call-errors";

type SettledResult = PromiseSettledResult<any>;
type RegisterOptions = {
  strategy: "all" | "stream";
  isBroadcast: boolean;
  sentConnectionIds: readonly string[];
  timeout: number;
};
type PendingCall = {
  messageId: MessageId;
  isBroadcast: boolean;
  targetConnectionIds: readonly string[];
  disconnected: Set<string>;
  results: Map<string, SettledResult>;
  timer: ReturnType<typeof setTimeout>;
} & (
  | {
      strategy: "all";
      resolve: (result: Result<SettledResult[], Error>) => void;
    }
  | {
      strategy: "stream";
      stream: ResultStream<SettledResult>;
      nextIndex: number;
    }
);

/** Owns pending consumers and timers; session-bound responses are accepted at most once. */
export class PendingCallManager {
  private readonly calls = new Map<MessageId, PendingCall>();

  /** Registers before dispatch. Collect failures use Result; multicast can settle partial results. */
  public register(
    id: MessageId,
    options: RegisterOptions & { strategy: "all" },
  ): Promise<Result<SettledResult[], Error>>;
  /** Normal completion keeps queued results readable; early return releases undelivered capabilities. */
  public register(
    id: MessageId,
    options: RegisterOptions & { strategy: "stream" },
  ): AsyncIterableIterator<SettledResult>;
  public register(
    id: MessageId,
    options: RegisterOptions,
  ):
    | Promise<Result<SettledResult[], Error>>
    | AsyncIterableIterator<SettledResult> {
    const base = {
      messageId: id,
      isBroadcast: options.isBroadcast,
      targetConnectionIds: [...options.sentConnectionIds],
      disconnected: new Set<string>(),
      results: new Map<string, SettledResult>(),
      timer: setTimeout(() => this.onTimeout(id), options.timeout),
    };
    if (options.strategy === "stream") {
      const stream = new ResultStream<SettledResult>((): readonly unknown[] => {
        // Cancellation is local; remote code may continue, so later replies become orphans.
        this.finalize(pending);
        return orderedResults(pending, pending.nextIndex);
      });
      const pending = {
        ...base,
        strategy: "stream" as const,
        stream,
        nextIndex: 0,
      };
      this.calls.set(id, pending);
      return stream;
    }
    return new Promise((resolve) => {
      this.calls.set(id, { ...base, strategy: "all", resolve });
    });
  }

  /** Checks eligibility before MessageHandler revives remote facades. */
  public canHandleResponse(id: MessageId, source: string): boolean {
    const pending = this.calls.get(id);
    return (
      !!pending &&
      pending.targetConnectionIds.includes(source) &&
      !pending.results.has(source) &&
      !pending.disconnected.has(source)
    );
  }

  public handleResponse(
    id: MessageId,
    value: any,
    error: SerializedError | null,
    source: string,
  ): void {
    if (!this.canHandleResponse(id, source)) return;
    const pending = this.calls.get(id)!;
    pending.results.set(
      source,
      error
        ? { status: "rejected", reason: error }
        : { status: "fulfilled", value },
    );
    this.settleReady(pending);
  }

  /** Disconnect does not overwrite a response already received from that session. */
  public onDisconnect(connectionId: string): void {
    for (const pending of this.calls.values()) {
      if (!pending.targetConnectionIds.includes(connectionId)) continue;
      if (!pending.isBroadcast) {
        this.finish(
          pending,
          new NexusDisconnectedError(
            `Call #${pending.messageId} failed. The connection "${connectionId}" was closed.`,
            "E_CONN_CLOSED",
            { connectionId, messageId: pending.messageId },
          ),
        );
        continue;
      }
      if (!pending.results.has(connectionId))
        pending.disconnected.add(connectionId);
      this.settleReady(pending);
    }
  }

  /** Aborts dispatch before its result reaches the caller and releases already received capabilities. */
  public fail(id: MessageId, error: Error): void {
    const pending = this.calls.get(id);
    if (!pending) return;
    this.finalize(pending); // Stop reception before release callbacks can reenter the transport.
    if (pending.strategy === "stream") void pending.stream.return();
    else {
      releaseCapabilities([...pending.results.values()]);
      pending.resolve(Result.err(error));
    }
  }

  /** Flushes the contiguous ready prefix; missing earlier responses block later ones. */
  private settleReady(pending: PendingCall): void {
    if (pending.strategy === "stream") {
      while (pending.nextIndex < pending.targetConnectionIds.length) {
        const id = pending.targetConnectionIds[pending.nextIndex];
        const result = pending.results.get(id);
        if (!result && !pending.disconnected.has(id)) break;
        if (result) pending.stream.push(result);
        pending.nextIndex++;
      }
    }
    if (
      pending.results.size + pending.disconnected.size <
      pending.targetConnectionIds.length
    )
      return;
    // Empty collect after losing every recipient is an error; an empty stream just ends.
    const error =
      pending.results.size === 0
        ? new NexusDisconnectedError(
            `Broadcast call #${pending.messageId} failed as all target connections were lost.`,
            "E_CONN_CLOSED",
            { messageId: pending.messageId },
          )
        : undefined;
    this.finish(pending, error);
  }

  private onTimeout(id: MessageId): void {
    const pending = this.calls.get(id);
    if (!pending) return;
    if (pending.strategy === "stream") {
      for (const result of orderedResults(pending, pending.nextIndex))
        pending.stream.push(result);
      // Ownership moved to the queue: cancellation must not release values already consumed.
      pending.nextIndex = pending.targetConnectionIds.length;
    }
    this.finish(
      pending,
      pending.isBroadcast
        ? undefined
        : new NexusCallTimeoutError(
            `Call #${id} timed out after timeout.`,
            "E_CALL_TIMEOUT",
            { messageId: id },
          ),
    );
  }

  /** Ends reception without discarding a normally completed stream's readable queue. */
  private finish(pending: PendingCall, error?: Error): void {
    this.finalize(pending);
    if (pending.strategy === "stream") pending.stream.end();
    else
      pending.resolve(
        error ? Result.err(error) : Result.ok(orderedResults(pending)),
      );
  }

  private finalize(pending: PendingCall): void {
    clearTimeout(pending.timer);
    this.calls.delete(pending.messageId);
  }
}

/** The controller is the iterator itself; next/return no longer allocate wrapper objects. */
class ResultStream<T> implements AsyncIterableIterator<T> {
  private readonly pulls: ((result: IteratorResult<T>) => void)[] = [];
  private readonly queue: T[] = [];
  private finished = false;
  private returned = false;

  constructor(private readonly onReturn: () => readonly unknown[]) {}

  public push(value: T): void {
    if (this.finished) return;
    const resolve = this.pulls.shift();
    if (resolve) resolve({ done: false, value });
    else this.queue.push(value);
  }

  public end(): void {
    this.finished = true;
    for (const resolve of this.pulls.splice(0))
      resolve({ done: true, value: undefined });
  }

  public next(): Promise<IteratorResult<T>> {
    if (this.queue.length)
      return Promise.resolve({ done: false, value: this.queue.shift()! });
    if (this.finished) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.pulls.push(resolve));
  }

  /** Releases both buffers together, deduplicating capability identities across them. */
  public return(): Promise<IteratorResult<T>> {
    if (!this.returned) {
      this.returned = true;
      const buffered = this.onReturn();
      this.end();
      releaseCapabilities([...buffered, ...this.queue.splice(0)]);
    }
    return Promise.resolve({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function orderedResults(pending: PendingCall, from = 0): SettledResult[] {
  return pending.targetConnectionIds.slice(from).flatMap((id) => {
    const result = pending.results.get(id);
    return result ? [result] : [];
  });
}

function releaseCapabilities(values: readonly unknown[]): void {
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (
      (typeof value !== "object" || value === null) &&
      typeof value !== "function"
    )
      return;
    if (visited.has(value)) return;
    visited.add(value);
    const release = (value as { [RELEASE_PROXY_SYMBOL]?: unknown })[
      RELEASE_PROXY_SYMBOL
    ];
    if (typeof release === "function") {
      try {
        release();
      } catch {
        /* One failed release must not stop the remaining cleanup. */
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    )
      Object.values(value).forEach(visit);
  };
  values.forEach(visit);
}
