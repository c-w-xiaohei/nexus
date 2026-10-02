import { describe, it, expect, vi, beforeEach } from "vitest";
import { Transport } from "./transport";
import { resolveTransportConfig } from "./transport-config";
import { createMockPortPair } from "../utils/test-utils";
import type { IEndpoint } from "./types/endpoint";
import { NexusMessageType } from "@/types/message";
import type { AdapterModel } from "@/types/adapter-model";
import {
  NexusEndpointCapabilityError,
  NexusEndpointConnectError,
} from "@/errors";

interface TestAdapterModel extends AdapterModel {
  contextMeta: { context: string };
  connectionMeta: { source: string };
  connectionTarget: { context: string };
}

describe("Transport", () => {
  let mockEndpoint: IEndpoint<TestAdapterModel>;

  beforeEach(() => {
    mockEndpoint = {
      connect: vi.fn(async () => {
        const [port] = createMockPortPair();
        return { port, connectionMeta: { source: "mock" } };
      }),
      listen: vi.fn(),
      capabilities: { supportsTransferables: false },
      matchesTarget: () => true,
    };
  });

  it("uses JSON serializer when binary packets are unsupported", () => {
    const transport = Transport.create(mockEndpoint);
    const packet = transport.serializer.safeSerialize({
      type: NexusMessageType.RELEASE,
      id: null,
      resourceId: "resource-1",
    });
    expect(packet.isOk()).toBe(true);
    if (packet.isOk()) {
      expect(typeof packet.value).toBe("string");
    }
  });

  it("shares the configured buffer budget across all endpoint processors", () => {
    mockEndpoint.config = Object.freeze({
      binaryPackets: false,
      maxFrameBytes: 64 * 1024,
      maxMessageBytes: 16 * 1024 * 1024,
      maxBufferedBytes: 64 * 1024 * 1024,
    });
    const transport = Transport.create(mockEndpoint);
    expect(transport.reserveBytes(64 * 1024 * 1024)).toBe(true);
    expect(transport.reserveBytes(1)).toBe(false);
    transport.releaseBytes(64 * 1024 * 1024);
    expect(transport.reserveBytes(64 * 1024 * 1024)).toBe(true);
    transport.releaseBytes(64 * 1024 * 1024);
  });

  it("snapshots endpoint transport policy without freezing the caller's object", () => {
    const supplied = {
      binaryPackets: false,
      maxFrameBytes: 1024,
      maxMessageBytes: 4096,
      maxBufferedBytes: 8192,
    };
    mockEndpoint.config = supplied;
    const context = Transport.create(mockEndpoint);
    supplied.maxFrameBytes = 2048;
    expect(context.config.maxFrameBytes).toBe(1024);
    expect(Object.isFrozen(context.config)).toBe(true);
    expect(Object.isFrozen(supplied)).toBe(false);
  });

  it("accepts listen implementations that return a platform handle", async () => {
    const close = vi.fn();
    mockEndpoint.listen = async () => ({ close });

    const result = await Transport.safeListen(
      Transport.create(mockEndpoint),
      () => {},
    );
    expect(result.isOk()).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it("uses binary serializer when binary packets are supported", () => {
    mockEndpoint.capabilities = {
      binaryPackets: true,
      transferables: false,
    };
    const transport = Transport.create(mockEndpoint);
    const packet = transport.serializer.safeSerialize({
      type: NexusMessageType.RELEASE,
      id: null,
      resourceId: "resource-1",
    });
    expect(packet.isOk()).toBe(true);
    if (packet.isOk()) {
      expect(packet.value).toBeInstanceOf(ArrayBuffer);
    }
  });

  it("uses JSON serializer when binary packets are disabled even if transferables are true", () => {
    mockEndpoint.capabilities = {
      binaryPackets: false,
      transferables: true,
    };
    const transport = Transport.create(mockEndpoint);
    const packet = transport.serializer.safeSerialize({
      type: NexusMessageType.RELEASE,
      id: null,
      resourceId: "resource-1",
    });
    expect(packet.isOk()).toBe(true);
    if (packet.isOk()) {
      expect(typeof packet.value).toBe("string");
    }
  });

  it("does not transfer binary packets when an endpoint lacks transferable support", async () => {
    mockEndpoint.config = Object.freeze({
      binaryPackets: true,
      maxFrameBytes: 64 * 1024,
      maxMessageBytes: 16 * 1024 * 1024,
      maxBufferedBytes: 64 * 1024 * 1024,
    });
    mockEndpoint.capabilities = { binaryPackets: true, transferables: false };
    const transport = Transport.create(mockEndpoint);
    const [port] = createMockPortPair();
    mockEndpoint.connect = vi.fn(async () => ({ port, connectionMeta: {} }));
    const connected = await Transport.safeConnect(transport, {} as never, {
      onLogicalMessage: vi.fn(),
      onDisconnect: vi.fn(),
    });
    expect(connected.isOk()).toBe(true);
    if (connected.isErr()) return;

    expect(
      (
        await connected.value.portProcessor.sendMessage({
          type: NexusMessageType.RELEASE,
          id: null,
          resourceId: "resource-1",
        })
      ).isOk(),
    ).toBe(true);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      undefined,
      undefined,
    );
    connected.value.portProcessor.close();
  });

  it("takes JSON bootstrap policy from the endpoint instead of physical transferability", () => {
    mockEndpoint.config = Object.freeze({
      binaryPackets: true,
      maxFrameBytes: 64 * 1024,
      maxMessageBytes: 16 * 1024 * 1024,
      maxBufferedBytes: 64 * 1024 * 1024,
    });
    mockEndpoint.capabilities = { binaryPackets: true, transferables: true };
    expect(Transport.create(mockEndpoint).bootstrapJson).toBe(false);
    mockEndpoint.bootstrapJson = true;
    expect(Transport.create(mockEndpoint).bootstrapJson).toBe(true);
  });

  it("uses binary serializer for legacy supportsTransferables capability", () => {
    mockEndpoint.capabilities = { supportsTransferables: true };
    const transport = Transport.create(mockEndpoint);
    const packet = transport.serializer.safeSerialize({
      type: NexusMessageType.RELEASE,
      id: null,
      resourceId: "resource-1",
    });
    expect(packet.isOk()).toBe(true);
    if (packet.isOk()) {
      expect(packet.value).toBeInstanceOf(ArrayBuffer);
    }
  });

  describe("connect", () => {
    it("closes a port when processor subscription fails", async () => {
      const subscriptionError = new Error("subscription failed");
      const close = vi.fn();
      mockEndpoint.connect = async () => ({
        port: {
          postMessage: vi.fn(),
          onDisconnect: vi.fn(),
          close,
          onMessage: () => {
            throw subscriptionError;
          },
        },
        connectionMeta: { source: "test" },
      });
      const result = await Transport.safeConnect(
        Transport.create(mockEndpoint),
        { context: "test" },
        {
          onLogicalMessage: vi.fn(),
          onDisconnect: vi.fn(),
        },
      );
      expect(result).toMatchObject({
        error: {
          code: "E_ENDPOINT_CONNECT_FAILED",
          cause: {
            name: "Error",
            code: "E_UNKNOWN",
            message: "subscription failed",
          },
        },
      });
      expect(close).toHaveBeenCalledOnce();
    });

    it("uses endpoint.connect and returns processor with metadata", async () => {
      const [port1] = createMockPortPair();
      const mockRemoteMetadata = { source: "remote-endpoint" };
      vi.mocked(mockEndpoint.connect!).mockResolvedValue({
        port: port1,
        connectionMeta: mockRemoteMetadata,
      });

      const transport = Transport.create(mockEndpoint);
      const handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
      const target = { context: "test-target" };

      const result = await Transport.safeConnect(transport, target, handlers);

      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        return;
      }
      const { portProcessor: processor, connectionMeta } = result.value;

      expect(mockEndpoint.connect).toHaveBeenCalledWith(target);
      expect(connectionMeta).toEqual(mockRemoteMetadata);
      expect(typeof processor.sendMessage).toBe("function");
      expect(typeof processor.close).toBe("function");
    });

    it("returns capability error when connect is missing", async () => {
      const endpointWithoutConnect = {
        connect: undefined,
        listen: vi.fn(),
        capabilities: { supportsTransferables: false },
      } as unknown as IEndpoint<TestAdapterModel>;

      const transport = Transport.create(endpointWithoutConnect);
      const result = await Transport.safeConnect(
        transport,
        { context: "test-target" },
        { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("E_ENDPOINT_CAPABILITY_MISMATCH");
      }
    });

    it("preserves a synchronous structured endpoint error", async () => {
      const error = new NexusEndpointCapabilityError("unsupported");
      mockEndpoint.connect = vi.fn(() => {
        throw error;
      });

      const result = await Transport.safeConnect(
        Transport.create(mockEndpoint),
        { context: "test-target" },
        { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
      );

      expect(result.error).toBe(error);
    });

    it("preserves an asynchronously rejected structured endpoint error", async () => {
      const error = new NexusEndpointConnectError("unreachable");
      mockEndpoint.connect = vi.fn(() => Promise.reject(error));

      const result = await Transport.safeConnect(
        Transport.create(mockEndpoint),
        { context: "test-target" },
        { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
      );

      expect(result.error).toBe(error);
    });
  });

  describe("listen", () => {
    it("forwards connections to L2 factory callback", async () => {
      const transport = Transport.create(mockEndpoint);
      const onConnectL2 = vi.fn();

      const listenResult = await Transport.safeListen(transport, onConnectL2);
      expect(listenResult.isOk()).toBe(true);

      expect(mockEndpoint.listen).toHaveBeenCalledOnce();
      const onConnectL1 = vi.mocked(mockEndpoint.listen!).mock.calls[0][0];

      const [port1] = createMockPortPair();
      const mockMetadata = { source: "test" };
      onConnectL1(port1, mockMetadata);

      expect(onConnectL2).toHaveBeenCalledWith(
        expect.any(Function),
        mockMetadata,
      );

      const createProcessor = onConnectL2.mock.calls[0][0];
      const processor = createProcessor({
        onLogicalMessage: vi.fn(),
        onDisconnect: vi.fn(),
      });
      expect(typeof processor.sendMessage).toBe("function");
      expect(typeof processor.close).toBe("function");
    });

    it("returns async listen startup failures", async () => {
      const startupError = new Error("bind failed");
      mockEndpoint.listen = vi.fn(() => Promise.reject(startupError));
      const transport = Transport.create(mockEndpoint);

      const result = await Transport.safeListen(transport, () => {});

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.context?.originalError).toBe(startupError);
      }
    });
  });
});

describe("resolveTransportConfig", () => {
  it("copies and freezes common defaults with the adapter's packet mode", () => {
    const input = { maxFrameBytes: 1024 };
    const config = resolveTransportConfig(input, false);
    input.maxFrameBytes = 2048;
    expect(config).toEqual({
      binaryPackets: false,
      maxFrameBytes: 1024,
      maxMessageBytes: 16 * 1024 * 1024,
      maxBufferedBytes: 64 * 1024 * 1024,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it.each([
    [{ maxFrameBytes: 0 }, "maxFrameBytes"],
    [{ maxMessageBytes: 1.5 }, "maxMessageBytes"],
    [{ maxBufferedBytes: Number.MAX_SAFE_INTEGER + 1 }, "maxBufferedBytes"],
  ])("rejects invalid common limit %s", (input, key) => {
    expect(() => resolveTransportConfig(input, true)).toThrow(
      `transport.${key}`,
    );
  });

  it("rejects a buffer limit below the message limit", () => {
    expect(() =>
      resolveTransportConfig(
        { maxMessageBytes: 2048, maxBufferedBytes: 1024 },
        true,
      ),
    ).toThrow("transport.maxBufferedBytes must be at least maxMessageBytes.");
  });

  it("rejects a configured message limit beyond the finite codec ceiling", () => {
    expect(() =>
      resolveTransportConfig({ maxMessageBytes: 16 * 1024 * 1024 + 1 }, true),
    ).toThrow();
  });

  it("does not accept packet mode as a transport limit", () => {
    expect(() =>
      resolveTransportConfig({ binaryPackets: false } as never, false),
    ).toThrow("transport.binaryPackets is not a transport limit.");
  });
});
