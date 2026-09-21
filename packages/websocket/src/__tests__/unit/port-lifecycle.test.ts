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
  vi.spyOn(socket, "send").mockImplementation(() => {});
  vi.spyOn(socket, "terminate");
  return socket;
}

function deliver(socket: WebSocket, data: string | ArrayBuffer) {
  socket.emit("message", data, typeof data !== "string");
}

const limits = {
  maxPayloadBytes: 16,
  maxBufferedAmountBytes: 16,
  maxEarlyPackets: 3,
  maxEarlyBytes: 16,
};

describe("WebSocket Port adoption lifecycle", () => {
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
    Object.defineProperty(socket, "bufferedAmount", { value: 15 });
    port.postMessage(new ArrayBuffer(1));
    expect(socket.send).toHaveBeenCalledOnce();
    port.postMessage(new ArrayBuffer(2));
    expect(socket.send).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledOnce();

    const failingSocket = await createSocket();
    vi.mocked(failingSocket.send).mockImplementation(
      (_message, callback: unknown) => {
        if (typeof callback === "function") callback(new Error("closed"));
      },
    );
    const failed = vi.fn();
    const failingPort = new WebSocketPort(failingSocket, limits, failed);
    failingPort.postMessage(new ArrayBuffer(1));
    expect(failed).toHaveBeenCalledOnce();
  });
});
