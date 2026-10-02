import { describe, it, expect, vi } from "vitest";
import { PortProcessor } from "@/transport/port-processor";
import { JsonSerializer } from "@/transport/serializers/json-serializer";
import { BinarySerializer } from "@/transport/serializers/binary-serializer";
import { createMockPortPair } from "../utils/test-utils";
import type { ApplyMessage, GetMessage } from "@/types/message";
import { NexusMessageType } from "@/types/message";
import type { ISerializer } from "./serializers/interface";
import { Result } from "better-result";
const { err, ok } = Result;
import { NexusProtocolError } from "@/errors";
import { PendingCallManager } from "@/service/pending-call-manager";

describe("PortProcessor", () => {
  const serializer = JsonSerializer.serializer;
  const sampleGetMessage: GetMessage = {
    type: NexusMessageType.GET,
    id: "req-1",
    resourceId: "serviceA",
    path: ["methodB"],
  };

  it("serializes and sends logical message", async () => {
    const [port1] = createMockPortPair();
    const processor = PortProcessor.create(port1, serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    });

    const sendResult = await processor.sendMessage(sampleGetMessage);

    expect(sendResult.isOk()).toBe(true);
    expect(port1.postMessage).toHaveBeenCalledOnce();
    const serialized = serializer.safeSerialize(sampleGetMessage);
    expect(serialized.isOk()).toBe(true);
    if (serialized.isOk()) {
      expect(port1.postMessage).toHaveBeenCalledWith(
        serialized.value,
        undefined,
        undefined,
      );
    }
  });

  it("does not classify an application frame by text inside its payload", async () => {
    const [port] = createMockPortPair();
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
      { maxFrameBytes: 32 * 1024 },
    );

    const result = await processor.sendMessage({
      ...sampleGetMessage,
      path: ["16", "x".repeat(17 * 1024)],
    });

    expect(result.isOk()).toBe(true);
    expect(port.postMessage).toHaveBeenCalledOnce();
  });

  it("awaits native asynchronous packet submission and returns its failure", async () => {
    const [port] = createMockPortPair();
    const failure = new Error("native queue closed");
    vi.mocked(port.postMessage).mockRejectedValueOnce(failure);
    const processor = PortProcessor.create(port, serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    });

    const result = await processor.sendMessage(sampleGetMessage);

    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.context).toMatchObject({ originalError: failure });
  });

  it("notifies the session owner and settles queued sends when the native queue overflows", async () => {
    const [port] = createMockPortPair();
    let unblock!: () => void;
    vi.mocked(port.postMessage).mockImplementationOnce(
      () => new Promise<void>((resolve) => (unblock = resolve)),
    );
    let processor!: PortProcessor.Context;
    const onProtocolError = vi.fn(() => processor.close());
    processor = PortProcessor.create(port, serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
      onProtocolError,
    });
    const sends = Array.from({ length: 1026 }, (_, id) =>
      processor.sendMessage({
        type: NexusMessageType.RELEASE,
        id: null,
        resourceId: String(id),
      }),
    );

    await vi.waitFor(() => expect(onProtocolError).toHaveBeenCalledOnce());
    unblock();
    const results = await Promise.all(sends);

    expect(onProtocolError).toHaveBeenCalledOnce();
    expect(results[0]?.isOk()).toBe(true);
    expect(results.slice(1).every((result) => result.isErr())).toBe(true);
  });

  it("skips a queued send aborted before native submission", async () => {
    const [port] = createMockPortPair();
    let unblock!: () => void;
    vi.mocked(port.postMessage).mockImplementationOnce(
      () => new Promise<void>((resolve) => (unblock = resolve)),
    );
    const processor = PortProcessor.create(port, serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    });
    const first = processor.sendMessage({
      ...sampleGetMessage,
      id: "first",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const second = processor.sendMessage(
      { ...sampleGetMessage, id: "second" },
      { signal: controller.signal },
    );
    controller.abort();
    unblock();

    expect((await first).isOk()).toBe(true);
    const result = await second;

    expect(result.isErr()).toBe(true);
    expect(port.postMessage).toHaveBeenCalledOnce();
    processor.close();
  });

  it("submits CANCEL before a queued RELEASE when an active chunk send is aborted", async () => {
    const [port] = createMockPortPair();
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );
    const posted: NexusMessageType[] = [];
    vi.mocked(port.postMessage).mockImplementation(async (raw) => {
      const decoded = serializer.safeDeserialize(raw as string);
      if (decoded.isOk()) posted.push(decoded.value.type);
    });
    const abort = new AbortController();
    const transfer = processor.sendMessage(
      { ...sampleGetMessage, path: ["x".repeat(1024)] },
      { signal: abort.signal },
    );
    await vi.waitFor(() =>
      expect(posted).toContain(NexusMessageType.CHUNK_START),
    );
    abort.abort();
    const release = processor.sendMessage({
      type: NexusMessageType.RELEASE,
      id: null,
      target: "scope",
      scopeId: "scope-1",
    });

    expect((await transfer).isErr()).toBe(true);
    expect((await release).isOk()).toBe(true);
    expect(posted).toEqual([
      NexusMessageType.CHUNK_START,
      NexusMessageType.CHUNK_CANCEL,
      NexusMessageType.RELEASE,
    ]);
    processor.close();
  });

  it("receives and forwards deserialized message", async () => {
    const [port1, port2] = createMockPortPair();
    const handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
    PortProcessor.create(port1, serializer, handlers);

    const serialized = serializer.safeSerialize(sampleGetMessage);
    expect(serialized.isOk()).toBe(true);
    if (serialized.isErr()) {
      return;
    }

    port2.postMessage(serialized.value);

    await vi.waitFor(() => {
      expect(handlers.onLogicalMessage).toHaveBeenCalledWith(sampleGetMessage);
    });
  });

  it("accepts the next transfer ID after a well-formed START is refused for capacity", async () => {
    const [port] = createMockPortPair();
    const onProtocolError = vi.fn();
    let reservations = 0;
    let limit = 120;
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn(), onProtocolError },
      {
        maxFrameBytes: 512,
        maxMessageBytes: 4096,
        reserveBytes: (bytes) => {
          if (reservations + bytes > limit) return false;
          reservations += bytes;
          return true;
        },
        releaseBytes: (bytes) => (reservations -= bytes),
      },
    );
    const receive = vi.mocked(port.onMessage).mock.calls[0]?.[0];
    const controls: NexusMessageType[] = [];
    vi.mocked(port.postMessage).mockImplementation(async (raw) => {
      const decoded = serializer.safeDeserialize(raw as string);
      if (decoded.isOk()) controls.push(decoded.value.type);
    });
    const start = (id: number) =>
      serializer.safeSerialize({
        type: NexusMessageType.CHUNK_START,
        id,
        version: 1,
        packetKind: NexusMessageType.GET,
        totalBytes: 64,
      });

    const refused = start(1);
    expect(refused.isOk()).toBe(true);
    if (refused.isOk()) receive?.(refused.value);
    await vi.waitFor(() =>
      expect(controls).toContain(NexusMessageType.CHUNK_CANCEL),
    );
    limit = 1000;
    const next = start(2);
    expect(next.isOk()).toBe(true);
    if (next.isOk()) receive?.(next.value);

    await vi.waitFor(() =>
      expect(
        controls.filter((type) => type === NexusMessageType.CHUNK_ACK),
      ).toHaveLength(1),
    );
    expect(onProtocolError).not.toHaveBeenCalled();
    processor.close();
  });

  it("notifies the session owner when a receiver ACK native send rejects", async () => {
    const [port] = createMockPortPair();
    const failure = new Error("ACK port write failed");
    const onProtocolError = vi.fn();
    let writes = 0;
    vi.mocked(port.postMessage).mockImplementation(async () => {
      writes++;
      if (writes === 1) throw failure;
    });
    let processor!: PortProcessor.Context;
    processor = PortProcessor.create(
      port,
      serializer,
      {
        onLogicalMessage: vi.fn(),
        onDisconnect: vi.fn(),
        onProtocolError: (error) => {
          onProtocolError(error);
          processor.close();
        },
      },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );
    const start = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_START,
      id: 1,
      version: 1,
      packetKind: NexusMessageType.GET,
      totalBytes: 32,
    });
    expect(start.isOk()).toBe(true);
    if (start.isOk()) vi.mocked(port.onMessage).mock.calls[0]?.[0](start.value);

    await vi.waitFor(() => expect(onProtocolError).toHaveBeenCalledOnce());
    expect(onProtocolError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ originalError: failure }),
      }),
    );
    expect(port.close).toHaveBeenCalledOnce();
    processor.close();
  });

  it("keeps the port usable after a determinate receiver CANCEL", async () => {
    const [port] = createMockPortPair();
    const onProtocolError = vi.fn();
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn(), onProtocolError },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );
    const receive = vi.mocked(port.onMessage).mock.calls[0]?.[0];
    const transfer = processor.sendMessage({
      ...sampleGetMessage,
      path: ["x".repeat(2048)],
    });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    const startAck = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_ACK,
      id: 1,
      version: 1,
      offset: 0,
      committed: false,
    });
    expect(startAck.isOk()).toBe(true);
    if (startAck.isOk()) receive?.(startAck.value);
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(5));
    const cancel = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_CANCEL,
      id: 1,
      version: 1,
      reason: "capacity",
    });
    expect(cancel.isOk()).toBe(true);
    if (cancel.isOk()) receive?.(cancel.value);

    const rejected = await transfer;
    expect(rejected.isErr()).toBe(true);
    if (rejected.isErr())
      expect(rejected.error.context).toMatchObject({
        transferOutcome: "determinate",
        reason: "capacity",
      });
    const recovery = await processor.sendMessage(sampleGetMessage);
    expect(recovery.isOk()).toBe(true);
    expect(onProtocolError).not.toHaveBeenCalled();
    processor.close();
  });

  it("settles locally and notifies the owner when best-effort CANCEL rejects", async () => {
    const [port] = createMockPortPair();
    const onProtocolError = vi.fn();
    vi.mocked(port.postMessage).mockImplementation(async (raw) => {
      const decoded = serializer.safeDeserialize(raw as string);
      if (
        decoded.isOk() &&
        decoded.value.type === NexusMessageType.CHUNK_CANCEL
      )
        throw new Error("CANCEL port write failed");
    });
    let processor!: PortProcessor.Context;
    processor = PortProcessor.create(
      port,
      serializer,
      {
        onLogicalMessage: vi.fn(),
        onDisconnect: vi.fn(),
        onProtocolError: (error) => {
          onProtocolError(error);
          processor.close();
        },
      },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );
    const abort = new AbortController();
    const sending = processor.sendMessage(
      { ...sampleGetMessage, path: ["x".repeat(2048)] },
      { signal: abort.signal },
    );
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    abort.abort();

    const result = await sending;

    expect(result.isErr()).toBe(true);
    await vi.waitFor(() => expect(onProtocolError).toHaveBeenCalledOnce());
    expect(onProtocolError.mock.calls[0]?.[0].message).toContain(
      "CANCEL port write failed",
    );
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("buffers raw application frames in arrival order until session activation", () => {
    const [port] = createMockPortPair();
    const onLogicalMessage = vi.fn();
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage, onDisconnect: vi.fn() },
      { maxFrameBytes: 4096, maxMessageBytes: 4096 },
    );
    const first = serializer.safeSerialize({
      ...sampleGetMessage,
      id: "first",
    });
    const second = serializer.safeSerialize({
      ...sampleGetMessage,
      id: "second",
    });
    expect(first.isOk() && second.isOk()).toBe(true);
    if (first.isErr() || second.isErr()) return;

    expect(processor.beginActivation().isOk()).toBe(true);
    const onRawMessage = vi.mocked(port.onMessage).mock.calls[0]?.[0];
    onRawMessage?.(first.value);
    onRawMessage?.(second.value);
    expect(onLogicalMessage).not.toHaveBeenCalled();

    expect(
      processor
        .activateSession({ maxFrameBytes: 4096, maxMessageBytes: 4096 })
        .isOk(),
    ).toBe(true);
    processor.completeActivation();
    expect(onLogicalMessage.mock.calls.map(([message]) => message.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("reserves inbound frame bytes until asynchronous dispatch completes", async () => {
    const [port, peer] = createMockPortPair();
    let held = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const message = { ...sampleGetMessage, id: "inbound-budget" };
    const packet = serializer.safeSerialize(message);
    expect(packet.isOk()).toBe(true);
    if (packet.isErr()) return;
    const bytes = new TextEncoder().encode(packet.value).byteLength;
    const processor = PortProcessor.create(
      port,
      serializer,
      {
        onLogicalMessage: async () => {
          await blocked;
        },
        onDisconnect: vi.fn(),
        onProtocolError: vi.fn(),
      },
      {
        maxBufferedBytes: bytes + 4,
        reserveBytes: (size) => {
          if (held + size > bytes + 4) return false;
          held += size;
          return true;
        },
        releaseBytes: (size) => (held -= size),
      },
    );

    vi.mocked(port.onMessage).mock.calls[0]?.[0](packet.value);
    expect(held).toBe(bytes);
    release();
    await vi.waitFor(() => expect(held).toBe(0));
    processor.close();
    peer.close();
  });

  it.each(["frame", "chunks"] as const)(
    "reports synchronous %s dispatch failure and releases the inbound reservation",
    async (mode) => {
      const [port, peer] = createMockPortPair();
      const failure = new Error("dispatch failed synchronously");
      const onProtocolError = vi.fn();
      let held = 0;
      const limits = { maxFrameBytes: 512, maxMessageBytes: 4096 };
      const processor = PortProcessor.create(
        port,
        serializer,
        {
          onLogicalMessage: () => {
            throw failure;
          },
          onDisconnect: vi.fn(),
          onProtocolError,
        },
        {
          ...limits,
          reserveBytes: (bytes) => ((held += bytes), true),
          releaseBytes: (bytes) => (held -= bytes),
        },
      );
      const sender = PortProcessor.create(
        peer,
        serializer,
        { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
        limits,
      );
      const message =
        mode === "chunks"
          ? { ...sampleGetMessage, path: ["x".repeat(1500)] }
          : sampleGetMessage;
      const packet = serializer.safeSerialize(message);
      expect(packet.isOk()).toBe(true);
      if (packet.isErr()) return;

      try {
        if (mode === "frame") {
          expect(() =>
            vi.mocked(port.onMessage).mock.calls[0]![0](packet.value),
          ).not.toThrow();
        } else {
          expect((await sender.sendMessage(message)).isOk()).toBe(true);
        }
        await vi.waitFor(() => {
          expect(onProtocolError).toHaveBeenCalledOnce();
          expect(held).toBe(0);
        });
        expect(onProtocolError).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            context: expect.objectContaining({ originalError: failure }),
          }),
        );
      } finally {
        processor.close();
        sender.close();
      }
    },
  );

  it.each(["abort", "disconnect"] as const)(
    "stops pumping DATA after %s while a native write is pending",
    async (terminal) => {
      vi.useFakeTimers();
      const [senderPort, receiverPort] = createMockPortPair();
      const controller = new AbortController();
      let unblock!: () => void;
      let notifyWrite!: () => void;
      const writeStarted = new Promise<void>(
        (resolve) => (notifyWrite = resolve),
      );
      const blocked = new Promise<void>((resolve) => (unblock = resolve));
      const nativePost = vi
        .mocked(senderPort.postMessage)
        .getMockImplementation()!;
      const dataWrites = vi.fn();
      vi.mocked(senderPort.postMessage).mockImplementation(async (packet) => {
        const decoded = serializer.safeDeserialize(packet);
        if (
          decoded.isOk() &&
          decoded.value.type === NexusMessageType.CHUNK_DATA
        ) {
          dataWrites();
          if (dataWrites.mock.calls.length === 1) {
            notifyWrite();
            await blocked;
          }
          return;
        }
        await nativePost(packet);
      });
      const limits = { maxFrameBytes: 512, maxMessageBytes: 4096 };
      const sender = PortProcessor.create(
        senderPort,
        serializer,
        { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
        limits,
      );
      const receiver = PortProcessor.create(
        receiverPort,
        serializer,
        { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
        limits,
      );
      try {
        const sending = sender.sendMessage(
          { ...sampleGetMessage, path: ["x".repeat(1500)] },
          { signal: controller.signal },
        );
        await vi.advanceTimersByTimeAsync(1);
        await writeStarted;
        if (terminal === "abort") controller.abort();
        else receiver.close();
        expect((await sending).isErr()).toBe(true);
        unblock();
        await vi.advanceTimersByTimeAsync(0);
        expect(dataWrites).toHaveBeenCalledOnce();
      } finally {
        unblock();
        sender.close();
        receiver.close();
        vi.useRealTimers();
      }
    },
  );

  it("keeps reassembled bytes reserved while async dispatch blocks the next START", async () => {
    const [senderPort, receiverPort] = createMockPortPair();
    let finishDispatch!: () => void;
    let dispatchStarted!: () => void;
    const blocked = new Promise<void>((resolve) => (finishDispatch = resolve));
    const started = new Promise<void>((resolve) => (dispatchStarted = resolve));
    const firstMessage = {
      ...sampleGetMessage,
      id: "first-reassembled",
      path: ["x".repeat(1500)],
    };
    const serialized = serializer.safeSerialize(firstMessage);
    expect(serialized.isOk()).toBe(true);
    if (serialized.isErr()) return;
    const encodedBytes = new TextEncoder().encode(serialized.value).byteLength;
    const budget = encodedBytes * 2 + 1024;
    let held = 0;
    const reserveBytes = (bytes: number) => {
      if (held + bytes > budget) return false;
      held += bytes;
      return true;
    };
    const releaseBytes = (bytes: number) => (held -= bytes);
    const delivered = vi.fn(async (message: GetMessage) => {
      if (message.id === "first-reassembled") {
        dispatchStarted();
        await blocked;
      }
    });
    const limits = { maxFrameBytes: 512, maxMessageBytes: 4096 };
    const sender = PortProcessor.create(
      senderPort,
      serializer,
      {
        onLogicalMessage: vi.fn(),
        onDisconnect: vi.fn(),
      },
      limits,
    );
    const receiver = PortProcessor.create(
      receiverPort,
      serializer,
      { onLogicalMessage: delivered, onDisconnect: vi.fn() },
      { ...limits, maxBufferedBytes: budget, reserveBytes, releaseBytes },
    );

    const firstSend = sender.sendMessage(firstMessage);
    expect((await firstSend).isOk()).toBe(true);
    await started;
    expect(held).toBe(encodedBytes * 2);
    const second = await sender.sendMessage({
      ...firstMessage,
      id: "second-reassembled",
      path: ["y".repeat(1500)],
    });
    expect(second.isErr()).toBe(true);
    expect(delivered).toHaveBeenCalledOnce();
    expect(held).toBe(encodedBytes * 2);

    finishDispatch();
    await vi.waitFor(() => expect(held).toBe(0));
    receiver.close();
    sender.close();
  });

  it("releases reassembled bytes once when the port closes during async dispatch", async () => {
    const [senderPort, receiverPort] = createMockPortPair();
    let finish!: () => void;
    let started!: () => void;
    let dispatched!: () => void;
    const blocked = new Promise<void>((resolve) => (finish = resolve));
    const dispatchStarted = new Promise<void>((resolve) => (started = resolve));
    const dispatchFinished = new Promise<void>(
      (resolve) => (dispatched = resolve),
    );
    let held = 0;
    const limits = { maxFrameBytes: 512, maxMessageBytes: 4096 };
    const sender = PortProcessor.create(
      senderPort,
      serializer,
      {
        onLogicalMessage: vi.fn(),
        onDisconnect: vi.fn(),
      },
      limits,
    );
    const receiver = PortProcessor.create(
      receiverPort,
      serializer,
      {
        onLogicalMessage: async () => {
          started();
          await blocked;
          dispatched();
        },
        onDisconnect: vi.fn(),
      },
      {
        ...limits,
        reserveBytes: (bytes) => ((held += bytes), true),
        releaseBytes: (bytes) => (held -= bytes),
      },
    );

    expect(
      (
        await sender.sendMessage({
          ...sampleGetMessage,
          path: ["x".repeat(1500)],
        })
      ).isOk(),
    ).toBe(true);
    await dispatchStarted;
    expect(held).toBeGreaterThan(0);
    receiver.close();
    finish();
    await dispatchFinished;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held).toBe(0);
    sender.close();
  });

  it("does not send CANCEL for an aborted transfer whose START was never submitted", async () => {
    const [senderPort, receiverPort] = createMockPortPair();
    const controller = new AbortController();
    const onProtocolError = vi.fn();
    const sender = PortProcessor.create(
      senderPort,
      {
        ...serializer,
        safeSerialize(message, options) {
          if (message.type === NexusMessageType.GET) controller.abort();
          return serializer.safeSerialize(message, options);
        },
      },
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );
    const receiver = PortProcessor.create(
      receiverPort,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn(), onProtocolError },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );

    const sent = await sender.sendMessage(
      { ...sampleGetMessage, path: ["x".repeat(1500)] },
      { signal: controller.signal },
    );
    expect(sent.isErr()).toBe(true);
    expect(senderPort.postMessage).not.toHaveBeenCalled();
    expect(onProtocolError).not.toHaveBeenCalled();
    sender.close();
    receiver.close();
  });

  it("uses JSON for bootstrap control and binary for the negotiated session", () => {
    const [port] = createMockPortPair();
    const processor = PortProcessor.create(
      port,
      JsonSerializer.serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
      {
        bootstrapJson: true,
        jsonSerializer: JsonSerializer.serializer,
        binarySerializer: BinarySerializer.serializer,
      },
    );
    const handshake = {
      type: NexusMessageType.HANDSHAKE_READY,
      id: 1,
      capabilities: ["provider-catalog-v1", "resource-scope-v1"],
      transport: {
        initiatorReceive: { maxFrameBytes: 65536, maxMessageBytes: 16777216 },
        responderReceive: { maxFrameBytes: 65536, maxMessageBytes: 16777216 },
        selectedPacketMode: "binary" as const,
      },
    };
    const outboundHandshake = processor.sendMessage(handshake);

    return outboundHandshake.then(async (sent) => {
      expect(sent.isOk()).toBe(true);
      expect(typeof vi.mocked(port.postMessage).mock.calls[0]?.[0]).toBe(
        "string",
      );
      expect(
        processor
          .activateSession({
            maxFrameBytes: 65536,
            maxMessageBytes: 16777216,
            packetMode: "binary",
          })
          .isOk(),
      ).toBe(true);
      const app = { ...sampleGetMessage, path: ["codec-switch"] };
      const sentApp = await processor.sendMessage(app);
      expect(sentApp.isOk()).toBe(true);
      expect(vi.mocked(port.postMessage).mock.calls[1]?.[0]).toBeInstanceOf(
        ArrayBuffer,
      );
      processor.close();
    });
  });

  it("forwards disconnect events", () => {
    const [port1, port2] = createMockPortPair();
    const handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
    PortProcessor.create(port1, serializer, handlers);

    port2.close();

    expect(handlers.onDisconnect).toHaveBeenCalledOnce();
  });

  it("closes underlying port", () => {
    const [port1] = createMockPortPair();
    const processor = PortProcessor.create(port1, serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    });

    processor.close();

    expect(port1.close).toHaveBeenCalledOnce();
  });

  it("reports deserialize errors via onProtocolError", async () => {
    const [port1, port2] = createMockPortPair();
    const brokenSerializer: ISerializer = {
      packetType: "string",
      safeSerialize: () => ok("ok"),
      safeDeserialize: () =>
        err(new NexusProtocolError("bad packet", { cause: "test" })),
    };
    const handlers = {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
      onProtocolError: vi.fn(),
    };

    PortProcessor.create(port1, brokenSerializer, handlers);
    port2.postMessage("raw");

    await vi.waitFor(() => {
      expect(handlers.onProtocolError).toHaveBeenCalledOnce();
    });
    expect(handlers.onLogicalMessage).not.toHaveBeenCalled();
  });

  it("passes oversized JSON packets end-to-end", async () => {
    const [port1, port2] = createMockPortPair();
    const handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
    const sender = PortProcessor.create(
      port1,
      serializer,
      {
        onLogicalMessage: vi.fn(),
        onDisconnect: vi.fn(),
      },
      { maxFrameBytes: 512 },
    );
    PortProcessor.create(port2, serializer, handlers, {
      maxFrameBytes: 512,
    });

    const largeMessage: GetMessage = {
      ...sampleGetMessage,
      path: ["very-long-path", "x".repeat(1024)],
    };

    const sendResult = await sender.sendMessage(largeMessage);
    expect(sendResult.isOk()).toBe(true);
    expect(vi.mocked(port1.postMessage).mock.calls.length).toBeGreaterThan(2);

    await vi.waitFor(() => {
      expect(handlers.onLogicalMessage).toHaveBeenCalledWith(largeMessage);
    });
  });

  it("reassembles a packet split at the configured native frame boundary", async () => {
    const [left, right] = createMockPortPair();
    const receiver = vi.fn();
    const sender = PortProcessor.create(
      left,
      serializer,
      {
        onLogicalMessage: vi.fn(),
        onDisconnect: vi.fn(),
        onProtocolError: vi.fn(),
      },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );
    PortProcessor.create(
      right,
      serializer,
      {
        onLogicalMessage: receiver,
        onDisconnect: vi.fn(),
        onProtocolError: vi.fn(),
      },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );
    const message: GetMessage = {
      ...sampleGetMessage,
      path: ["payload", "x".repeat(1500)],
    };

    const sent = await sender.sendMessage(message);

    expect(sent.isOk()).toBe(true);
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledWith(message));
  });

  it("completes simultaneous large sends in both directions while ACK controls progress", async () => {
    const [left, right] = createMockPortPair();
    const leftReceived = vi.fn();
    const rightReceived = vi.fn();
    const leftProcessor = PortProcessor.create(
      left,
      serializer,
      { onLogicalMessage: leftReceived, onDisconnect: vi.fn() },
      { maxFrameBytes: 512, maxMessageBytes: 8192 },
    );
    const rightProcessor = PortProcessor.create(
      right,
      serializer,
      { onLogicalMessage: rightReceived, onDisconnect: vi.fn() },
      { maxFrameBytes: 512, maxMessageBytes: 8192 },
    );
    const leftMessage = {
      ...sampleGetMessage,
      id: "left-large",
      path: ["left", "a".repeat(3000)],
    };
    const rightMessage = {
      ...sampleGetMessage,
      id: "right-large",
      path: ["right", "b".repeat(3000)],
    };

    const [leftSent, rightSent] = await Promise.all([
      leftProcessor.sendMessage(leftMessage),
      rightProcessor.sendMessage(rightMessage),
    ]);

    expect(leftSent.isOk()).toBe(true);
    expect(rightSent.isOk()).toBe(true);
    expect(leftReceived).toHaveBeenCalledExactlyOnceWith(rightMessage);
    expect(rightReceived).toHaveBeenCalledExactlyOnceWith(leftMessage);
    leftProcessor.close();
    rightProcessor.close();
  });

  it("does not accept a committed ACK before any DATA was submitted", async () => {
    const [port] = createMockPortPair();
    const onProtocolError = vi.fn();
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn(), onProtocolError },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );
    const sending = processor.sendMessage({
      ...sampleGetMessage,
      path: ["x".repeat(1024)],
    });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    const ack = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_ACK,
      id: 1,
      version: 1,
      offset: 0,
      committed: true,
    });
    expect(ack.isOk()).toBe(true);
    if (ack.isOk()) vi.mocked(port.onMessage).mock.calls[0]?.[0](ack.value);
    expect(onProtocolError).toHaveBeenCalledOnce();
    processor.close();

    const result = await sending;

    expect(result.isErr()).toBe(true);
  });

  it("terminates a transfer immediately when an ACK offset is not a sent boundary", async () => {
    const [port] = createMockPortPair();
    const onProtocolError = vi.fn();
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn(), onProtocolError },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );
    const sending = processor.sendMessage({
      ...sampleGetMessage,
      path: ["x".repeat(2048)],
    });
    const onRawMessage = vi.mocked(port.onMessage).mock.calls[0]?.[0];
    const startAck = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_ACK,
      id: 1,
      version: 1,
      offset: 0,
      committed: false,
    });
    expect(startAck.isOk()).toBe(true);
    if (startAck.isOk()) onRawMessage?.(startAck.value);
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(2));
    const invalidAck = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_ACK,
      id: 1,
      version: 1,
      offset: 511,
      committed: false,
    });
    expect(invalidAck.isOk()).toBe(true);
    if (invalidAck.isOk()) onRawMessage?.(invalidAck.value);

    const result = await sending;

    expect(result.isErr()).toBe(true);
    expect(onProtocolError).toHaveBeenCalledOnce();
  });

  it("ignores a delayed duplicate ACK after the sender has advanced its window", async () => {
    const [port] = createMockPortPair();
    const onProtocolError = vi.fn();
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn(), onProtocolError },
      { maxFrameBytes: 512, maxMessageBytes: 8192 },
    );
    vi.mocked(port.postMessage).mockResolvedValue(undefined);
    const receive = vi.mocked(port.onMessage).mock.calls[0]?.[0];
    const sending = processor.sendMessage({
      ...sampleGetMessage,
      path: ["x".repeat(5000)],
    });
    const ack = (offset: number, committed = false) => {
      const encoded = serializer.safeSerialize({
        type: NexusMessageType.CHUNK_ACK,
        id: 1,
        version: 1,
        offset,
        committed,
      });
      expect(encoded.isOk()).toBe(true);
      if (encoded.isOk()) receive?.(encoded.value);
    };

    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    ack(0);
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(5));
    const firstData = serializer.safeDeserialize(
      vi.mocked(port.postMessage).mock.calls[1]![0] as string,
    );
    expect(firstData.isOk()).toBe(true);
    if (
      firstData.isErr() ||
      firstData.value.type !== NexusMessageType.CHUNK_DATA
    )
      return;
    const advanced = firstData.value.offset + firstData.value.data.byteLength;
    ack(advanced);
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(6));
    const afterAdvance = vi.mocked(port.postMessage).mock.calls.length;

    ack(0);

    expect(port.postMessage).toHaveBeenCalledTimes(afterAdvance);
    expect(onProtocolError).not.toHaveBeenCalled();
    processor.close();
    await sending;
  });

  it("submits at most one four-frame DATA window before cumulative ACK", async () => {
    const [port] = createMockPortPair();
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
      { maxFrameBytes: 512, maxMessageBytes: 16 * 1024 },
    );
    vi.mocked(port.postMessage).mockResolvedValue(undefined);
    const receive = vi.mocked(port.onMessage).mock.calls[0]?.[0];
    const sending = processor.sendMessage({
      ...sampleGetMessage,
      path: ["x".repeat(10_000)],
    });
    const ack = (offset: number, committed = false) => {
      const encoded = serializer.safeSerialize({
        type: NexusMessageType.CHUNK_ACK,
        id: 1,
        version: 1,
        offset,
        committed,
      });
      if (encoded.isOk()) receive?.(encoded.value);
    };

    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    ack(0);
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(5));
    expect(
      vi.mocked(port.postMessage).mock.calls.filter(([packet]) => {
        const decoded = serializer.safeDeserialize(packet as string);
        return (
          decoded.isOk() && decoded.value.type === NexusMessageType.CHUNK_DATA
        );
      }),
    ).toHaveLength(4);
    const fourth = serializer.safeDeserialize(
      vi.mocked(port.postMessage).mock.calls[4]![0] as string,
    );
    expect(fourth.isOk()).toBe(true);
    if (fourth.isErr() || fourth.value.type !== NexusMessageType.CHUNK_DATA)
      return;
    ack(fourth.value.offset + fourth.value.data.byteLength);
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(9));
    processor.close();
    await sending;
  });

  it("times out before START acceptance, cancels once and releases the outbound reservation", async () => {
    vi.useFakeTimers();
    const [port] = createMockPortPair();
    let held = 0;
    const onProtocolError = vi.fn();
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn(), onProtocolError },
      {
        maxFrameBytes: 512,
        maxMessageBytes: 8192,
        timeoutMs: 10,
        reserveBytes: (bytes) => {
          held += bytes;
          return true;
        },
        releaseBytes: (bytes) => (held -= bytes),
      },
    );
    vi.mocked(port.postMessage).mockResolvedValue(undefined);
    const sending = processor.sendMessage({
      ...sampleGetMessage,
      path: ["x".repeat(2048)],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledOnce();
    expect(held).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(11);
    const result = await sending;

    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.context).toMatchObject({ reason: "timeout" });
    const packets = vi
      .mocked(port.postMessage)
      .mock.calls.map(([packet]) =>
        serializer.safeDeserialize(packet as string),
      );
    expect(
      packets.filter(
        (packet) =>
          packet.isOk() && packet.value.type === NexusMessageType.CHUNK_CANCEL,
      ),
    ).toHaveLength(1);
    expect(held).toBe(0);
    expect(onProtocolError).not.toHaveBeenCalled();
    processor.close();
    vi.useRealTimers();
  });

  it("closes the hop as uncertain when final DATA is submitted but its ACK is lost", async () => {
    vi.useFakeTimers();
    let receive!: (packet: string | ArrayBuffer) => void;
    const posted: string[] = [];
    let unackedFrames = 0;
    let acknowledgedOffset = 0;
    const onDisconnect = vi.fn();
    const port = {
      postMessage: vi.fn(async (packet: string | ArrayBuffer) => {
        posted.push(packet as string);
        const decoded = serializer.safeDeserialize(packet);
        if (decoded.isErr()) return;
        const message = decoded.value;
        if (message.type === NexusMessageType.CHUNK_START) {
          const ack = serializer.safeSerialize({
            type: NexusMessageType.CHUNK_ACK,
            id: message.id,
            version: 1,
            offset: 0,
            committed: false,
          });
          if (ack.isOk()) queueMicrotask(() => receive(ack.value));
        } else if (message.type === NexusMessageType.CHUNK_DATA) {
          const offset = message.offset + message.data.byteLength;
          unackedFrames++;
          if (offset < totalBytes && unackedFrames === 4) {
            unackedFrames = 0;
            acknowledgedOffset = offset;
            const ack = serializer.safeSerialize({
              type: NexusMessageType.CHUNK_ACK,
              id: message.id,
              version: 1,
              offset,
              committed: false,
            });
            if (ack.isOk()) queueMicrotask(() => receive(ack.value));
          } else if (offset < totalBytes) acknowledgedOffset = offset;
        }
      }),
      onMessage: (handler: typeof receive) => (receive = handler),
      onDisconnect: (handler: () => void) => handler,
      close: vi.fn(() => onDisconnect()),
      maxPacketBytes: 512,
    };
    const onProtocolError = vi.fn();
    let processor!: PortProcessor.Context;
    processor = PortProcessor.create(
      port,
      serializer,
      {
        onLogicalMessage: vi.fn(),
        onDisconnect,
        onProtocolError: (error) => {
          onProtocolError(error);
          processor.close();
        },
      },
      { maxFrameBytes: 512, maxMessageBytes: 4096, timeoutMs: 100 },
    );
    const large = { ...sampleGetMessage, path: ["x".repeat(1024)] };
    const encoded = serializer.safeSerialize(large);
    expect(encoded.isOk()).toBe(true);
    if (encoded.isErr()) return;
    const totalBytes = new TextEncoder().encode(encoded.value).byteLength;
    const sending = processor.sendMessage(large);
    await vi.waitFor(() => {
      expect(acknowledgedOffset).toBeGreaterThan(0);
      expect(
        posted.some((packet) => {
          const decoded = serializer.safeDeserialize(packet);
          return (
            decoded.isOk() &&
            decoded.value.type === NexusMessageType.CHUNK_DATA &&
            decoded.value.offset + decoded.value.data.byteLength === totalBytes
          );
        }),
      ).toBe(true);
    });
    expect(
      posted.some((packet) => {
        const decoded = serializer.safeDeserialize(packet);
        return (
          decoded.isOk() &&
          decoded.value.type === NexusMessageType.CHUNK_DATA &&
          decoded.value.offset + decoded.value.data.byteLength === totalBytes
        );
      }),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(101);
    const result = await sending;

    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.context).toMatchObject({
        code: "E_TRANSFER_UNCERTAIN",
      });
    expect(onProtocolError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ code: "E_TRANSFER_UNCERTAIN" }),
      }),
    );
    expect(onDisconnect).toHaveBeenCalledOnce();
    processor.close();
    vi.useRealTimers();
  });

  it("keeps an RPC response when final ACK times out and closes the broken hop", async () => {
    vi.useFakeTimers();
    let receive!: (packet: string | ArrayBuffer) => void;
    const posted: (string | ArrayBuffer)[] = [];
    let processor!: PortProcessor.Context;
    const pending = new PendingCallManager();
    let finalDataSubmitted = false;
    let notifyFinalSubmission!: () => void;
    const finalSubmission = new Promise<void>((resolve) => {
      notifyFinalSubmission = resolve;
    });
    const port = {
      postMessage: vi.fn(async (packet: string | ArrayBuffer) => {
        posted.push(packet);
        const decoded = serializer.safeDeserialize(packet);
        if (decoded.isErr()) return;
        const message = decoded.value;
        if (message.type === NexusMessageType.CHUNK_START) {
          const ack = serializer.safeSerialize({
            type: NexusMessageType.CHUNK_ACK,
            id: message.id,
            version: 1,
            offset: 0,
            committed: false,
          });
          if (ack.isOk()) queueMicrotask(() => receive(ack.value));
        } else if (message.type === NexusMessageType.CHUNK_DATA) {
          const offset = message.offset + message.data.byteLength;
          if (offset < totalBytes) {
            const ack = serializer.safeSerialize({
              type: NexusMessageType.CHUNK_ACK,
              id: message.id,
              version: 1,
              offset,
              committed: false,
            });
            if (ack.isOk()) queueMicrotask(() => receive(ack.value));
          }
          if (offset === totalBytes) {
            finalDataSubmitted = true;
            notifyFinalSubmission();
          }
        }
      }),
      onMessage: (handler: typeof receive) => (receive = handler),
      onDisconnect: () => {},
      close: vi.fn(),
      maxPacketBytes: 512,
    };
    const onDisconnect = vi.fn();
    processor = PortProcessor.create(
      port,
      serializer,
      {
        onLogicalMessage: (message) => {
          if (message.type === NexusMessageType.RES)
            pending.handleResponse(message.id, message.result, null, "A");
        },
        onDisconnect,
        onProtocolError: () => processor.close(),
      },
      { maxFrameBytes: 512, maxMessageBytes: 4096, timeoutMs: 100 },
    );
    const large = { ...sampleGetMessage, path: ["x".repeat(2_000)] };
    const encoded = serializer.safeSerialize(large);
    expect(encoded.isOk()).toBe(true);
    if (encoded.isErr()) return;
    const totalBytes = new TextEncoder().encode(encoded.value).byteLength;
    const calling = pending.register(1, { connectionId: "A", timeout: 1_000 });
    const sending = processor.sendMessage(large);
    await finalSubmission;
    expect(finalDataSubmitted).toBe(true);
    const response = serializer.safeSerialize({
      type: NexusMessageType.RES,
      id: 1,
      result: "response wins",
    });
    expect(response.isOk()).toBe(true);
    if (response.isOk()) receive(response.value);
    await vi.advanceTimersByTimeAsync(101);

    await expect(calling).resolves.toEqual(Result.ok("response wins"));
    expect((await sending).isErr()).toBe(true);
    expect(port.close).toHaveBeenCalledOnce();
    expect(
      posted.filter((packet) => {
        const decoded = serializer.safeDeserialize(packet);
        return (
          decoded.isOk() && decoded.value.type === NexusMessageType.CHUNK_START
        );
      }),
    ).toHaveLength(1);
    processor.close();
    vi.useRealTimers();
  });

  it("ignores late DATA below the terminal watermark and accepts the next START", () => {
    const [port] = createMockPortPair();
    const onProtocolError = vi.fn();
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn(), onProtocolError },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );
    const receive = vi.mocked(port.onMessage).mock.calls[0]?.[0];
    const start = (id: number) =>
      serializer.safeSerialize({
        type: NexusMessageType.CHUNK_START,
        id,
        version: 1,
        packetKind: NexusMessageType.GET,
        totalBytes: 128,
      });
    const cancel = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_CANCEL,
      id: 1,
      version: 1,
      reason: "cancelled",
    });
    const lateData = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_DATA,
      id: 1,
      version: 1,
      offset: 0,
      data: new Uint8Array([1]),
    });
    const nextStart = start(2);
    const firstStart = start(1);
    expect(
      [cancel, lateData, nextStart, firstStart].every((result) =>
        result.isOk(),
      ),
    ).toBe(true);
    if (
      cancel.isErr() ||
      lateData.isErr() ||
      nextStart.isErr() ||
      firstStart.isErr()
    )
      return;

    receive?.(firstStart.value);
    receive?.(cancel.value);
    receive?.(lateData.value);
    receive?.(nextStart.value);

    expect(onProtocolError).not.toHaveBeenCalled();
    expect(vi.mocked(port.postMessage)).toHaveBeenCalled();
    processor.close();
  });

  it("does not retract a packet when CANCEL races after receive commit", async () => {
    const [port] = createMockPortPair();
    const message = { ...sampleGetMessage, id: "commit-race" };
    const packet = serializer.safeSerialize(message);
    expect(packet.isOk()).toBe(true);
    if (packet.isErr()) return;
    const bytes = new TextEncoder().encode(packet.value);
    const delivered = vi.fn();
    const onProtocolError = vi.fn();
    const processor = PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: delivered, onDisconnect: vi.fn(), onProtocolError },
      { maxFrameBytes: 4096, maxMessageBytes: 8192 },
    );
    vi.mocked(port.postMessage).mockResolvedValue(undefined);
    const receive = vi.mocked(port.onMessage).mock.calls[0]?.[0];
    const start = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_START,
      id: 1,
      version: 1,
      packetKind: NexusMessageType.GET,
      totalBytes: bytes.byteLength,
    });
    const data = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_DATA,
      id: 1,
      version: 1,
      offset: 0,
      data: bytes,
    });
    expect(start.isOk() && data.isOk()).toBe(true);
    if (start.isErr() || data.isErr()) return;

    receive?.(start.value);
    receive?.(data.value);
    await vi.waitFor(() =>
      expect(delivered).toHaveBeenCalledExactlyOnceWith(message),
    );
    const cancel = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_CANCEL,
      id: 1,
      version: 1,
      reason: "cancelled",
    });
    expect(cancel.isOk()).toBe(true);
    if (cancel.isOk()) receive?.(cancel.value);
    expect(delivered).toHaveBeenCalledExactlyOnceWith(message);
    expect(onProtocolError).not.toHaveBeenCalled();
    processor.close();
  });

  it("reports final DATA native-submit failure as uncertain and terminates the port", async () => {
    const [port] = createMockPortPair();
    const failure = new Error("native DATA submit failed");
    const onProtocolError = vi.fn();
    const onDisconnect = vi.fn();
    let processor!: PortProcessor.Context;
    processor = PortProcessor.create(
      port,
      serializer,
      {
        onLogicalMessage: vi.fn(),
        onDisconnect,
        onProtocolError: (error) => {
          onProtocolError(error);
          processor.close();
        },
      },
      { maxFrameBytes: 512, maxMessageBytes: 4096 },
    );
    const large = {
      ...sampleGetMessage,
      path: ["x".repeat(1024)],
    };
    const encoded = serializer.safeSerialize(large);
    expect(encoded.isOk()).toBe(true);
    if (encoded.isErr()) return;
    const totalBytes = new TextEncoder().encode(encoded.value).byteLength;
    const receive = vi.mocked(port.onMessage).mock.calls[0]?.[0];
    vi.mocked(port.postMessage).mockImplementation(async (packet) => {
      const decoded = serializer.safeDeserialize(
        packet as string | ArrayBuffer,
      );
      if (
        decoded.isOk() &&
        decoded.value.type === NexusMessageType.CHUNK_DATA
      ) {
        const { data, offset } = decoded.value;
        const nextOffset = offset + data.byteLength;
        if (nextOffset >= totalBytes) throw failure;
        const ack = serializer.safeSerialize({
          type: NexusMessageType.CHUNK_ACK,
          id: 1,
          version: 1,
          offset: nextOffset,
          committed: false,
        });
        if (ack.isOk()) receive?.(ack.value);
      }
    });
    const sending = processor.sendMessage(large);
    const accepted = serializer.safeSerialize({
      type: NexusMessageType.CHUNK_ACK,
      id: 1,
      version: 1,
      offset: 0,
      committed: false,
    });
    expect(accepted.isOk()).toBe(true);
    if (accepted.isOk()) receive?.(accepted.value);
    const sent = await sending;

    expect(sent.isErr()).toBe(true);
    if (sent.isErr())
      expect(sent.error.context).toMatchObject({
        code: "E_TRANSFER_UNCERTAIN",
      });
    expect(onProtocolError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ code: "E_TRANSFER_UNCERTAIN" }),
      }),
    );
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("rejects an oversized native frame before deserializing it", () => {
    const [port] = createMockPortPair();
    const deserialize = vi.spyOn(serializer, "safeDeserialize");
    const onProtocolError = vi.fn();
    PortProcessor.create(
      port,
      serializer,
      { onLogicalMessage: vi.fn(), onDisconnect: vi.fn(), onProtocolError },
      { maxFrameBytes: 128 },
    );

    vi.mocked(port.onMessage).mock.calls[0]?.[0]("x".repeat(129));

    expect(onProtocolError).toHaveBeenCalledOnce();
    expect(deserialize).not.toHaveBeenCalled();
  });

  it("passes oversized binary packets end-to-end", async () => {
    const [port1, port2] = createMockPortPair();
    const binary = BinarySerializer.serializer;
    const handlers = {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
      onProtocolError: vi.fn(),
    };
    const sender = PortProcessor.create(
      port1,
      binary,
      {
        onLogicalMessage: vi.fn(),
        onDisconnect: vi.fn(),
        onProtocolError: vi.fn(),
      },
      { maxFrameBytes: 512 },
    );
    PortProcessor.create(port2, binary, handlers, {
      maxFrameBytes: 512,
    });

    const largeMessage: GetMessage = {
      ...sampleGetMessage,
      path: ["binary-long-path", "y".repeat(1024)],
    };

    const sendResult = await sender.sendMessage(largeMessage);
    expect(sendResult.isOk()).toBe(true);
    expect(vi.mocked(port1.postMessage).mock.calls.length).toBeGreaterThan(2);

    await vi.waitFor(() => {
      expect(handlers.onLogicalMessage).toHaveBeenCalledWith(largeMessage);
    });
    expect(handlers.onProtocolError).not.toHaveBeenCalled();
  });

  it("captures protocol errors for a 96 KiB binary RPC payload at the receiver", async () => {
    const [port1, port2] = createMockPortPair();
    const binary = BinarySerializer.serializer;
    const received = vi.fn();
    const onProtocolError = vi.fn();
    const receiver = PortProcessor.create(port2, binary, {
      onLogicalMessage: received,
      onDisconnect: vi.fn(),
      onProtocolError,
    });
    const sender = PortProcessor.create(port1, binary, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    });
    const payload = Uint8Array.from(
      { length: 96 * 1024 },
      (_, index) => index % 251,
    );
    const message = {
      ...sampleGetMessage,
      type: NexusMessageType.APPLY,
      args: [payload],
    } as ApplyMessage;

    const sending = sender.sendMessage(message);
    await vi.waitFor(() => {
      if (onProtocolError.mock.calls.length)
        throw new Error(
          JSON.stringify(onProtocolError.mock.calls[0]?.[0].context),
        );
      expect(received).toHaveBeenCalled();
    });

    const sent = await sending;
    expect(sent.isOk()).toBe(true);
    expect(onProtocolError).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledOnce();
    const actual = received.mock.calls[0]?.[0];
    expect(actual?.type).toBe(NexusMessageType.APPLY);
    if (actual?.type === NexusMessageType.APPLY) {
      const value = actual.args[0];
      expect(value).toMatchObject({ kind: "uint8-array" });
      if (value && typeof value === "object" && "bytes" in value)
        expect(value.bytes).toEqual(payload);
    }
    sender.close();
    receiver.close();
  });

  it("shares byte reservations across processors and releases them on settlement", async () => {
    const [firstPort, firstPeer] = createMockPortPair();
    const [secondPort, secondPeer] = createMockPortPair();
    let budget = 0;
    const reserveBytes = (bytes: number) => {
      if (budget + bytes > 3000) return false;
      budget += bytes;
      return true;
    };
    const releaseBytes = (bytes: number) => {
      budget -= bytes;
    };
    const options = {
      maxFrameBytes: 128,
      maxMessageBytes: 4096,
      maxBufferedBytes: 4096,
      reserveBytes,
      releaseBytes,
    };
    const peerOptions = {
      maxFrameBytes: 128,
      maxMessageBytes: 4096,
      maxBufferedBytes: 4096,
    };
    const noop = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
    const first = PortProcessor.create(
      firstPort,
      JsonSerializer.serializer,
      noop,
      options,
    );
    PortProcessor.create(
      firstPeer,
      JsonSerializer.serializer,
      noop,
      peerOptions,
    );
    const second = PortProcessor.create(
      secondPort,
      JsonSerializer.serializer,
      noop,
      options,
    );
    const secondReceiver = vi.fn();
    PortProcessor.create(
      secondPeer,
      JsonSerializer.serializer,
      { ...noop, onLogicalMessage: secondReceiver },
      peerOptions,
    );
    expect(reserveBytes(2950)).toBe(true);

    const largeMessage: GetMessage = {
      ...sampleGetMessage,
      path: ["x".repeat(400)],
    };
    const rejected = await second.sendMessage(largeMessage);
    expect(rejected.isErr()).toBe(true);
    expect(budget).toBe(2950);

    releaseBytes(2950);
    const accepted = await first.sendMessage(largeMessage);
    expect(accepted.isOk()).toBe(true);
    const retried = await second.sendMessage(largeMessage);
    expect(retried.isOk()).toBe(true);
    await vi.waitFor(() => expect(secondReceiver).toHaveBeenCalledOnce());
    expect(budget).toBe(0);
  });

  it("sends binary packets with transferable list", async () => {
    const [port1] = createMockPortPair();
    const processor = PortProcessor.create(port1, BinarySerializer.serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    });

    const sendResult = await processor.sendMessage(sampleGetMessage);
    expect(sendResult.isOk()).toBe(true);
    expect(port1.postMessage).toHaveBeenCalledOnce();

    const [packet, transfer] = vi.mocked(port1.postMessage).mock.calls[0] ?? [];
    expect(packet).toBeInstanceOf(ArrayBuffer);
    expect(transfer).toEqual([packet]);
  });

  it("preserves user payloads that match serializer marker shape", async () => {
    const [port1, port2] = createMockPortPair();
    const binary = BinarySerializer.serializer;
    const handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };

    const sender = PortProcessor.create(port1, binary, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    });
    PortProcessor.create(port2, binary, handlers);

    const markerLikePayload = {
      __nexus_array_buffer__: "user-defined-string",
      nested: { __nexus_array_buffer__: "nested-user-string" },
    };

    const markerMessage = {
      type: NexusMessageType.APPLY,
      id: "marker-case",
      resourceId: null,
      path: ["echo"],
      args: [markerLikePayload],
    };

    const sendResult = await sender.sendMessage(markerMessage);
    expect(sendResult.isOk()).toBe(true);

    await vi.waitFor(() => {
      expect(handlers.onLogicalMessage).toHaveBeenCalledWith(markerMessage);
    });
  });
});
