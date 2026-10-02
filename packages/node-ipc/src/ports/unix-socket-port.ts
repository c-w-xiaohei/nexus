import type net from "node:net";
import type { IPort } from "@nexus-js/core";
import { NodeIpcError } from "../errors.js";
import { BinaryFrame, MAX_FRAME_SIZE } from "../framing/binary-frame.js";

export class UnixSocketPort implements IPort {
  readonly maxPacketBytes = MAX_FRAME_SIZE;
  private readonly messageHandlers = new Set<(message: ArrayBuffer) => void>();
  private readonly disconnectHandlers = new Set<() => void>();
  private readonly decoder = BinaryFrame.createDecoder();
  private disconnected = false;
  private socketTerminationStarted = false;

  constructor(private readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      const packet = new Uint8Array(chunk.byteLength);
      packet.set(chunk);
      const result = this.decoder.push(packet.buffer);
      result.match({
        ok: (frames) => {
          for (const frame of frames) {
            for (const handler of this.messageHandlers) handler(frame);
          }
        },
        err: () => this.close(),
      });
    });
    socket.once("close", () => this.notifyDisconnect());
    socket.once("error", () => this.notifyDisconnect());
  }

  postMessage(
    message: ArrayBuffer,
    _transfer?: Transferable[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.disconnected || this.socket.destroyed || !this.socket.writable) {
      this.close();
      return Promise.reject(disconnectedError());
    }

    const result = BinaryFrame.encode(message);
    if (result.isErr()) return Promise.reject(result.error);
    if (signal?.aborted) return Promise.reject(abortedError());

    const frame = Buffer.from(result.value);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let writeCallbackDone = false;
      let needsDrain = false;
      const timeout = setTimeout(
        () => finish(disconnectedError("Socket write timed out")),
        30_000,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off("drain", onDrain);
        this.socket.off("close", onClose);
        this.socket.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error?: NodeIpcError) => {
        if (settled) return;
        settled = true;
        if (error) this.close();
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const maybeFinish = () => {
        if (writeCallbackDone && (!needsDrain || drainObserved)) finish();
      };
      let drainObserved = false;
      const onDrain = () => {
        drainObserved = true;
        maybeFinish();
      };
      const onClose = () => finish(disconnectedError());
      const onError = (cause: Error) =>
        finish(disconnectedError("Socket write failed", cause));
      const onAbort = () => finish(abortedError());

      this.socket.once("close", onClose);
      this.socket.once("error", onError);
      this.socket.on("drain", onDrain);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // From this point the native write may have accepted the complete frame,
        // even if its callback or a later drain/error never confirms delivery.
        needsDrain = !this.socket.write(frame, (cause) => {
          if (cause) {
            finish(disconnectedError("Socket write failed", cause));
            return;
          }
          writeCallbackDone = true;
          maybeFinish();
        });
        maybeFinish();
      } catch (cause) {
        finish(disconnectedError("Socket write failed", cause));
      }
    });
  }

  onMessage(handler: (message: ArrayBuffer) => void): void {
    this.messageHandlers.add(handler);
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.add(handler);
  }

  close(): void {
    if (this.socketTerminationStarted) return;
    this.socketTerminationStarted = true;
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

function disconnectedError(
  message = "Unix socket is disconnected",
  cause?: unknown,
): NodeIpcError {
  return new NodeIpcError(message, "E_IPC_CONNECT_FAILED", cause);
}

function abortedError(): NodeIpcError {
  return new NodeIpcError(
    "Unix socket write was aborted",
    "E_IPC_CONNECT_FAILED",
  );
}
