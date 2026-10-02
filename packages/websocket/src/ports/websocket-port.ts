import type { IPort } from "@nexus-js/core";
import type NodeWebSocket from "ws";
import type { WebSocketLimits } from "../types/options.js";
import type { ResolvedTransportConfig } from "@nexus-js/core/transport/config";
import { WebSocketAdapterError } from "../errors.js";

/** Owns reception from socket acquisition until terminal cleanup; no listener handoff. */
export class WebSocketPort implements IPort {
  readonly maxPacketBytes: number;
  private readonly earlyPackets: ArrayBuffer[] = [];
  private earlyBytes = 0;
  private draining = false;
  private messageHandler?: (message: unknown) => void;
  private disconnectHandler?: () => void;
  private closed = false;
  private sendTail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;

  constructor(
    private readonly socket: globalThis.WebSocket | NodeWebSocket,
    private readonly options: Required<
      Pick<
        WebSocketLimits,
        "maxBufferedAmountBytes" | "maxEarlyPackets" | "maxEarlyBytes"
      >
    > & {
      readonly config: Readonly<ResolvedTransportConfig>;
      readonly sendTimeoutMs?: number;
    },
    private readonly onTerminal: () => void,
  ) {
    this.maxPacketBytes = 1024 * 1024;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", this.receive);
    socket.addEventListener("close", this.close);
    socket.addEventListener("error", this.close);
  }

  postMessage(
    message: unknown,
    _transfer?: Transferable[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!(message instanceof ArrayBuffer))
      return Promise.reject(this.sendError("E_MESSAGE_TOO_LARGE"));
    if (message.byteLength > this.maxPacketBytes)
      return Promise.reject(this.sendError("E_MESSAGE_TOO_LARGE"));
    if (
      this.queuedBytes + message.byteLength >
      this.options.maxBufferedAmountBytes
    )
      return Promise.reject(this.sendError("E_TRANSPORT_CAPACITY"));

    this.queuedBytes += message.byteLength;
    let settled = false;
    let released = false;
    let rejectCancellation: (error: WebSocketAdapterError) => void = () => {};
    const release = () => {
      if (released) return;
      released = true;
      this.queuedBytes -= message.byteLength;
    };
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = () => {
      if (settled) return;
      settled = true;
      release();
      rejectCancellation(this.sendError("E_TRANSFER_CANCELLED"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const sending = this.sendTail.then(async () => {
      if (settled) return;
      await this.waitForWritable(message.byteLength, signal);
      if (settled) return;
      await this.submit(message, signal);
    });
    this.sendTail = sending.catch(() => undefined);
    const result = Promise.race([sending, cancelled]);
    return result.finally(() => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      release();
    });
  }

  private submit(message: ArrayBuffer, signal?: AbortSignal): Promise<void> {
    if (this.closed)
      return Promise.reject(this.sendError("E_WEBSOCKET_PORT_CLOSED"));
    if (!("terminate" in this.socket)) {
      try {
        this.socket.send(message);
        return Promise.resolve();
      } catch {
        this.close();
        return Promise.reject(this.sendError("E_WEBSOCKET_PORT_CLOSED"));
      }
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = this.options.sendTimeoutMs ?? 30_000;
      const timer = globalThis.setTimeout(
        () => finish(this.sendError("E_TRANSPORT_CAPACITY"), true),
        timeout,
      );
      const finish = (error?: WebSocketAdapterError, closePort = false) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        this.socket.removeEventListener("close", onClose);
        this.socket.removeEventListener("error", onClose);
        signal?.removeEventListener("abort", onAbort);
        if (closePort) this.close();
        if (error) reject(error);
        else resolve();
      };
      const onClose = () => finish(this.sendError("E_WEBSOCKET_PORT_CLOSED"));
      const onAbort = () =>
        finish(this.sendError("E_TRANSFER_CANCELLED"), true);
      this.socket.addEventListener("close", onClose, { once: true });
      this.socket.addEventListener("error", onClose, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.closed || this.socket.readyState !== 1) onClose();
      else if (signal?.aborted) onAbort();
      else {
        try {
          (this.socket as NodeWebSocket).send(message, (error?: Error) => {
            if (settled) return;
            if (error) finish(this.sendError("E_WEBSOCKET_PORT_CLOSED"), true);
            else finish();
          });
        } catch {
          finish(this.sendError("E_WEBSOCKET_PORT_CLOSED"), true);
        }
      }
    });
  }

