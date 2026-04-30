import type { ISerializer } from "./interface";
import { BinarySerializer } from "./binary-serializer";
import { JsonSerializer } from "./json-serializer";
import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import {
  decode as msgpackDecode,
  encode as msgpackEncode,
} from "@msgpack/msgpack";
import { Packr } from "msgpackr";
import { NexusProtocolError } from "@/errors/transport-errors";
import {
  NexusMessageType,
  type ApplyMessage,
  type NexusMessage,
} from "@/types/message";

export type SerializerBenchmarkCase = {
  name: string;
  message: NexusMessage;
};

export type SerializerBenchmarkResult = {
  serializer: string;
  caseName: string;
  encodedBytes: number;
  encodeMs: number;
  decodeMs: number;
  roundtripMs: number;
  serializeOpsPerSec: number;
  deserializeOpsPerSec: number;
  roundtripOpsPerSec: number;
  memoryAllocationTrend: "not-measured" | "increase" | "flat" | "decrease";
};

export type SerializerBenchmarkSummary = {
  results: SerializerBenchmarkResult[];
  nodeVersion: string;
  browserBundleSizeNote: string;
  cspImpact: string;
};

type SerializerBenchmarkOptions = {
  iterations?: number;
  serializers?: NamedSerializer[];
  cases?: SerializerBenchmarkCase[];
};

type NamedSerializer = {
  name: string;
  serializer: ISerializer;
};

const currentSerializers: NamedSerializer[] = [
  { name: "JsonSerializer", serializer: JsonSerializer.serializer },
  { name: "BinarySerializer", serializer: BinarySerializer.serializer },
  { name: "msgpackr default", serializer: createMsgpackrSerializer(false) },
  {
    name: "msgpackr record structures",
    serializer: createMsgpackrSerializer(true),
  },
  { name: "@msgpack/msgpack", serializer: createMsgpackSerializer() },
];

export const getSerializerBenchmarkCodecs = (): readonly NamedSerializer[] =>
  currentSerializers;

export const buildSerializerBenchmarkMessages =
  (): SerializerBenchmarkCase[] => {
    const buildApply = (index: number): ApplyMessage => ({
      type: NexusMessageType.APPLY,
      id: `batch-${index}`,
      resourceId: null,
      path: ["jobs", "run"],
      args: [{ input: `job-${index}`, priority: index % 5 }],
    });

    return [
      {
        name: "GET small",
        message: {
          type: NexusMessageType.GET,
          id: "get-1",
          resourceId: "service:settings",
          path: ["theme"],
        },
      },
      {
        name: "APPLY small",
        message: {
          type: NexusMessageType.APPLY,
          id: "apply-1",
          resourceId: null,
          path: ["echo"],
          args: ["hello"],
        },
      },
      {
        name: "APPLY nested",
        message: {
          type: NexusMessageType.APPLY,
          id: "apply-nested-1",
          resourceId: "service:job",
          path: ["runJob"],
          args: [
            {
              cwd: "/repo",
              command: "pnpm test",
              env: { CI: "1" },
              callbacks: [{ type: "ref", resourceId: "callback:progress" }],
            },
          ],
        },
      },
      {
        name: "RES small",
        message: {
          type: NexusMessageType.RES,
          id: "res-1",
          result: "ok",
        },
      },
      {
        name: "RES large",
        message: {
          type: NexusMessageType.RES,
          id: "res-large-1",
          result: Array.from({ length: 128 }, (_, index) => ({
            id: index,
            value: `value-${index}`,
            tags: ["alpha", "beta", "gamma"],
          })),
        },
      },
      {
        name: "ERR",
        message: {
          type: NexusMessageType.ERR,
          id: "err-1",
          error: {
            name: "NexusRemoteError",
            code: "E_REMOTE_CALL_FAILED",
            message: "Remote call failed",
            stack: "Error: Remote call failed\n    at remote",
          },
        },
      },
      {
        name: "BATCH 10",
        message: {
          type: NexusMessageType.BATCH,
          id: "batch-10",
          calls: Array.from({ length: 10 }, (_, index) => buildApply(index)),
        },
      },
      {
        name: "BATCH 100",
        message: {
          type: NexusMessageType.BATCH,
          id: "batch-100",
          calls: Array.from({ length: 100 }, (_, index) => buildApply(index)),
        },
      },
      {
        name: "HANDSHAKE_REQ",
        message: {
          type: NexusMessageType.HANDSHAKE_REQ,
          id: "handshake-req-1",
          metadata: {
            context: "node-ipc-client",
            appId: "bench-client",
            pid: 12345,
            groups: ["bench"],
          },
        },
      },
      {
        name: "HANDSHAKE_ACK",
        message: {
          type: NexusMessageType.HANDSHAKE_ACK,
          id: "handshake-ack-1",
          metadata: {
            context: "node-ipc-daemon",
            appId: "bench-daemon",
            instance: "default",
            pid: 54321,
          },
        },
      },
      {
        // Current serializers are JSON-based, so this measures today's behavior
        // for a binary-bearing Nexus message rather than binary preservation.
        name: "CHUNK_DATA ArrayBuffer payload",
        message: {
          type: NexusMessageType.CHUNK_DATA,
          id: "chunk-binary-1",
          chunkIndex: 0,
          chunkData: Uint8Array.from({ length: 256 }, (_, index) => index % 256)
            .buffer,
        },
      },
    ];
  };

