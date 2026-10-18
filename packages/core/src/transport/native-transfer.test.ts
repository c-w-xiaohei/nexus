import { describe, expect, it, vi } from "vitest";
import { PortProcessor } from "./port-processor";
import { JsonSerializer } from "./serializers/json-serializer";
import {
  createBinaryValue,
  decodeBinaryValue,
} from "../service/payload/binary-value";
import { NexusMessageType } from "../types/message";
import {
  prepareNativePacket,
  decodeNativePacket,
} from "./serializers/native-attachments";

const message = (buffer: ArrayBuffer) => ({
  type: NexusMessageType.RES as const,
  id: 1,
  result: createBinaryValue(
    "array-buffer",
    new Uint8Array(buffer),
    undefined,
    true,
  ),
});

describe("native attachment submission", () => {
  it("cancels a queued transfer before native submission and releases its reservations", async () => {
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const postMessage = vi.fn(async (_packet: unknown) => {
      began();
      await pending;
    });
    let reserved = 0;
    const processor = PortProcessor.create(
      { postMessage, onMessage() {}, onDisconnect() {}, close() {} },
      JsonSerializer.serializer,
      { onLogicalMessage() {}, onDisconnect() {} },
      {
        arrayBufferTransfer: true,
        reserveBytes: (bytes) => {
          reserved += bytes;
          return true;
        },
        releaseBytes: (bytes) => {
          reserved -= bytes;
        },
      },
    );
    processor.activateSession!({
      maxFrameBytes: 65536,
      maxMessageBytes: 16 * 1024 * 1024,
      arrayBufferTransfer: true,
    });
    const first = processor.sendMessage({
      type: NexusMessageType.RES,
      id: 0,
      result: 1,
    });
    await started;
    const buffer = new ArrayBuffer(4);
    const abort = new AbortController();
    const queued = processor.sendMessage(message(buffer), {
      signal: abort.signal,
    });
    abort.abort();
    finish();
    expect((await first).isOk()).toBe(true);
    expect((await queued).isErr()).toBe(true);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(buffer.byteLength).toBe(4);
    expect(reserved).toBe(0);
    processor.close();
  });

  it("reports native failure as uncertain without retrying or reading detached lengths", async () => {
    let reserved = 0;
    const source = new ArrayBuffer(4);
    const postMessage = vi.fn((packet, transfer) => {
      structuredClone(packet, { transfer });
      throw new Error("failed after submission");
    });
    const processor = PortProcessor.create(
      { postMessage, onMessage() {}, onDisconnect() {}, close() {} },
      JsonSerializer.serializer,
      { onLogicalMessage() {}, onDisconnect() {} },
      {
        arrayBufferTransfer: true,
        reserveBytes: (bytes) => {
          reserved += bytes;
          return true;
        },
        releaseBytes: (bytes) => {
          reserved -= bytes;
        },
      },
    );
    processor.activateSession!({
      maxFrameBytes: 65536,
      maxMessageBytes: 16 * 1024 * 1024,
      arrayBufferTransfer: true,
    });
    expect(await processor.sendMessage(message(source))).toMatchObject({
      error: {
        code: "E_PROTOCOL_ERROR",
        context: { transferOutcome: "uncertain" },
      },
    });
    expect(source.byteLength).toBe(0);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(reserved).toBe(0);
    processor.close();
  });

  it("validates metadata and never imports the sender's ownership policy", () => {
    const source = new Uint8Array([5, 6]).buffer;
    const packet = prepareNativePacket(message(source)).unwrap()!;
    const received = structuredClone(packet, { transfer: packet.buffers });
    const decoded = decodeNativePacket(received).unwrap();
    expect(decoded.type).toBe(NexusMessageType.RES);
    if (decoded.type !== NexusMessageType.RES)
      throw new Error("wrong response");
    expect(decoded.result.transfer).toBe(false);
    expect(decodeBinaryValue(decoded.result)).toBe(received.buffers[0]);
    const metadata = JSON.parse(received.metadata);
    metadata.attachments[0].length++;
    expect(
      decodeNativePacket({
        ...received,
        metadata: JSON.stringify(metadata),
      }).isErr(),
    ).toBe(true);
    expect(
      decodeNativePacket({
        ...received,
        buffers: [...received.buffers, new ArrayBuffer(1)],
      }).isErr(),
    ).toBe(true);
  });
});
