import { describe, it, expect, vi } from "vitest";
import { PortProcessor } from "@/transport/port-processor";
import { JsonSerializer } from "@/transport/serializers/json-serializer";
import { createMockPortPair } from "../utils/test-utils";
import type { GetMessage } from "@/types/message";
import { NexusMessageType } from "@/types/message";

describe("PortProcessor", () => {
  const serializer = new JsonSerializer();
  const sampleGetMessage: GetMessage = {
    type: NexusMessageType.GET,
    id: "req-1",
    resourceId: "serviceA",
    path: ["methodB"],
  };

  it("should serialize and send a logical message via the underlying port", () => {
    const [port1] = createMockPortPair();
    const handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
    const processor = new PortProcessor(port1, serializer, handlers);

    processor.sendMessage(sampleGetMessage);

    // 验证 postMessage 被调用
    expect(port1.postMessage).toHaveBeenCalledOnce();
    // 验证发送的是序列化后的数据
    expect(port1.postMessage).toHaveBeenCalledWith(
      serializer.serialize(sampleGetMessage)
    );
  });

  it("should receive, deserialize, and forward a raw message", async () => {
    const [port1, port2] = createMockPortPair();
    const handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
    new PortProcessor(port1, serializer, handlers);

    // 模拟 port2 发送一个原始数据包
    const rawPacket = serializer.serialize(sampleGetMessage);
    port2.postMessage(rawPacket);

    // 等待异步消息传递完成
    await vi.waitFor(() => {
      expect(handlers.onLogicalMessage).toHaveBeenCalledOnce();
    });
    // 验证收到的逻辑消息与原始消息完全一致
    expect(handlers.onLogicalMessage).toHaveBeenCalledWith(sampleGetMessage);
  });

  it("should forward disconnect events to its handler", () => {
    const [port1, port2] = createMockPortPair();
    const handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
    new PortProcessor(port1, serializer, handlers);

    // 模拟端口断开
    port2.close();

    expect(handlers.onDisconnect).toHaveBeenCalledOnce();
  });

  it("should call close on the underlying port", () => {
    const [port1] = createMockPortPair();
    const handlers = { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() };
    const processor = new PortProcessor(port1, serializer, handlers);

    processor.close();

    expect(port1.close).toHaveBeenCalledOnce();
  });
});