export const runSerializerBenchmark = (
  options: SerializerBenchmarkOptions = {},
): SerializerBenchmarkResult[] => {
  const iterations = Math.max(1, options.iterations ?? 10_000);
  const cases = options.cases ?? buildSerializerBenchmarkMessages();
  const serializers = options.serializers ?? currentSerializers;

  return serializers.flatMap(({ name, serializer }) =>
    cases.map((testCase) => runCase(name, serializer, testCase, iterations)),
  );
};

export const buildSerializerBenchmarkSummary = (
  results: SerializerBenchmarkResult[],
): SerializerBenchmarkSummary => ({
  results,
  nodeVersion: process.version,
  browserBundleSizeNote:
    "Not measured by this Node smoke script; compare browser bundle output before selecting a browser default.",
  cspImpact:
    "JSON, BinarySerializer, and @msgpack/msgpack do not require eval; msgpackr record structures may require CSP review depending on bundler/runtime options.",
});

const runCase = (
  serializerName: string,
  serializer: ISerializer,
  testCase: SerializerBenchmarkCase,
  iterations: number,
): SerializerBenchmarkResult => {
  const packet = unwrapBenchmarkResult(
    serializer.safeSerialize(testCase.message),
    serializerName,
    testCase.name,
    "serialize",
  );
  const encodedBytes = measurePacketBytes(packet);

  const encodeMs = measure(() => {
    unwrapBenchmarkResult(
      serializer.safeSerialize(testCase.message),
      serializerName,
      testCase.name,
      "serialize",
    );
  }, iterations);
  const decodeMs = measure(() => {
    unwrapBenchmarkResult(
      serializer.safeDeserialize(packet),
      serializerName,
      testCase.name,
      "deserialize",
    );
  }, iterations);
  const roundtripMs = measure(() => {
    const encoded = unwrapBenchmarkResult(
      serializer.safeSerialize(testCase.message),
      serializerName,
      testCase.name,
      "serialize",
    );
    unwrapBenchmarkResult(
      serializer.safeDeserialize(encoded),
      serializerName,
      testCase.name,
      "deserialize",
    );
  }, iterations);

  return {
    serializer: serializerName,
    caseName: testCase.name,
    encodedBytes,
    encodeMs,
    decodeMs,
    roundtripMs,
    serializeOpsPerSec: calculateOpsPerSecond(iterations, encodeMs),
    deserializeOpsPerSec: calculateOpsPerSecond(iterations, decodeMs),
    roundtripOpsPerSec: calculateOpsPerSecond(iterations, roundtripMs),
    memoryAllocationTrend: "not-measured",
  };
};

function createMsgpackrSerializer(useRecords: boolean): ISerializer {
  const packr = new Packr({
    useRecords,
    structures: useRecords ? [] : undefined,
  });
  return {
    packetType: "arraybuffer",
    safeSerialize: (logicalMessage) =>
      packSafely(
        () => toArrayBuffer(new Uint8Array(packr.pack(logicalMessage))),
        "msgpackr serialize failed",
      ),
    safeDeserialize: (packet) =>
      unpackSafely(
        packet,
        (buffer) => packr.unpack(new Uint8Array(buffer)),
        "msgpackr deserialize failed",
      ),
  };
}

function createMsgpackSerializer(): ISerializer {
  return {
    packetType: "arraybuffer",
    safeSerialize: (logicalMessage) =>
      packSafely(
        () => toArrayBuffer(msgpackEncode(logicalMessage)),
        "@msgpack/msgpack serialize failed",
      ),
    safeDeserialize: (packet) =>
      unpackSafely(
        packet,
        (buffer) => msgpackDecode(new Uint8Array(buffer)) as NexusMessage,
        "@msgpack/msgpack deserialize failed",
      ),
  };
}

const packSafely = (
  operation: () => ArrayBuffer,
  message: string,
): Result<string | ArrayBuffer, NexusProtocolError> => {
  try {
    return ok(operation());
  } catch (cause) {
    return err(new NexusProtocolError(message, { originalError: cause }));
  }
};

const unpackSafely = (
  packet: string | ArrayBuffer,
  operation: (packet: ArrayBuffer) => NexusMessage,
  message: string,
): Result<NexusMessage, NexusProtocolError> => {
  if (!(packet instanceof ArrayBuffer)) {
    return err(new NexusProtocolError(message, { packetType: typeof packet }));
  }
  try {
    return ok(operation(packet));
  } catch (cause) {
    return err(new NexusProtocolError(message, { originalError: cause }));
  }
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

const unwrapBenchmarkResult = <T>(
  result: Result<T, Error>,
  serializerName: string,
  caseName: string,
  operation: "serialize" | "deserialize",
): T =>
  result.match(
    (value) => value,
    (error) => {
      throw new Error(
        `${serializerName} failed to ${operation} ${caseName}: ${error.message}`,
        { cause: error },
      );
    },
  );

const measurePacketBytes = (packet: string | ArrayBuffer): number => {
  if (typeof packet === "string") {
    return new TextEncoder().encode(packet).byteLength;
  }

  return packet.byteLength;
};

const measure = (operation: () => void, iterations: number): number => {
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    operation();
  }
  return performance.now() - startedAt;
};

const calculateOpsPerSecond = (
  iterations: number,
  elapsedMs: number,
): number =>
  elapsedMs === 0 ? Number.POSITIVE_INFINITY : iterations / (elapsedMs / 1000);
