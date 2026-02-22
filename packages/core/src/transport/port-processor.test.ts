import { describe, it, expect, vi } from "vitest";
import { PortProcessor } from "@/transport/port-processor";
import { JsonSerializer } from "@/transport/serializers/json-serializer";
import { BinarySerializer } from "@/transport/serializers/binary-serializer";
import { createMockPortPair } from "../utils/test-utils";
import type { GetMessage } from "@/types/message";
import { NexusMessageType } from "@/types/message";
import type { ISerializer } from "./serializers/interface";
import { err, ok } from "neverthrow";
import { NexusProtocolError } from "@/errors";

describe("PortProcessor", () => {
  const serializer = JsonSerializer.serializer;
  const sampleGetMessage: GetMessage = {
    type: NexusMessageType.GET,
    id: "req-1",
    resourceId: "serviceA",
    path: ["methodB"],
  };

  it("serializes and sends logical message", () => {
    const [port1] = createMockPortPair();
    const processor = PortProcessor.create(port1, serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    });

    const sendResult = processor.sendMessage(sampleGetMessage);

    expect(sendResult.isOk()).toBe(true);
    expect(port1.postMessage).toHaveBeenCalledOnce();
    const serialized = serializer.safeSerialize(sampleGetMessage);
    expect(serialized.isOk()).toBe(true);
    if (serialized.isOk()) {
      expect(port1.postMessage).toHaveBeenCalledWith(
        serialized.value,
        undefined,
      );
    }
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
      { chunkSize: 64 },
    );
    PortProcessor.create(port2, serializer, handlers, { chunkSize: 64 });

    const largeMessage: GetMessage = {
      ...sampleGetMessage,
      path: ["very-long-path", "x".repeat(1024)],
    };

    const sendResult = sender.sendMessage(largeMessage);
    expect(sendResult.isOk()).toBe(true);

    await vi.waitFor(() => {
      expect(handlers.onLogicalMessage).toHaveBeenCalledWith(largeMessage);
    });
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
      { chunkSize: 256 },
    );
    PortProcessor.create(port2, binary, handlers, { chunkSize: 256 });

    const largeMessage: GetMessage = {
      ...sampleGetMessage,
      path: ["binary-long-path", "y".repeat(1024)],
    };

    const sendResult = sender.sendMessage(largeMessage);
    expect(sendResult.isOk()).toBe(true);

    await vi.waitFor(() => {
      expect(handlers.onLogicalMessage).toHaveBeenCalledWith(largeMessage);
    });
    expect(handlers.onProtocolError).not.toHaveBeenCalled();
  });

  it("sends binary packets with transferable list", () => {
    const [port1] = createMockPortPair();
    const processor = PortProcessor.create(port1, BinarySerializer.serializer, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    });

    const sendResult = processor.sendMessage(sampleGetMessage);
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

    const sendResult = sender.sendMessage(markerMessage);
    expect(sendResult.isOk()).toBe(true);

    await vi.waitFor(() => {
      expect(handlers.onLogicalMessage).toHaveBeenCalledWith(markerMessage);
    });
  });
});
