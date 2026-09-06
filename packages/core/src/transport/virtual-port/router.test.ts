import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Result } from "better-result";
const { err } = Result;

const unwrapAsync = async <T, E>(
  promise: Promise<Result<T, E>>,
): Promise<T> => {
  const result = await promise;
  if (result.isErr()) throw result.error;
  return result.value;
};
import { PortProcessor } from "../port-processor";
import { JsonSerializer } from "../serializers/json-serializer";
import { BinarySerializer } from "../serializers/binary-serializer";
import { VirtualPortRouter } from "./router";
import { VirtualPortConnectError } from "./errors";
import { NexusMessageType, type GetMessage } from "../../types/message";
import type { IPort } from "../types/port";
import * as transportExports from "../index";
import * as virtualPortExports from "./index";

type BusPacket = { message: unknown; transfer?: Transferable[] };

const createBusPair = () => {
  const leftHandlers = new Set<(message: unknown) => void>();
  const rightHandlers = new Set<(message: unknown) => void>();
  const leftSent: BusPacket[] = [];
  const rightSent: BusPacket[] = [];

  return {
    left: {
      sent: leftSent,
      send: vi.fn((message: unknown, transfer?: Transferable[]) => {
        leftSent.push({ message, transfer });
        for (const handler of rightHandlers) handler(message);
      }),
      subscribe: vi.fn((handler: (message: unknown) => void) => {
        leftHandlers.add(handler);
        return () => leftHandlers.delete(handler);
      }),
    },
    right: {
      sent: rightSent,
      send: vi.fn((message: unknown, transfer?: Transferable[]) => {
        rightSent.push({ message, transfer });
        for (const handler of leftHandlers) handler(message);
      }),
      subscribe: vi.fn((handler: (message: unknown) => void) => {
        rightHandlers.add(handler);
        return () => rightHandlers.delete(handler);
      }),
    },
  };
};

const sampleMessage: GetMessage = {
  type: NexusMessageType.GET,
  id: "req-1",
  resourceId: "service",
  path: ["ping"],
};

