import type { IPort } from "@nexus-js/core";
import type NodeWebSocket from "ws";
import type { WebSocketLimits } from "../types/options.js";

/** Owns reception from socket acquisition until terminal cleanup; no listener handoff. */
export class WebSocketPort implements IPort {
  private readonly earlyPackets: ArrayBuffer[] = [];
  private earlyBytes = 0;
  private draining = false;
  private messageHandler?: (message: unknown) => void;
  private disconnectHandler?: () => void;
  private closed = false;

  constructor(
    private readonly socket: globalThis.WebSocket | NodeWebSocket,
    private readonly options: Required<Omit<WebSocketLimits, "maxConnections">>,
    private readonly onTerminal: () => void,
  ) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", this.receive);
    socket.addEventListener("close", this.close);
    socket.addEventListener("error", this.close);
  }

  postMessage(message: unknown): void {
    if (this.closed) return;
    if (
      !(message instanceof ArrayBuffer) ||
      message.byteLength > this.options.maxPayloadBytes ||
      this.socket.readyState !== 1 ||
      this.socket.bufferedAmount + message.byteLength >
        this.options.maxBufferedAmountBytes
    )
      return this.close();
    try {
      if ("terminate" in this.socket) {
        this.socket.send(message, (error) => {
          if (error) this.close();
        });
      } else {
        this.socket.send(message);
      }
      if (this.socket.bufferedAmount > this.options.maxBufferedAmountBytes)
        this.close();
    } catch {
      this.close();
    }
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
      data.byteLength > this.options.maxPayloadBytes
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
