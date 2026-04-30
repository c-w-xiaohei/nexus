import type net from "node:net";
import type { IPort } from "@nexus-js/core";
import { BinaryFrame } from "../framing/binary-frame";

export class UnixSocketPort implements IPort {
  private readonly messageHandlers = new Set<(message: ArrayBuffer) => void>();
  private readonly disconnectHandlers = new Set<() => void>();
  private readonly decoder = BinaryFrame.createDecoder();
  private disconnected = false;

  constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      const packet = new Uint8Array(chunk.byteLength);
      packet.set(chunk);
      const result = this.decoder.push(packet.buffer);
      result.match(
        (frames) => {
          for (const frame of frames) {
            for (const handler of this.messageHandlers) handler(frame);
          }
        },
        () => this.close(),
      );
    });
    socket.once("close", () => this.notifyDisconnect());
    socket.once("error", () => this.notifyDisconnect());
  }

  postMessage(message: ArrayBuffer): void {
    if (this.disconnected || this.socket.destroyed || !this.socket.writable) {
      this.close();
      return;
    }

    const result = BinaryFrame.encode(message);
    result.match(
      (frame) => {
        this.socket.write(Buffer.from(frame), (error) => {
          if (error) this.close();
        });
      },
      () => this.close(),
    );
  }

  onMessage(handler: (message: ArrayBuffer) => void): void {
    this.messageHandlers.add(handler);
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.add(handler);
  }

  close(): void {
    this.notifyDisconnect();
    this.socket.end();
    this.socket.destroy();
  }

  private notifyDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const handler of this.disconnectHandlers) handler();
  }
}
