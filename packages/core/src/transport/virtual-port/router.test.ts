import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { err } from "neverthrow";
import { PortProcessor } from "../port-processor";
import { JsonSerializer } from "../serializers/json-serializer";
import { BinarySerializer } from "../serializers/binary-serializer";
import { VirtualPortRouter } from "./router";
import { VirtualPortConnectError } from "./errors";
import { NexusMessageType, type GetMessage } from "../../types/message";
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
    vi.useRealTimers();
  });

  it("connects, listens, sends data, and closes", async () => {
    const bus = createBusPair();
    const server = VirtualPortRouter.create({ bus: bus.right });
    const client = VirtualPortRouter.create({ bus: bus.left });
    const serverMessages = vi.fn();
    const serverDisconnect = vi.fn();
    const clientDisconnect = vi.fn();

    expect(server).not.toHaveProperty("safeListen");
    expect(server).not.toHaveProperty("safeConnect");
    expect(server).not.toHaveProperty("safeClose");

    const listenResult = VirtualPortRouter.safeListen(server, (port) => {
      PortProcessor.create(port, JsonSerializer.serializer, {
        onLogicalMessage: serverMessages,
        onDisconnect: serverDisconnect,
      });
    });
    expect(listenResult.isOk()).toBe(true);

    const connectResult = await VirtualPortRouter.safeConnect(client).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
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

  it("does not expose mutable channel state on context", () => {
    const bus = createBusPair();
    const context = VirtualPortRouter.create({ bus: bus.right });

    expect(context).not.toHaveProperty("channels");
    expect(context).not.toHaveProperty("closedChannels");
  });

  it("uses default heartbeat values to close after three 5000ms misses", async () => {
    const bus = createBusPair();
    const server = VirtualPortRouter.create({ bus: bus.right });
    const client = VirtualPortRouter.create({ bus: bus.left });
    const serverDisconnect = vi.fn();
    VirtualPortRouter.safeListen(server, (port) =>
      port.onDisconnect(serverDisconnect),
    );

    await VirtualPortRouter.safeConnect(client).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
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

  it("safeClose disconnects exposed ports exactly once", async () => {
    const bus = createBusPair();
    const server = VirtualPortRouter.create({ bus: bus.right });
    const client = VirtualPortRouter.create({ bus: bus.left });
    const serverDisconnect = vi.fn();
    const clientDisconnect = vi.fn();
    VirtualPortRouter.safeListen(server, (port) =>
      port.onDisconnect(serverDisconnect),
    );
    const port = await VirtualPortRouter.safeConnect(client).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
    port.onDisconnect(clientDisconnect);

    expect(VirtualPortRouter.safeClose(client).isOk()).toBe(true);
    expect(VirtualPortRouter.safeClose(client).isOk()).toBe(true);
    expect(VirtualPortRouter.safeClose(server).isOk()).toBe(true);

    expect(clientDisconnect).toHaveBeenCalledOnce();
    expect(serverDisconnect).toHaveBeenCalledOnce();
  });

  it("local port.close disconnects both exposed endpoints exactly once", async () => {
    const bus = createBusPair();
    const server = VirtualPortRouter.create({ bus: bus.right });
    const client = VirtualPortRouter.create({ bus: bus.left });
    const serverDisconnect = vi.fn();
    const clientDisconnect = vi.fn();
    VirtualPortRouter.safeListen(server, (port) =>
      port.onDisconnect(serverDisconnect),
    );
    const port = await VirtualPortRouter.safeConnect(client).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
    port.onDisconnect(clientDisconnect);

    port.close();
    port.close();

    expect(clientDisconnect).toHaveBeenCalledOnce();
    expect(serverDisconnect).toHaveBeenCalledOnce();
  });

  it("returns an error when connecting after close", async () => {
    const bus = createBusPair();
    const client = VirtualPortRouter.create({ bus: bus.left });

    expect(VirtualPortRouter.safeClose(client).isOk()).toBe(true);
    const result = await VirtualPortRouter.safeConnect(client);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("closed");
  });

  it("rejects and settles when the peer is not listening", async () => {
    const bus = createBusPair();
    const server = VirtualPortRouter.create({ bus: bus.right });
    const client = VirtualPortRouter.create({
      bus: bus.left,
      connectTimeoutMs: 100,
    });

    const resultPromise = VirtualPortRouter.safeConnect(client);
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("listener-unavailable");
    expect(result._unsafeUnwrapErr().context).toEqual(
      expect.objectContaining({ reason: "listener-unavailable" }),
    );
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
    expect(VirtualPortRouter.safeClose(server).isOk()).toBe(true);
  });

  it("cleans up and returns Err when connect send throws", async () => {
    const bus = createBusPair();
    const client = VirtualPortRouter.create({
      bus: {
        send: vi.fn(() => {
          throw new Error("send failed");
        }),
        subscribe: bus.left.subscribe,
      },
      connectTimeoutMs: 100,
    });

    const result = await VirtualPortRouter.safeConnect(client);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("Failed to send");
    expect(client).not.toHaveProperty("channels");
    await vi.advanceTimersByTimeAsync(100);
  });

  it("cleans up and returns Err when connect send returns Err", async () => {
    const bus = createBusPair();
    const sendError = new VirtualPortConnectError("send returned err");
    const client = VirtualPortRouter.create({
      bus: {
        send: vi.fn(() => err(sendError)) as unknown as (
          message: unknown,
          transfer?: Transferable[],
        ) => void,
        subscribe: bus.left.subscribe,
      },
      connectTimeoutMs: 100,
    });

    const result = await VirtualPortRouter.safeConnect(client);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().context).toEqual(
      expect.objectContaining({ originalError: sendError }),
    );
    await vi.advanceTimersByTimeAsync(100);
  });

  it("times out and settles when the peer never replies", async () => {
    const bus = createBusPair();
    const client = VirtualPortRouter.create({
      bus: bus.left,
      connectTimeoutMs: 100,
    });

    const resultPromise = VirtualPortRouter.safeConnect(client);
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("timed out");
  });

  it("times out heartbeats after three misses", async () => {
    const bus = createBusPair();
    const server = VirtualPortRouter.create({
      bus: bus.right,
      heartbeat: { intervalMs: 10, maxMisses: 3 },
    });
    const client = VirtualPortRouter.create({
      bus: bus.left,
      heartbeat: { intervalMs: 10, maxMisses: 3 },
    });
    const serverDisconnect = vi.fn();
    VirtualPortRouter.safeListen(server, (port) =>
      port.onDisconnect(serverDisconnect),
    );

    await VirtualPortRouter.safeConnect(client).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
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
    const server = VirtualPortRouter.create({
      bus: bus.right,
      heartbeat: { intervalMs: 10, maxMisses: 3 },
    });
    const client = VirtualPortRouter.create({
      bus: bus.left,
      heartbeat: { intervalMs: 10, maxMisses: 3 },
    });
    const serverDisconnect = vi.fn();
    const clientDisconnect = vi.fn();
    VirtualPortRouter.safeListen(server, (port) =>
      port.onDisconnect(serverDisconnect),
    );

    const port = await VirtualPortRouter.safeConnect(client).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
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
    const server = VirtualPortRouter.create({ bus: bus.right });
    const client = VirtualPortRouter.create({ bus: bus.left });
    const serverMessages = vi.fn();
    VirtualPortRouter.safeListen(server, (port) =>
      port.onMessage(serverMessages),
    );

    const port = await VirtualPortRouter.safeConnect(client).match(
      (value) => value,
      (error) => Promise.reject(error),
    );

    port.postMessage("before-close");
    const data = bus.left.sent.find(
      (packet) =>
        typeof packet.message === "object" &&
        packet.message !== null &&
        (packet.message as { type?: string }).type === "data",
    );
    port.close();
    if (data) bus.right.send(data.message, data.transfer);

    expect(serverMessages).toHaveBeenCalledTimes(1);
  });

  it("does not create channels for unknown data or duplicate connects", async () => {
    const bus = createBusPair();
    const server = VirtualPortRouter.create({ bus: bus.right });
    const onConnect = vi.fn();
    VirtualPortRouter.safeListen(server, onConnect);

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
    const server = VirtualPortRouter.create({ bus: bus.right });
    const client = VirtualPortRouter.create({ bus: bus.left });
    const serverMessages = vi.fn();
    const clientDisconnect = vi.fn();
    VirtualPortRouter.safeListen(server, (port) =>
      port.onMessage(serverMessages),
    );

    const port = await VirtualPortRouter.safeConnect(client).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
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
    const server = VirtualPortRouter.create({ bus: bus.right });
    const client = VirtualPortRouter.create({ bus: bus.left });
    const serverMessages = vi.fn();
    const clientDisconnect = vi.fn();
    VirtualPortRouter.safeListen(server, (port) =>
      port.onMessage(serverMessages),
    );

    const port = await VirtualPortRouter.safeConnect(client).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
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
    const server = VirtualPortRouter.create({ bus: bus.right });
    const client = VirtualPortRouter.create({
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
    VirtualPortRouter.safeListen(server, () => undefined);
    const port = await VirtualPortRouter.safeConnect(client).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
    port.onDisconnect(clientDisconnect);

    const result = VirtualPortRouter.safeClose(client);
    await vi.advanceTimersByTimeAsync(100);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().context).toEqual(
      expect.objectContaining({ originalError: unsubscribeError }),
    );
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
    expect(VirtualPortRouter.safeClose(client).isOk()).toBe(true);
  });

  it("never throws for malformed bus messages", () => {
    const bus = createBusPair();
    VirtualPortRouter.create({ bus: bus.right });

    expect(() => bus.left.send(null)).not.toThrow();
    expect(() => bus.left.send({ __nexusVirtualPort: true })).not.toThrow();
  });

  it("passes transfer lists through data sends", async () => {
    const bus = createBusPair();
    const server = VirtualPortRouter.create({ bus: bus.right });
    const client = VirtualPortRouter.create({ bus: bus.left });
    VirtualPortRouter.safeListen(server, () => undefined);
    const port = await VirtualPortRouter.safeConnect(client).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
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
    const jsonServer = VirtualPortRouter.create({ bus: bus.right });
    const jsonClient = VirtualPortRouter.create({ bus: bus.left });
    const jsonMessages = vi.fn();
    VirtualPortRouter.safeListen(jsonServer, (port) => {
      PortProcessor.create(port, JsonSerializer.serializer, {
        onLogicalMessage: jsonMessages,
        onDisconnect: vi.fn(),
      });
    });
    const jsonPort = await VirtualPortRouter.safeConnect(jsonClient).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
    PortProcessor.create(jsonPort, JsonSerializer.serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    }).sendMessage(sampleMessage);
    expect(jsonMessages).toHaveBeenCalledWith(sampleMessage);

    const binaryBus = createBusPair();
    const binaryServer = VirtualPortRouter.create({ bus: binaryBus.right });
    const binaryClient = VirtualPortRouter.create({ bus: binaryBus.left });
    const binaryMessages = vi.fn();
    VirtualPortRouter.safeListen(binaryServer, (port) => {
      PortProcessor.create(port, BinarySerializer.serializer, {
        onLogicalMessage: binaryMessages,
        onDisconnect: vi.fn(),
      });
    });
    const binaryPort = await VirtualPortRouter.safeConnect(binaryClient).match(
      (value) => value,
      (error) => Promise.reject(error),
    );
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