  private async waitForWritable(
    messageBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + (this.options.sendTimeoutMs ?? 30_000);
    while (
      this.socket.bufferedAmount + messageBytes >
      this.options.maxBufferedAmountBytes
    ) {
      if (this.closed || this.socket.readyState !== 1)
        throw this.sendError("E_WEBSOCKET_PORT_CLOSED");
      if (signal?.aborted) throw this.sendError("E_TRANSFER_CANCELLED");
      if (Date.now() >= deadline) throw this.sendError("E_TRANSPORT_CAPACITY");
      await this.waitForChange(signal, Math.min(5, deadline - Date.now()));
    }
    if (this.closed || this.socket.readyState !== 1)
      throw this.sendError("E_WEBSOCKET_PORT_CLOSED");
    if (signal?.aborted) throw this.sendError("E_TRANSFER_CANCELLED");
  }

  private waitForChange(signal: AbortSignal | undefined, delay: number) {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: WebSocketAdapterError) => {
        globalThis.clearTimeout(timer);
        this.socket.removeEventListener("close", closed);
        this.socket.removeEventListener("error", closed);
        signal?.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      const closed = () => finish(this.sendError("E_WEBSOCKET_PORT_CLOSED"));
      const aborted = () => finish(this.sendError("E_TRANSFER_CANCELLED"));
      const timer = globalThis.setTimeout(() => finish(), delay);
      this.socket.addEventListener("close", closed, { once: true });
      this.socket.addEventListener("error", closed, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
      if (this.closed || this.socket.readyState !== 1) closed();
      else if (signal?.aborted) aborted();
    });
  }

  private sendError(code: import("../errors.js").WebSocketErrorCode) {
    return new WebSocketAdapterError(
      "WebSocket packet could not be sent",
      code,
    );
  }

  onMessage(handler: (message: unknown) => void): void {
    if (this.closed) return;
    this.messageHandler = handler;
    this.drain();
  }

  private drain(): void {
    if (this.draining || !this.messageHandler) return;
    this.draining = true;
    try {
      // Reentrant packets join the tail; a handler closing the Port cancels the suffix.
      while (!this.closed && this.earlyPackets.length) {
        const packet = this.earlyPackets.shift()!;
        this.earlyBytes -= packet.byteLength;
        this.messageHandler(packet);
      }
    } finally {
      this.draining = false;
    }
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
    if (this.closed) handler();
  }

  readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeEventListener("message", this.receive);
    this.socket.removeEventListener("close", this.close);
    this.socket.removeEventListener("error", this.close);
    this.earlyPackets.length = 0;
    this.earlyBytes = 0;
    this.messageHandler = undefined;
    try {
      if ("terminate" in this.socket) this.socket.terminate();
      else this.socket.close();
    } catch {
      // A terminal native socket may reject close; local cleanup still runs.
    }
    try {
      this.onTerminal();
    } finally {
      this.disconnectHandler?.();
      this.disconnectHandler = undefined;
    }
  };

  private readonly receive = ({ data }: { data: unknown }): void => {
    if (this.closed) return;
    if (
      (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) ||
      data.byteLength > this.options.config.maxFrameBytes
    ) {
      return this.close();
    }
    if (
      (!this.messageHandler || this.draining) &&
      (this.earlyPackets.length >= this.options.maxEarlyPackets ||
        this.earlyBytes + data.byteLength > this.options.maxEarlyBytes)
    )
      return this.close();
    // Some ws-compatible runtimes (Bun) deliver views despite binaryType.
    // Copy only the frame's range, not the surrounding pooled backing buffer.
    const packet =
      data instanceof ArrayBuffer
        ? data
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
            .buffer;
    this.earlyPackets.push(packet);
    this.earlyBytes += data.byteLength;
    this.drain();
  };
}
