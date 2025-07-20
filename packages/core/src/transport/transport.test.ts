import { describe, it, expect, vi, beforeEach } from "vitest";
import { Transport } from "./transport";
import { createMockPortPair } from "../utils/test-utils";
import type { IEndpoint } from "./types/endpoint";
import { PortProcessor } from "./port-processor";
import { JsonSerializer } from "./serializers/json-serializer";
import { BinarySerializer } from "./serializers/binary-serializer";

describe("Transport", () => {
  let mockEndpoint: IEndpoint<any, any>;

  beforeEach(() => {
    // 为每个测试重置 mockEndpoint
    mockEndpoint = {
      connect: vi.fn(async (): Promise<[any, any]> => {
        const [port] = createMockPortPair();
        return [port, { from: "mock" }];
      }),
      listen: vi.fn(),
      capabilities: { supportsTransferables: false },
    };
  });

  it("should select JsonSerializer when transferables are not supported", () => {
    const transport = new Transport(mockEndpoint);
    // @ts-expect-error accessing private property for testing
    expect(transport.serializer).toBeInstanceOf(JsonSerializer);
  });

  it("should select BinarySerializer when transferables are supported", () => {
    mockEndpoint.capabilities = { supportsTransferables: true };
    const transport = new Transport(mockEndpoint);
    // @ts-expect-error accessing private property for testing
    expect(transport.serializer).toBeInstanceOf(BinarySerializer);
  });

  describe("connect (active connection)", () => {
    it("should use endpoint.connect and return a PortProcessor and metadata", async () => {
      const [port1] = createMockPortPair();
      const mockRemoteMetadata = { source: "remote-endpoint" };
      // 模拟 endpoint.connect 成功建立连接，并返回一个元组
      vi.mocked(mockEndpoint.connect!).mockResolvedValue([
        port1,
        mockRemoteMetadata,
      ]);

      const transport = new Transport(mockEndpoint);
      const handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
      const target = { context: "test-target" };

      // transport.connect 返回一个元组，我们需要解构它
      const [processor, platformMetadata] = await transport.connect(
        target,
        handlers
      );

      // 验证调用了 endpoint.connect
      expect(mockEndpoint.connect).toHaveBeenCalledWith(target);
      // 验证返回的是一个 PortProcessor 实例
      expect(processor).toBeInstanceOf(PortProcessor);
      // 验证元数据被正确地传递回来
      expect(platformMetadata).toEqual(mockRemoteMetadata);
    });
  });

  describe("listen (passive connection)", () => {
    it("should use endpoint.listen and forward arguments to L2's handler", () => {
      const transport = new Transport(mockEndpoint);
      const onConnectL2 = vi.fn(); // L2's onConnect handler

      transport.listen(onConnectL2);

      expect(mockEndpoint.listen).toHaveBeenCalledOnce();
      const onConnectL1 = vi.mocked(mockEndpoint.listen!).mock.calls[0][0];
      expect(onConnectL1).toBeInstanceOf(Function);

      // --- Case 1: Simulate a connection with metadata ---
      const [port1] = createMockPortPair();
      const mockMetadata = { source: "test" };
      onConnectL1(port1, mockMetadata);

      // Assert L2's handler was called with a factory and metadata
      expect(onConnectL2).toHaveBeenCalledWith(
        expect.any(Function),
        mockMetadata
      );

      // --- Case 2: Simulate a connection without metadata ---
      const [port2] = createMockPortPair();
      onConnectL1(port2); // No metadata

      // Assert L2's handler was called with a factory and undefined metadata
      expect(onConnectL2).toHaveBeenCalledWith(expect.any(Function), undefined);

      expect(onConnectL2).toHaveBeenCalledTimes(2);

      // --- Verify the factory function works ---
      const createProcessor = onConnectL2.mock.calls[0][0];
      expect(createProcessor).toBeInstanceOf(Function);
      const l2Handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
      const processor = createProcessor(l2Handlers);
      expect(processor).toBeInstanceOf(PortProcessor);
    });
  });
});
