import { describe, expect, it } from "vitest";
import { BinarySerializer } from "./binary-serializer";
import { JsonSerializer } from "./json-serializer";
import {
  buildSerializerBenchmarkMessages,
  buildSerializerBenchmarkSummary,
  getSerializerBenchmarkCodecs,
  runSerializerBenchmark,
} from "./serializer-benchmark";
import { NexusMessageType } from "@/types/message";

describe("serializer benchmark scaffold", () => {
  it("covers Nexus message shapes required for codec decisions", () => {
    const cases = buildSerializerBenchmarkMessages();

    expect(cases.map((testCase) => testCase.name)).toEqual([
      "GET small",
      "APPLY small",
      "APPLY nested",
      "RES small",
      "RES large",
      "ERR",
      "BATCH 10",
      "BATCH 100",
      "HANDSHAKE_REQ",
      "HANDSHAKE_ACK",
      "CHUNK_DATA ArrayBuffer payload",
    ]);
  });

  it("uses a real binary-bearing message for binary payload coverage", () => {
    const binaryCase = buildSerializerBenchmarkMessages().find(
      (testCase) => testCase.name === "CHUNK_DATA ArrayBuffer payload",
    );

    expect(binaryCase?.message).toMatchObject({
      type: NexusMessageType.CHUNK_DATA,
      id: "chunk-binary-1",
      chunkIndex: 0,
    });
    expect(
      binaryCase?.message.type === NexusMessageType.CHUNK_DATA &&
        binaryCase.message.chunkData,
    ).toBeInstanceOf(ArrayBuffer);
  });

  it("throws a useful benchmark error when a serializer fails", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      runSerializerBenchmark({
        iterations: 1,
        serializers: [
          { name: "JsonSerializer", serializer: JsonSerializer.serializer },
        ],
        cases: [
          {
            name: "circular RES",
            message: {
              type: NexusMessageType.RES,
              id: "res-circular-1",
              result: circular,
            },
          },
        ],
      }),
    ).toThrow(/JsonSerializer failed to serialize circular RES/);
  });

  it("registers all proposal codec variants", () => {
    expect(getSerializerBenchmarkCodecs().map((codec) => codec.name)).toEqual([
      "JsonSerializer",
      "BinarySerializer",
      "msgpackr default",
      "msgpackr record structures",
      "@msgpack/msgpack",
    ]);
  });

  it("reports proposal metrics and environment notes for all serializers", () => {
    const results = runSerializerBenchmark({ iterations: 1 });

    expect(results).toHaveLength(55);
    expect(results.map((result) => result.serializer)).toContain(
      "JsonSerializer",
    );
    expect(results.map((result) => result.serializer)).toContain(
      "BinarySerializer",
    );
    expect(results.every((result) => result.encodedBytes > 0)).toBe(true);
    expect(results.every((result) => result.encodeMs >= 0)).toBe(true);
    expect(results.every((result) => result.decodeMs >= 0)).toBe(true);
    expect(results.every((result) => result.roundtripMs >= 0)).toBe(true);
    expect(results.every((result) => result.serializeOpsPerSec > 0)).toBe(true);
    expect(results.every((result) => result.deserializeOpsPerSec > 0)).toBe(
      true,
    );
    expect(results.every((result) => result.roundtripOpsPerSec > 0)).toBe(true);
    expect(
      results.every((result) =>
        ["not-measured", "increase", "flat", "decrease"].includes(
          result.memoryAllocationTrend,
        ),
      ),
    ).toBe(true);

    const summary = buildSerializerBenchmarkSummary(results);
    expect(summary.nodeVersion).toBe(process.version);
    expect(summary.browserBundleSizeNote).toMatch(/not measured/i);
    expect(summary.cspImpact).toMatch(/eval/i);
  });

  it("keeps BinarySerializer byte length equal to UTF-8 compact JSON packet length", () => {
    const message = buildSerializerBenchmarkMessages()[0]!.message;
    const jsonPacket = JsonSerializer.safeSerialize(message)._unsafeUnwrap();
    const binaryPacket =
      BinarySerializer.safeSerialize(message)._unsafeUnwrap();

    expect(binaryPacket).toBeInstanceOf(ArrayBuffer);
    if (!(binaryPacket instanceof ArrayBuffer)) {
      throw new Error("Expected BinarySerializer to return ArrayBuffer");
    }
    expect(binaryPacket.byteLength).toBe(
      new TextEncoder().encode(jsonPacket as string).byteLength,
    );
  });
});
