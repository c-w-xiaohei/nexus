import { Result } from "better-result";
import type { IPort } from "../types/port.js";
import { VirtualPortConnectError } from "./errors.js";
import { VirtualPortProtocol } from "./protocol.js";
import type { VirtualPortRouter } from "./router.js";

export interface VirtualPortOptions {
  readonly bus: VirtualPortRouter.Bus;
  readonly heartbeat: Required<VirtualPortRouter.HeartbeatOptions>;
  readonly connectTimeoutMs: number;
}

type State =
  | { readonly type: "open" | "closed" }
  | {
      readonly type: "connecting";
      readonly resolve: (
        result: Result<IPort, VirtualPortConnectError>,
      ) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
    };

/** Internal channel entity; the router publishes it only as IPort. */
export class VirtualPort implements IPort {
  private state: State = { type: "open" };
  private readonly messageHandlers = new Set<(message: unknown) => void>();
  private readonly disconnectHandlers = new Set<() => void>();
  private readonly pendingMessages: unknown[] = [];
  private delivering = false;
  private seq = 0;
  private missedPongs = 0;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    readonly base: ReturnType<typeof VirtualPortProtocol.createBase>,
    private readonly options: VirtualPortOptions,
    private readonly onClosed: () => void,
  ) {}

  get isOpen(): boolean {
    return this.state.type === "open";
  }

  connect(): Promise<Result<IPort, VirtualPortConnectError>> {
    return new Promise((resolve) => {
      // Register settlement before a synchronous bus can reply or close us.
      this.state = {
        type: "connecting",
        resolve,
        timeout: setTimeout(() => {
          this.disconnect(
            false,
            new VirtualPortConnectError("Virtual port connection timed out", {
              channelId: this.base.channelId,
              reason: "timeout",
            }),
          );
        }, this.options.connectTimeoutMs),
      };
      const sent = this.send({ ...this.base, type: "connect" });
      if (sent.isErr()) {
        this.disconnect(
          false,
          new VirtualPortConnectError(
            "Failed to send virtual port connect message",
            { channelId: this.base.channelId, originalError: sent.error },
          ),
        );
      }
    });
  }

  accept(): Result<void, unknown> {
    const sent = this.send({ ...this.base, type: "accept" });
    // ACCEPT may synchronously close this channel or replay CONNECT.
    if (sent.isOk() && this.isOpen) this.startHeartbeat();
    return sent;
  }

  receive(
    message: Exclude<VirtualPortProtocol.Message, { type: "connect" }>,
  ): void {
    switch (message.type) {
      case "accept": {
        if (this.state.type !== "connecting") return;
        const pending = this.state;
        clearTimeout(pending.timeout);
        this.state = { type: "open" };
        this.startHeartbeat();
        pending.resolve(Result.ok(this));
        break;
      }
      case "reject":
        if (this.state.type !== "connecting") return;
        this.disconnect(
          false,
          new VirtualPortConnectError(
            `Virtual port connection rejected: ${message.reason ?? "unknown"}`,
            { channelId: this.base.channelId, reason: message.reason },
          ),
        );
        break;
      case "close":
        this.disconnect(false);
        break;
      case "data":
        if (!this.isOpen) return;
        // Bound both the subscription gap and synchronous reentrant delivery.
        if (this.pendingMessages.length >= 1024) {
          this.disconnect(true);
          return;
        }
        this.pendingMessages.push(message.payload);
        this.flushMessages();
        break;
      case "ping":
        if (this.isOpen) this.send({ ...this.base, type: "pong" });
        break;
      case "pong":
        if (this.isOpen) this.missedPongs = 0;
        break;
    }
  }

  postMessage(payload: unknown, transfer?: Transferable[]): void {
    if (!this.isOpen) return;
    // IPort is the throw-style native boundary; internals retain Result errors.
    const sent = this.send(
      {
        ...this.base,
        type: "data",
        seq: ++this.seq,
        payload,
      },
      transfer,
    );
    if (sent.isErr()) throw sent.error;
  }

  onMessage(handler: (message: unknown) => void): void {
    if (this.state.type === "closed") return;
    this.messageHandlers.add(handler);
    this.flushMessages();
  }

  onDisconnect(handler: () => void): void {
    if (this.state.type === "closed") {
      handler();
      return;
    }
    this.disconnectHandlers.add(handler);
  }

  close(): void {
    const closed = this.disconnect(true);
    if (closed.isErr()) throw closed.error;
  }

  /** Commit terminal state and detach routing before any bus or observer reentry. */
  disconnect(
    notifyRemote: boolean,
    error?: VirtualPortConnectError,
  ): Result<void, unknown> {
    if (this.state.type === "closed") return Result.ok(undefined);
    const previous = this.state;
    this.state = { type: "closed" };
    this.pendingMessages.length = 0;
    this.messageHandlers.clear();
    const handlers = Array.from(this.disconnectHandlers);
    this.disconnectHandlers.clear();
    this.onClosed();
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (previous.type === "connecting") {
      clearTimeout(previous.timeout);
      previous.resolve(
        Result.err(
          error ??
            new VirtualPortConnectError(
              "Virtual port channel closed before accept",
              { channelId: this.base.channelId },
            ),
        ),
      );
    }
    // Closing is local and unconditional, even if the peer cannot be notified.
    if (notifyRemote) this.send({ ...this.base, type: "close" });
    let result: Result<void, unknown> = Result.ok(undefined);
    for (const handler of handlers) {
      const notified = Result.try({ try: handler, catch: (error) => error });
      if (notified.isErr() && result.isOk()) result = notified;
    }
    return result;
  }

  private startHeartbeat(): void {
    if (!this.options.heartbeat.enabled || this.heartbeatTimer !== undefined)
      return;
    this.heartbeatTimer = setInterval(() => {
      this.missedPongs += 1;
      if (this.missedPongs >= this.options.heartbeat.maxMisses) {
        this.disconnect(false);
        return;
      }
      this.send({ ...this.base, type: "ping" });
    }, this.options.heartbeat.intervalMs);
  }

  private send(
    message: VirtualPortProtocol.Message,
    transfer?: Transferable[],
  ): Result<void, unknown> {
    try {
      return this.options.bus.send(message, transfer) ?? Result.ok(undefined);
    } catch (error) {
      return Result.err(error);
    }
  }

  private flushMessages(): void {
    if (this.delivering || this.messageHandlers.size === 0) return;
    this.delivering = true;
    try {
      // disconnect clears this same queue, including during handler reentry.
      while (this.pendingMessages.length > 0) {
        const message = this.pendingMessages.shift();
        for (const handler of this.messageHandlers) handler(message);
      }
    } finally {
      this.delivering = false;
    }
  }
}
