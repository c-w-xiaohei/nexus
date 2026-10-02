import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { WebSocketPort } from "../../ports/websocket-port.js";
import {
  createRawWebSocketHost,
  openWs,
  waitForClose,
} from "../integration/fixtures.js";

// Use ws's real event adapter; stub only network I/O for deterministic queue tests.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function createSocket() {
  const host = await createRawWebSocketHost(() => {});
  cleanup.push(host.close);
  const socket = await openWs(host.url);
  vi.spyOn(socket, "send").mockImplementation((_message, callback: unknown) => {
    if (typeof callback === "function") callback();
  });
  vi.spyOn(socket, "terminate");
  return socket;
}

function deliver(
  socket: WebSocket,
  data: string | ArrayBuffer | ArrayBufferView,
) {
  socket.emit("message", data, typeof data !== "string");
}

const limits = {
  config: {
    binaryPackets: true,
    maxFrameBytes: 16,
    maxMessageBytes: 16 * 1024 * 1024,
    maxBufferedBytes: 64 * 1024 * 1024,
  },
  maxBufferedAmountBytes: 16,
  maxEarlyPackets: 3,
  maxEarlyBytes: 16,
};

describe("WebSocket Port adoption lifecycle", () => {
  it("waits for bufferedAmount to fall below the socket high-water mark", async () => {
    const socket = await createSocket();
    const port = new WebSocketPort(socket, limits, vi.fn());
    let bufferedAmount = 16;
    Object.defineProperty(socket, "bufferedAmount", {
      configurable: true,
      get: () => bufferedAmount,
    });
    const controller = new globalThis.AbortController();
    const sent = port.postMessage(
      new ArrayBuffer(1),
      undefined,
      controller.signal,
    );

    expect(socket.send).not.toHaveBeenCalled();
    globalThis.setTimeout(() => {
      bufferedAmount = 0;
    }, 20);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    await expect(sent).resolves.toBeUndefined();
    expect(socket.terminate).not.toHaveBeenCalled();
    port.close();
  });

  it("releases a high-water wait when aborted without closing the socket", async () => {
    const socket = await createSocket();
    Object.defineProperty(socket, "bufferedAmount", { value: 16 });
    const port = new WebSocketPort(socket, limits, vi.fn());
    const controller = new globalThis.AbortController();
    const sent = port.postMessage(
      new ArrayBuffer(1),
      undefined,
      controller.signal,
    );
    controller.abort();

    await expect(sent).rejects.toMatchObject({ code: "E_TRANSFER_CANCELLED" });
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
    port.close();
  });

  it("rejects a high-water wait when the native socket closes", async () => {
    const socket = await createSocket();
    Object.defineProperty(socket, "bufferedAmount", { value: 16 });
    const port = new WebSocketPort(socket, limits, vi.fn());
    const sent = port.postMessage(new ArrayBuffer(1));
    socket.terminate();

    await expect(sent).rejects.toMatchObject({
      code: "E_WEBSOCKET_PORT_CLOSED",
    });
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("settles queued aborts immediately and preserves FIFO for remaining sends", async () => {
    const socket = await createSocket();
    const callbacks: Array<(error?: Error) => void> = [];
    vi.mocked(socket.send).mockImplementation((_message, callback: unknown) => {
      if (typeof callback === "function")
        callbacks.push(callback as (error?: Error) => void);
    });
    const port = new WebSocketPort(socket, limits, vi.fn());
    const first = port.postMessage(new ArrayBuffer(10));
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());

    const controller = new globalThis.AbortController();
    const cancelled = port.postMessage(
      new ArrayBuffer(6),
      undefined,
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      code: "E_TRANSFER_CANCELLED",
    });

    const third = port.postMessage(new ArrayBuffer(6));
    expect(socket.send).toHaveBeenCalledOnce();
    callbacks[0]!();
    await first;
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
    expect(
      vi
        .mocked(socket.send)
        .mock.calls.map(([packet]) =>
          packet instanceof ArrayBuffer ? packet.byteLength : -1,
        ),
    ).toEqual([10, 6]);
    callbacks[1]!();
    await third;
    port.close();
  });

  it("settles in-flight Node sends on abort and ignores stale callbacks", async () => {
    const socket = await createSocket();
    const callbacks: Array<(error?: Error) => void> = [];
    vi.mocked(socket.send).mockImplementation((_message, callback: unknown) => {
      if (typeof callback === "function")
        callbacks.push(callback as (error?: Error) => void);
    });
    const terminal = vi.fn();
    const port = new WebSocketPort(socket, limits, terminal);
    const controller = new globalThis.AbortController();
    const sent = port.postMessage(
      new ArrayBuffer(1),
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    controller.abort();

    await expect(sent).rejects.toMatchObject({
      code: "E_TRANSFER_CANCELLED",
    });
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
    expect(terminal).toHaveBeenCalledOnce();
    callbacks[0]!();
    expect(terminal).toHaveBeenCalledOnce();
    port.close();
  });

  it("settles in-flight Node sends on close and ignores stale callbacks", async () => {
    const socket = await createSocket();
    const callbacks: Array<(error?: Error) => void> = [];
    vi.mocked(socket.send).mockImplementation((_message, callback: unknown) => {
      if (typeof callback === "function")
        callbacks.push(callback as (error?: Error) => void);
    });
    const port = new WebSocketPort(socket, limits, vi.fn());
    const sent = port.postMessage(new ArrayBuffer(1));
    const rejected = sent.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    const closed = waitForClose(socket);
    socket.terminate();

    expect(await rejected).toMatchObject({ code: "E_WEBSOCKET_PORT_CLOSED" });
    await closed;
    callbacks[0]!();
    expect(socket.send).toHaveBeenCalledOnce();
  });

  it("bounds an in-flight Node callback by deadline and removes its listeners", async () => {
    const socket = await createSocket();
    vi.mocked(socket.send).mockImplementation(() => {});
    const options = { ...limits, sendTimeoutMs: 10 };
    const port = new WebSocketPort(socket, options, vi.fn());
    const closeListeners = socket.listenerCount("close");
    const errorListeners = socket.listenerCount("error");

    await expect(port.postMessage(new ArrayBuffer(1))).rejects.toMatchObject({
      code: "E_TRANSPORT_CAPACITY",
    });
    expect(socket.listenerCount("close")).toBe(closeListeners - 1);
    expect(socket.listenerCount("error")).toBe(errorListeners - 1);
    port.close();
  });

  it("normalizes binary views using their exact byte offset and length", async () => {
    const socket = await createSocket();
    const port = new WebSocketPort(socket, limits, vi.fn());
    // A large backing buffer must neither leak surrounding bytes nor exceed the
    // payload budget when the actual frame is a small view into it.
    const backing = new Uint8Array(64);
    backing.set([11, 22, 33], 19);
    const received: unknown[] = [];
    port.onMessage((packet) => received.push(packet));
    deliver(socket, backing.subarray(19, 22));
    deliver(socket, new DataView(backing.buffer, 20, 2));
    expect(received).toHaveLength(2);
    for (const packet of received) expect(packet).toBeInstanceOf(ArrayBuffer);
    expect(
      received.map((packet) => [...new Uint8Array(packet as ArrayBuffer)]),
    ).toEqual([
      [11, 22, 33],
      [22, 33],
    ]);
    backing.fill(0);
    expect([...new Uint8Array(received[0] as ArrayBuffer)]).toEqual([
      11, 22, 33,
    ]);
    port.close();
  });

  it("rejects an oversized binary view before delivering any packet", async () => {
    const socket = await createSocket();
    const terminal = vi.fn();
    const port = new WebSocketPort(socket, limits, terminal);
    const handler = vi.fn();
    port.onMessage(handler);
    deliver(socket, new Uint8Array(limits.config.maxFrameBytes + 1));
    expect(handler).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledOnce();
  });

  it("finishes the current handler before delivering reentrant live input", async () => {
    const socket = await createSocket();
    const port = new WebSocketPort(socket, limits, vi.fn());
    const order: string[] = [];
    port.onMessage((packet) => {
      const length = (packet as ArrayBuffer).byteLength;
      order.push(`start:${length}`);
      if (length === 1) deliver(socket, new ArrayBuffer(2));
      order.push(`end:${length}`);
    });
    deliver(socket, new ArrayBuffer(1));
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
    port.close();
  });

  it("subscribes immediately and keeps reentrant early packets ordered", async () => {
    const socket = await createSocket();
    const port = new WebSocketPort(socket, limits, vi.fn());
    const first = new ArrayBuffer(1);
    const second = new ArrayBuffer(2);
    const reentrant = new ArrayBuffer(3);
    deliver(socket, first);
    deliver(socket, second);
    const received: unknown[] = [];
    port.onMessage((packet) => {
      received.push(packet);
      if (packet === first) deliver(socket, reentrant);
    });
    expect(socket.binaryType).toBe("arraybuffer");
    expect(received).toEqual([first, second, reentrant]);
    port.close();
    expect(socket.eventNames()).toEqual([]);
  });

  it("closing during FIFO replay discards the suffix and ignores later input", async () => {
    const socket = await createSocket();
    const terminal = vi.fn();
    const port = new WebSocketPort(socket, limits, terminal);
    deliver(socket, new ArrayBuffer(1));
    deliver(socket, new ArrayBuffer(2));
    const handler = vi.fn(() => port.close());
    port.onMessage(handler);
    deliver(socket, new ArrayBuffer(3));
    port.close();
    expect(handler).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledOnce();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("reports a disconnect that occurred before Core subscribed", async () => {
    const socket = await createSocket();
    const port = new WebSocketPort(socket, limits, vi.fn());
    const closed = waitForClose(socket);
    socket.terminate();
    await closed;
    const disconnected = vi.fn();
    port.onDisconnect(disconnected);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(socket.eventNames()).toEqual([]);
  });

  it("rejects text and bounds early packet count and bytes", async () => {
    for (const packets of [
      ["text"],
      [
        new ArrayBuffer(0),
        new ArrayBuffer(0),
        new ArrayBuffer(0),
        new ArrayBuffer(0),
      ],
      [new ArrayBuffer(9), new ArrayBuffer(8)],
    ]) {
      const socket = await createSocket();
      const terminal = vi.fn();
      new WebSocketPort(socket, limits, terminal);
      for (const packet of packets) deliver(socket, packet);
      expect(terminal).toHaveBeenCalledOnce();
      expect(socket.eventNames()).toEqual([]);
    }
  });

  it("accepts exact send budget and terminates on overflow or async failure", async () => {
    const socket = await createSocket();
    const terminal = vi.fn();
    const port = new WebSocketPort(socket, limits, terminal);
    let bufferedAmount = 15;
    Object.defineProperty(socket, "bufferedAmount", {
      configurable: true,
      get: () => bufferedAmount,
    });
    await port.postMessage(new ArrayBuffer(1));
    expect(socket.send).toHaveBeenCalledOnce();
    bufferedAmount = 0;
    await port.postMessage(new ArrayBuffer(2));
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(terminal).not.toHaveBeenCalled();

    const failingSocket = await createSocket();
    vi.mocked(failingSocket.send).mockImplementation(
      (_message, callback: unknown) => {
        if (typeof callback === "function") callback(new Error("closed"));
      },
    );
    const failed = vi.fn();
    const failingPort = new WebSocketPort(failingSocket, limits, failed);
    await expect(
      failingPort.postMessage(new ArrayBuffer(1)),
    ).rejects.toMatchObject({
      code: "E_WEBSOCKET_PORT_CLOSED",
    });
    expect(failed).toHaveBeenCalledOnce();
  });
});
