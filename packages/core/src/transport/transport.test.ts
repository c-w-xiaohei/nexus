import { describe, it, expect, vi, beforeEach } from "vitest";
import { Transport } from "./transport";
import { createMockPortPair } from "../utils/test-utils";
import type { IEndpoint } from "./types/endpoint";
import { NexusMessageType } from "@/types/message";

describe("Transport", () => {
  let mockEndpoint: IEndpoint<any, any>;

  beforeEach(() => {
    mockEndpoint = {
      connect: vi.fn(async (): Promise<[any, any]> => {
        const [port] = createMockPortPair();
        return [port, { from: "mock" }];
      }),
      listen: vi.fn(),
      capabilities: { supportsTransferables: false },
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
    it("uses endpoint.connect and returns processor with metadata", async () => {
      const [port1] = createMockPortPair();
      const mockRemoteMetadata = { source: "remote-endpoint" };
      vi.mocked(mockEndpoint.connect!).mockResolvedValue([
        port1,
        mockRemoteMetadata,
      ]);

      const transport = Transport.create(mockEndpoint);
      const handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
      const target = { context: "test-target" };

      const result = await Transport.safeConnect(transport, target, handlers);

      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        return;
      }
      const [processor, platformMetadata] = result.value;

      expect(mockEndpoint.connect).toHaveBeenCalledWith(target);
      expect(platformMetadata).toEqual(mockRemoteMetadata);
      expect(typeof processor.sendMessage).toBe("function");
      expect(typeof processor.close).toBe("function");
    });

    it("returns capability error when connect is missing", async () => {
      const endpointWithoutConnect = {
        connect: undefined,
        listen: vi.fn(),
        capabilities: { supportsTransferables: false },
      } as unknown as IEndpoint<any, any>;

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