describe("VirtualPortRouter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("connects, listens, sends data, and closes", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const serverMessages = vi.fn();
    const serverDisconnect = vi.fn();
    const clientDisconnect = vi.fn();

    const listenResult = server.safeListen((port) => {
      PortProcessor.create(port, JsonSerializer.serializer, {
        onLogicalMessage: serverMessages,
        onDisconnect: serverDisconnect,
      });
    });
    expect(listenResult.isOk()).toBe(true);

    const connectResult = await unwrapAsync(client.safeConnect());
    const clientProcessor = PortProcessor.create(
      connectResult,
      JsonSerializer.serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: clientDisconnect },
    );

    expect(clientProcessor.sendMessage(sampleMessage).isOk()).toBe(true);
    expect(serverMessages).toHaveBeenCalledWith(sampleMessage);

    expect(connectResult.close()).toBeUndefined();
    expect(serverDisconnect).toHaveBeenCalledOnce();
    expect(clientDisconnect).toHaveBeenCalledOnce();
  });

  it("reports listener replacement and terminal closure through read-only state", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const previous = vi.fn();
    const current = vi.fn();
    expect(server.listening).toBe(false);
    expect(server.closed).toBe(false);
    server.safeListen(previous).unwrap();
    server.safeListen(current).unwrap();
    expect(server.listening).toBe(true);
    (await client.safeConnect()).unwrap();
    expect(previous).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
    server.safeClose().unwrap();
    expect(server.listening).toBe(false);
    expect(server.closed).toBe(true);
    expect(server.safeListen(previous)).toMatchObject({
      error: { code: "VIRTUAL_PORT_LISTEN_FAILED" },
    });
    client.safeClose().unwrap();
  });

  it("delivers server data sent before the client subscribes in order", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    server.safeListen((port) => {
      port.postMessage("first");
      port.postMessage("second");
    });
    const port = await unwrapAsync(client.safeConnect());
    const received: unknown[] = [];
    port.onMessage((message) => received.push(message));
    expect(received).toEqual(["first", "second"]);
    client.safeClose();
    server.safeClose();
  });

  it("notifies a subscriber when the peer closed before subscription", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    server.safeListen((port) => port.close());
    const port = await unwrapAsync(client.safeConnect());
    const disconnected = vi.fn();
    port.onDisconnect(disconnected);
    expect(disconnected).toHaveBeenCalledOnce();
    client.safeClose();
    server.safeClose();
  });

  it("keeps queued messages ahead of reentrant messages during subscription", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    let peer!: IPort;
    server.safeListen((port) => {
      peer = port;
      port.postMessage("first");
      port.postMessage("second");
    });
    const port = await unwrapAsync(client.safeConnect());
    const received: unknown[] = [];
    port.onMessage((message) => {
      received.push(message);
      if (message === "first") peer.postMessage("third");
    });
    expect(received).toEqual(["first", "second", "third"]);
    client.safeClose();
    server.safeClose();
  });

  it("closes an unconsumed port when its startup buffer limit is exceeded", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    server.safeListen((port) => {
      for (let i = 0; i <= 1024; i++) port.postMessage(i);
    });
    const port = await unwrapAsync(client.safeConnect());
    const disconnected = vi.fn();
    port.onDisconnect(disconnected);
    const received = vi.fn();
    port.onMessage(received);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    client.safeClose();
    server.safeClose();
  });

  it("finishes delivery to all subscribers before a reentrant message", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    let peer!: IPort;
    server.safeListen((port) => {
      peer = port;
    });
    const port = await unwrapAsync(client.safeConnect());
    port.onMessage((message) => {
      if (message === "first") peer.postMessage("second");
    });
    const received: unknown[] = [];
    port.onMessage((message) => received.push(message));
    peer.postMessage("first");
    expect(received).toEqual(["first", "second"]);
    client.safeClose();
    server.safeClose();
  });

  it("reports data send failures to PortProcessor", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    server.safeListen(() => undefined);
    const port = await unwrapAsync(client.safeConnect());
    const processor = PortProcessor.create(port, JsonSerializer.serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    });
    bus.left.send.mockImplementation(() => {
      throw new Error("data failed");
    });
    expect(processor.sendMessage(sampleMessage)).toMatchObject({
      error: { code: "E_PROTOCOL_ERROR" },
    });
    client.safeClose();
    server.safeClose();
  });

  it("does not publish incoming ports when accept cannot be sent", async () => {
    const bus = createBusPair();
    bus.right.send.mockImplementation(() => {
      throw new Error("accept failed");
    });
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({
      bus: bus.left,
      connectTimeoutMs: 10,
    });
    const accepted = vi.fn();
    server.safeListen(accepted);
    const connecting = client.safeConnect();
    await vi.advanceTimersByTimeAsync(10);
    expect((await connecting).isErr()).toBe(true);
    expect(accepted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    client.safeClose();
    server.safeClose();
  });

  it("closes an accepted channel when the listener fails to attach it", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      server.safeListen(() => {
        throw new Error("attach failed");
      });
      const port = await unwrapAsync(client.safeConnect());
      const disconnected = vi.fn();
      port.onDisconnect(disconnected);
      expect(disconnected).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.safeClose();
      server.safeClose();
      logged.mockRestore();
    }
  });

  it("finishes closing all channels when a disconnect observer throws", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    server.safeListen(() => undefined);
    const first = await unwrapAsync(client.safeConnect());
    const second = await unwrapAsync(client.safeConnect());
    first.onDisconnect(() => {
      throw new Error("observer failed");
    });
    const disconnected = vi.fn();
    first.onDisconnect(disconnected);
    second.onDisconnect(disconnected);
    expect(client.safeClose().isErr()).toBe(true);
    expect(disconnected).toHaveBeenCalledTimes(2);
    server.safeClose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses default heartbeat values to close after three 5000ms misses", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const serverDisconnect = vi.fn();
    server.safeListen((port) => port.onDisconnect(serverDisconnect));

    await unwrapAsync(client.safeConnect());
    bus.left.send.mockImplementation(
      (message: unknown, transfer?: Transferable[]) => {
        bus.left.sent.push({ message, transfer });
      },
    );

    await vi.advanceTimersByTimeAsync(14_999);
    expect(serverDisconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(serverDisconnect).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "keeps a responsive channel open with heartbeat enabled=%s",
    async (enabled) => {
      const bus = createBusPair();
      const heartbeat = { enabled, intervalMs: 10, maxMisses: 3 };
      const server = new VirtualPortRouter({ bus: bus.right, heartbeat });
      const client = new VirtualPortRouter({ bus: bus.left, heartbeat });
      const received = vi.fn();
      server.safeListen((port) => port.onMessage(received));
      const port = await unwrapAsync(client.safeConnect());
      const disconnected = vi.fn();
      port.onDisconnect(disconnected);
      await vi.advanceTimersByTimeAsync(100);
      port.postMessage("still-open");
      expect(received).toHaveBeenCalledWith("still-open");
      expect(disconnected).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(enabled ? 2 : 0);
      client.safeClose();
      server.safeClose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("ignores packets with the wrong nonce on an existing channel", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const received = vi.fn();
    const disconnected = vi.fn();
    const accepted = vi.fn((port: IPort) => {
      port.onMessage(received);
      port.onDisconnect(disconnected);
    });
    server.safeListen(accepted);
    const port = await unwrapAsync(client.safeConnect());
    const connect = bus.left.sent[0]!.message as Record<string, unknown>;
    const wrongNonce = { ...connect, nonce: "unrelated" };
    bus.left.send(wrongNonce);
    bus.left.send({ ...wrongNonce, type: "data", seq: 1, payload: "ignored" });
    bus.left.send({ ...wrongNonce, type: "close" });
    port.postMessage("valid");
    expect(received).toHaveBeenCalledExactlyOnceWith("valid");
    expect(disconnected).not.toHaveBeenCalled();
    expect(accepted).toHaveBeenCalledOnce();
    client.safeClose();
    server.safeClose();
  });

  it("safeClose disconnects exposed ports exactly once", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const serverDisconnect = vi.fn();
    const clientDisconnect = vi.fn();
    server.safeListen((port) => port.onDisconnect(serverDisconnect));
    const port = await unwrapAsync(client.safeConnect());
    port.onDisconnect(clientDisconnect);

    expect(client.safeClose().isOk()).toBe(true);
    expect(client.safeClose().isOk()).toBe(true);
    expect(server.safeClose().isOk()).toBe(true);

    expect(clientDisconnect).toHaveBeenCalledOnce();
    expect(serverDisconnect).toHaveBeenCalledOnce();
  });

  it("local port.close disconnects both exposed endpoints exactly once", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const serverDisconnect = vi.fn();
    const clientDisconnect = vi.fn();
    server.safeListen((port) => port.onDisconnect(serverDisconnect));
    const port = await unwrapAsync(client.safeConnect());
    port.onDisconnect(clientDisconnect);

    port.close();
    port.close();

    expect(clientDisconnect).toHaveBeenCalledOnce();
    expect(serverDisconnect).toHaveBeenCalledOnce();
  });

  it("returns an error when connecting after close", async () => {
    const bus = createBusPair();
    const client = new VirtualPortRouter({ bus: bus.left });

    expect(client.safeClose().isOk()).toBe(true);
    const result = await client.safeConnect();

    expect(result).toMatchObject({
      error: {
        code: "VIRTUAL_PORT_CONNECT_FAILED",
        message: "Virtual port router is closed",
      },
    });
  });

  it("rejects and settles when the peer is not listening", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({
      bus: bus.left,
      connectTimeoutMs: 100,
    });

    const result = await client.safeConnect();
    expect(result).toMatchObject({
      error: {
        code: "VIRTUAL_PORT_CONNECT_FAILED",
        context: { reason: "listener-unavailable" },
      },
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(bus.right.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            type: "reject",
            reason: "listener-unavailable",
          }),
        }),
      ]),
    );
    expect(server.safeClose().isOk()).toBe(true);
  });

  it("cleans up and returns Err when connect send throws", async () => {
    const bus = createBusPair();
    const client = new VirtualPortRouter({
      bus: {
        send: vi.fn(() => {
          throw new Error("send failed");
        }),
        subscribe: bus.left.subscribe,
      },
      connectTimeoutMs: 100,
    });

    const result = await client.safeConnect();

    expect(result).toMatchObject({
      error: {
        code: "VIRTUAL_PORT_CONNECT_FAILED",
        context: {
          originalError: expect.objectContaining({ message: "send failed" }),
        },
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up and returns Err when connect send returns Err", async () => {
    const bus = createBusPair();
    const sendError = new VirtualPortConnectError("send returned err");
    const client = new VirtualPortRouter({
      bus: {
        send: vi.fn(() => err(sendError)),
        subscribe: bus.left.subscribe,
      },
      connectTimeoutMs: 100,
    });

    const result = await client.safeConnect();

    expect(result).toMatchObject({
      error: {
        code: "VIRTUAL_PORT_CONNECT_FAILED",
        context: { originalError: sendError },
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out and settles when the peer never replies", async () => {
    const bus = createBusPair();
    const client = new VirtualPortRouter({
      bus: bus.left,
      connectTimeoutMs: 100,
    });

    const resultPromise = client.safeConnect();
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toMatchObject({
      error: {
        code: "VIRTUAL_PORT_CONNECT_FAILED",
        context: { reason: "timeout" },
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out heartbeats after three misses", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({
      bus: bus.right,
      heartbeat: { intervalMs: 10, maxMisses: 3 },
    });
    const client = new VirtualPortRouter({
      bus: bus.left,
      heartbeat: { intervalMs: 10, maxMisses: 3 },
    });
    const serverDisconnect = vi.fn();
    server.safeListen((port) => port.onDisconnect(serverDisconnect));

    await unwrapAsync(client.safeConnect());
    bus.left.send.mockImplementation(
      (message: unknown, transfer?: Transferable[]) => {
        bus.left.sent.push({ message, transfer });
      },
    );

    await vi.advanceTimersByTimeAsync(31);

    expect(serverDisconnect).toHaveBeenCalledOnce();
  });

  it("times out heartbeats exactly once for both endpoints", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({
      bus: bus.right,
      heartbeat: { intervalMs: 10, maxMisses: 3 },
    });
    const client = new VirtualPortRouter({
      bus: bus.left,
      heartbeat: { intervalMs: 10, maxMisses: 3 },
    });
    const serverDisconnect = vi.fn();
    const clientDisconnect = vi.fn();
    server.safeListen((port) => port.onDisconnect(serverDisconnect));

    const port = await unwrapAsync(client.safeConnect());
    port.onDisconnect(clientDisconnect);
    bus.left.send.mockImplementation(
      (message: unknown, transfer?: Transferable[]) => {
        bus.left.sent.push({ message, transfer });
      },
    );
    bus.right.send.mockImplementation(
      (message: unknown, transfer?: Transferable[]) => {
        bus.right.sent.push({ message, transfer });
      },
    );

    await vi.advanceTimersByTimeAsync(40);

    expect(serverDisconnect).toHaveBeenCalledOnce();
    expect(clientDisconnect).toHaveBeenCalledOnce();
  });

  it("ignores late messages after a channel closes", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const serverMessages = vi.fn();
    server.safeListen((port) => port.onMessage(serverMessages));

    const port = await unwrapAsync(client.safeConnect());

    port.postMessage("before-close");
    const data = bus.left.sent.find(
      (packet) =>
        typeof packet.message === "object" &&
        packet.message !== null &&
        (packet.message as { type?: string }).type === "data",
    );
    port.close();
    expect(data).toBeDefined();
    bus.left.send(data!.message, data!.transfer);

    expect(serverMessages).toHaveBeenCalledTimes(1);
  });

  it("rejects closed CONNECT replays without reviving a port or timer", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const accepted = vi.fn();
    server.safeListen(accepted);
    const port = await unwrapAsync(client.safeConnect());
    const connect = bus.left.sent[0]!;
    port.close();

    bus.left.send(connect.message);
    expect(accepted).toHaveBeenCalledOnce();
    expect(bus.right.sent.at(-1)?.message).toMatchObject({ type: "reject" });
    expect(vi.getTimerCount()).toBe(0);
    client.safeClose();
    server.safeClose();
  });

  it("settles pending connects and ignores late ACCEPT after router close", async () => {
    const bus = createBusPair();
    const client = new VirtualPortRouter({ bus: bus.left });
    const connecting = client.safeConnect();
    const connect = bus.left.sent[0]!.message as Record<string, unknown>;

    expect(client.safeClose().isOk()).toBe(true);
    expect(await connecting).toMatchObject({
      error: { code: "VIRTUAL_PORT_CONNECT_FAILED" },
    });
    bus.right.send({ ...connect, type: "accept", from: "server" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not attach or start heartbeats when ACCEPT synchronously closes the peer", () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const accepted = vi.fn();
    server.safeListen(accepted);
    bus.left.subscribe((raw) => {
      const message = raw as Record<string, unknown>;
      if (message.type === "accept") {
        bus.left.send({ ...message, type: "close", from: "client" });
      }
    });
    bus.left.send({
      __nexusVirtualPort: true,
      version: 1,
      type: "connect",
      channelId: "reentrant-close",
      nonce: "nonce",
      from: "client",
    });

    expect(accepted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    server.safeClose();
  });

  it("notifies late disconnect subscribers during a reentrant close send", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    server.safeListen(() => undefined);
    const port = await unwrapAsync(client.safeConnect());
    const disconnected = vi.fn();
    let notifiedDuringSend = false;
    const send = bus.left.send.getMockImplementation()!;
    bus.left.send.mockImplementation((message, transfer) => {
      if ((message as { type: string }).type === "close") {
        port.onDisconnect(disconnected);
        notifiedDuringSend = disconnected.mock.calls.length === 1;
        port.close();
        port.postMessage("must-not-send");
      }
      send(message, transfer);
    });

    expect(() => port.close()).not.toThrow();
    expect(notifiedDuringSend).toBe(true);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(
      bus.left.sent.map(({ message }) => (message as { type: string }).type),
    ).toEqual(["connect", "close"]);
    expect(vi.getTimerCount()).toBe(0);
    client.safeClose();
    server.safeClose();
  });

  it("stops buffered delivery when a message handler closes the port", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    server.safeListen((port) => {
      port.postMessage("first");
      port.postMessage("second");
    });
    const port = await unwrapAsync(client.safeConnect());
    const received: unknown[] = [];
    port.onMessage((message) => {
      received.push(message);
      port.close();
    });
    expect(received).toEqual(["first"]);
    expect(vi.getTimerCount()).toBe(0);
    client.safeClose();
    server.safeClose();
  });

  it("keeps one heartbeat per port across reentrant CONNECT replay", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const accepted = vi.fn();
    server.safeListen(accepted);
    const send = bus.right.send.getMockImplementation()!;
    let replayed = false;
    bus.right.send.mockImplementation((message, transfer) => {
      if (!replayed && (message as { type: string }).type === "accept") {
        replayed = true;
        bus.left.send(bus.left.sent[0]!.message);
      }
      send(message, transfer);
    });
    const port = await unwrapAsync(client.safeConnect());
    expect(accepted).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(2);
    port.close();
    expect(vi.getTimerCount()).toBe(0);
    client.safeClose();
    server.safeClose();
  });

  it("finishes bulk close when an observer closes a sibling and reenters the router", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    server.safeListen(() => undefined);
    const ports = await Promise.all(
      Array.from({ length: 3 }, () => unwrapAsync(client.safeConnect())),
    );
    const disconnected = vi.fn();
    const closedReentrantly = vi.fn();
    for (const port of ports) port.onDisconnect(disconnected);
    ports[0]!.onDisconnect(() => {
      ports[1]!.close();
      closedReentrantly(client.safeClose());
      throw new Error("first observer failed");
    });
    expect(client.safeClose()).toMatchObject({
      error: { code: "VIRTUAL_PORT_CLOSE_FAILED" },
    });
    expect(disconnected).toHaveBeenCalledTimes(3);
    expect(closedReentrantly).toHaveBeenCalledWith(Result.ok(undefined));
    expect(vi.getTimerCount()).toBe(0);
    server.safeClose();
  });

  it("retains startup FIFO over an asynchronously delivered bus", async () => {
    const bus = createBusPair();
    const leftSend = bus.left.send.getMockImplementation()!;
    const rightSend = bus.right.send.getMockImplementation()!;
    bus.left.send.mockImplementation((message, transfer) => {
      queueMicrotask(() => leftSend(message, transfer));
    });
    bus.right.send.mockImplementation((message, transfer) => {
      queueMicrotask(() => rightSend(message, transfer));
    });
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    let peer!: IPort;
    server.safeListen((port) => {
      peer = port;
      port.postMessage("first");
      port.postMessage("second");
    });
    const port = await unwrapAsync(client.safeConnect());
    const received: unknown[] = [];
    const delivered = new Promise<void>((resolve) => {
      port.onMessage((message) => {
        received.push(message);
        if (message === "first") peer.postMessage("third");
        if (message === "third") resolve();
      });
    });
    await delivered;
    expect(received).toEqual(["first", "second", "third"]);
    const disconnected = new Promise<void>((resolve) =>
      peer.onDisconnect(resolve),
    );
    port.close();
    await disconnected;
    expect(vi.getTimerCount()).toBe(0);
    client.safeClose();
    server.safeClose();
  });

  it("does not create channels for unknown data or duplicate connects", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const onConnect = vi.fn();
    server.safeListen(onConnect);

    bus.left.send({
      __nexusVirtualPort: true,
      version: 1,
      type: "data",
      channelId: "missing",
      from: "client",
      nonce: "n",
      seq: 1,
      payload: "ignored",
    });
    const connect = {
      __nexusVirtualPort: true,
      version: 1,
      type: "connect",
      channelId: "dup",
      from: "client",
      nonce: "n",
    };
    bus.left.send(connect);
    bus.left.send(connect);

    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("keeps an accepted origin port open when connect is replayed", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const serverMessages = vi.fn();
    const clientDisconnect = vi.fn();
    server.safeListen((port) => port.onMessage(serverMessages));

    const port = await unwrapAsync(client.safeConnect());
    port.onDisconnect(clientDisconnect);
    const connect = bus.left.sent.find(
      (packet) =>
        typeof packet.message === "object" &&
        packet.message !== null &&
        (packet.message as { type?: string }).type === "connect",
    );

    expect(connect).toBeDefined();
    bus.left.send(connect?.message, connect?.transfer);
    port.postMessage("still-open");

    expect(clientDisconnect).not.toHaveBeenCalled();
    expect(serverMessages).toHaveBeenCalledWith("still-open");
  });

  it("ignores late rejects for already-open channels", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    const serverMessages = vi.fn();
    const clientDisconnect = vi.fn();
    server.safeListen((port) => port.onMessage(serverMessages));

    const port = await unwrapAsync(client.safeConnect());
    port.onDisconnect(clientDisconnect);
    const connect = bus.left.sent.find(
      (packet) =>
        typeof packet.message === "object" &&
        packet.message !== null &&
        (packet.message as { type?: string }).type === "connect",
    );
    const message = connect?.message as {
      channelId: string;
      from: string;
      nonce: string;
    };

    bus.right.send({
      __nexusVirtualPort: true,
      version: 1,
      type: "reject",
      channelId: message.channelId,
      from: "server",
      nonce: message.nonce,
      reason: "listener-unavailable",
    });
    port.postMessage("after-late-reject");

    expect(clientDisconnect).not.toHaveBeenCalled();
    expect(serverMessages).toHaveBeenCalledWith("after-late-reject");
  });

  it("continues safeClose cleanup when unsubscribe throws", async () => {
    const bus = createBusPair();
    const unsubscribeError = new Error("unsubscribe failed");
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({
      bus: {
        send: bus.left.send,
        subscribe: vi.fn((handler: (message: unknown) => void) => {
          const unsubscribe = bus.left.subscribe(handler);
          return () => {
            unsubscribe();
            throw unsubscribeError;
          };
        }),
      },
      heartbeat: { intervalMs: 10, maxMisses: 3 },
      connectTimeoutMs: 100,
    });
    const clientDisconnect = vi.fn();
    server.safeListen(() => undefined);
    const port = await unwrapAsync(client.safeConnect());
    port.onDisconnect(clientDisconnect);

    const result = client.safeClose();
    await vi.advanceTimersByTimeAsync(100);

    expect(result).toMatchObject({
      error: {
        code: "VIRTUAL_PORT_CLOSE_FAILED",
        context: { originalError: unsubscribeError },
      },
    });
    expect(clientDisconnect).toHaveBeenCalledOnce();
    port.postMessage("after-close");
    expect(bus.left.sent).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            type: "data",
            payload: "after-close",
          }),
        }),
      ]),
    );
    expect(client.safeClose().isOk()).toBe(true);
  });

  it("never throws for malformed bus messages", () => {
    const bus = createBusPair();
    new VirtualPortRouter({ bus: bus.right });

    expect(() => bus.left.send(null)).not.toThrow();
    expect(() => bus.left.send({ __nexusVirtualPort: true })).not.toThrow();
  });

  it("passes transfer lists through data sends", async () => {
    const bus = createBusPair();
    const server = new VirtualPortRouter({ bus: bus.right });
    const client = new VirtualPortRouter({ bus: bus.left });
    server.safeListen(() => undefined);
    const port = await unwrapAsync(client.safeConnect());
    const buffer = new ArrayBuffer(8);

    port.postMessage("payload", [buffer]);

    const data = bus.left.sent.find(
      (packet) =>
        typeof packet.message === "object" &&
        packet.message !== null &&
        (packet.message as { type?: string }).type === "data",
    );
    expect(data?.transfer).toEqual([buffer]);
  });

  it("supports PortProcessor JSON and binary serializers over virtual ports", async () => {
    const bus = createBusPair();
    const jsonServer = new VirtualPortRouter({ bus: bus.right });
    const jsonClient = new VirtualPortRouter({ bus: bus.left });
    const jsonMessages = vi.fn();
    jsonServer.safeListen((port) => {
      PortProcessor.create(port, JsonSerializer.serializer, {
        onLogicalMessage: jsonMessages,
        onDisconnect: vi.fn(),
      });
    });
    const jsonPort = await unwrapAsync(jsonClient.safeConnect());
    PortProcessor.create(jsonPort, JsonSerializer.serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    }).sendMessage(sampleMessage);
    expect(jsonMessages).toHaveBeenCalledWith(sampleMessage);

    const binaryBus = createBusPair();
    const binaryServer = new VirtualPortRouter({ bus: binaryBus.right });
    const binaryClient = new VirtualPortRouter({ bus: binaryBus.left });
    const binaryMessages = vi.fn();
    binaryServer.safeListen((port) => {
      PortProcessor.create(port, BinarySerializer.serializer, {
        onLogicalMessage: binaryMessages,
        onDisconnect: vi.fn(),
      });
    });
    const binaryPort = await unwrapAsync(binaryClient.safeConnect());
    PortProcessor.create(binaryPort, BinarySerializer.serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    }).sendMessage(sampleMessage);
    expect(binaryMessages).toHaveBeenCalledWith(sampleMessage);
  });

  it("exports adapter-author virtual port API without concrete VirtualPort", () => {
    expect(transportExports).toHaveProperty("VirtualPortRouter");
    expect(transportExports).toHaveProperty("VirtualPortConnectError");
    expect(transportExports).not.toHaveProperty("VirtualPort");
    expect(transportExports).not.toHaveProperty("createVirtualPort");
    expect(transportExports).not.toHaveProperty("VirtualPortProtocol");

    expect(virtualPortExports).toHaveProperty("VirtualPortRouter");
    expect(virtualPortExports).toHaveProperty("VirtualPortConnectError");
    expect(virtualPortExports).not.toHaveProperty("VirtualPort");
    expect(virtualPortExports).not.toHaveProperty("createVirtualPort");
    expect(virtualPortExports).not.toHaveProperty("VirtualPortProtocol");
  });
});
