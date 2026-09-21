import { describe, expect, it } from "vitest";
import { safeParse } from "valibot";
import {
  MessageIdSchema,
  NexusMessageSchema,
  NexusMessageType,
} from "../../../types/message";
import { JsonSerializer } from "../json-serializer";
import { BinarySerializer } from "../binary-serializer";
import { NexusProtocolError } from "../../../errors/transport-errors";

const messages = [
  {
    type: NexusMessageType.GET,
    id: "get",
    resourceId: null,
    path: ["value"],
  },
  {
    type: NexusMessageType.SET,
    id: "set",
    resourceId: "resource",
    path: ["value"],
    value: { opaque: true },
  },
  {
    type: NexusMessageType.APPLY,
    id: "apply",
    resourceId: null,
    path: ["call"],
    args: [{ opaque: true }],
  },
  { type: NexusMessageType.RES, id: "res", result: Promise.resolve("opaque") },
  {
    type: NexusMessageType.ERR,
    id: "err",
    error: { name: "Error", code: "E_REMOTE", message: "failed" },
  },
  { type: NexusMessageType.RELEASE, id: null, resourceId: "resource" },
  {
    type: NexusMessageType.BATCH,
    id: "batch",
    calls: [
      {
        type: NexusMessageType.GET,
        id: "nested-get",
        resourceId: null,
        path: [],
      },
    ],
  },
  {
    type: NexusMessageType.BATCH_RES,
    id: "batch-res",
    results: [
      [0, { opaque: true }],
      [1, { name: "Error", code: "E", message: "x" }],
    ],
  },
  {
    type: NexusMessageType.HANDSHAKE_REQ,
    id: "handshake-req",
    metadata: { opaque: true },
  },
  {
    type: NexusMessageType.HANDSHAKE_ACK,
    id: "handshake-ack",
    metadata: { opaque: true },
    capabilities: ["capability"],
    providers: ["provider"],
  },
  {
    type: NexusMessageType.HANDSHAKE_READY,
    id: "handshake-ready",
    capabilities: [],
    providers: [],
  },
  {
    type: NexusMessageType.HANDSHAKE_REJECT,
    id: "handshake-reject",
    error: { name: "Error", code: "E", message: "rejected" },
  },
  {
    type: NexusMessageType.IDENTITY_UPDATE,
    id: null,
    updates: { opaque: true },
  },
  {
    type: NexusMessageType.PROVIDER_AVAILABLE,
    id: null,
    providers: ["provider"],
  },
  {
    type: NexusMessageType.CHUNK_START,
    id: "chunk",
    totalChunks: 2,
    originalMessageId: "request",
    originalMessageType: NexusMessageType.APPLY,
  },
  {
    type: NexusMessageType.CHUNK_DATA,
    id: "chunk",
    chunkIndex: 0,
    chunkData: "chunk-data",
  },
] as const;

const wireFixtures = [
  {
    message: messages[0],
    packet: [1, "get", null, ["value"]],
  },
  {
    message: messages[1],
    packet: [2, "set", "resource", ["value"], { opaque: true }],
  },
  {
    message: messages[2],
    packet: [3, "apply", null, ["call"], [{ opaque: true }]],
  },
  {
    message: messages[3],
    packet: [5, "res", Promise.resolve("opaque")],
  },
  {
    message: messages[4],
    packet: [6, "err", { name: "Error", code: "E_REMOTE", message: "failed" }],
  },
  {
    message: messages[5],
    packet: [7, null, "resource"],
  },
  {
    message: messages[6],
    packet: [8, "batch", [[8 - 7, "nested-get", null, []]]],
  },
  {
    message: messages[7],
    packet: [
      9,
      "batch-res",
      [
        [0, { opaque: true }],
        [1, { name: "Error", code: "E", message: "x" }],
      ],
    ],
  },
  {
    message: messages[8],
    packet: [10, "handshake-req", { opaque: true }, null, null],
  },
  {
    message: messages[9],
    packet: [
      11,
      "handshake-ack",
      { opaque: true },
      ["capability"],
      ["provider"],
    ],
  },
  {
    message: messages[10],
    packet: [14, "handshake-ready", [], []],
  },
  {
    message: messages[11],
    packet: [
      12,
      "handshake-reject",
      { name: "Error", code: "E", message: "rejected" },
    ],
  },
  {
    message: messages[12],
    packet: [13, null, { opaque: true }],
  },
  {
    message: messages[13],
    packet: [15, null, ["provider"]],
  },
  {
    message: messages[14],
    packet: [16, "chunk", 2, "request", 3],
  },
  {
    message: messages[15],
    packet: [17, "chunk", 0, "chunk-data"],
  },
] as const;

describe("Nexus message schemas", () => {
  it("accepts every message variant without inspecting application payloads", () => {
    for (const message of messages) {
      expect(safeParse(NexusMessageSchema, message).success).toBe(true);
    }

    const payload = { callback: () => "opaque" };
    const result = safeParse(NexusMessageSchema, {
      type: NexusMessageType.RES,
      id: 1,
      result: payload,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.result).toBe(payload);
  });

  it("round-trips all sixteen message variants through the existing arrays", () => {
    for (const message of messages) {
      const decoded = JsonSerializer.safeDeserialize(
        JsonSerializer.safeSerialize(message).unwrap(),
      );
      expect(decoded.isOk()).toBe(true);
    }
  });

  it("preserves the exact packet array for every message variant", () => {
    for (const fixture of wireFixtures) {
      expect(JsonSerializer.safeSerialize(fixture.message).unwrap()).toBe(
        JSON.stringify(fixture.packet),
      );
    }
  });

  it("rejects malformed discriminators and owned fields", () => {
    expect(safeParse(MessageIdSchema, true).success).toBe(false);
    expect(
      JsonSerializer.safeDeserialize(
        JSON.stringify([NexusMessageType.GET, "id", "resource", [true]]),
      ).isErr(),
    ).toBe(true);
    expect(
      JsonSerializer.safeDeserialize(
        JSON.stringify([NexusMessageType.HANDSHAKE_ACK, "id", {}, [1], []]),
      ).isErr(),
    ).toBe(true);
    expect(
      JsonSerializer.safeDeserialize(JSON.stringify([999, "id"])).isErr(),
    ).toBe(true);
    expect(
      JsonSerializer.safeDeserialize(
        JSON.stringify([
          NexusMessageType.BATCH_RES,
          "batch-res",
          [[2, "not-an-error"]],
        ]),
      ).isErr(),
    ).toBe(true);
    expect(
      JsonSerializer.safeDeserialize(
        JSON.stringify([NexusMessageType.CHUNK_START, "chunk", 1, null, "GET"]),
      ).isErr(),
    ).toBe(true);
  });

  it("allows JSON null padding and ignores unknown packet tails", () => {
    const result = JsonSerializer.safeDeserialize(
      JSON.stringify([
        NexusMessageType.HANDSHAKE_READY,
        "ready",
        null,
        null,
        "future-field",
      ]),
    );

    expect(result.unwrap()).toEqual({
      type: NexusMessageType.HANDSHAKE_READY,
      id: "ready",
    });
  });

  it("restricts BATCH calls to GET, SET, and APPLY", () => {
    const result = JsonSerializer.safeDeserialize(
      JSON.stringify([
        NexusMessageType.BATCH,
        "batch",
        [[NexusMessageType.HANDSHAKE_READY, "not-a-call"]],
      ]),
    );

    expect(result.isErr()).toBe(true);
  });

  it("keeps application values and framework trust decisions opaque", () => {
    const value = { origin: "application", nested: { callback: "opaque" } };
    const message = {
      type: NexusMessageType.ERR,
      id: "error",
      error: {
        name: "Error",
        code: "E_REMOTE",
        message: "application failure",
        origin: "framework",
      },
    };
    const result = JsonSerializer.safeDeserialize(
      JsonSerializer.safeSerialize({
        type: NexusMessageType.SET,
        id: "set",
        resourceId: null,
        path: [],
        value,
      }).unwrap(),
    );

    expect(result.unwrap()).toMatchObject({ value });
    expect(
      JsonSerializer.safeDeserialize(
        JsonSerializer.safeSerialize(message).unwrap(),
      ).unwrap(),
    ).toMatchObject({ error: message.error });
  });

  it("rejects unsupported ArrayBuffer chunk serialization in JSON and Binary", () => {
    const message = {
      type: NexusMessageType.CHUNK_DATA,
      id: "chunk-buffer",
      chunkIndex: 0,
      chunkData: new ArrayBuffer(2),
    };

    for (const result of [
      JsonSerializer.safeSerialize(message),
      BinarySerializer.safeSerialize(message),
    ]) {
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(NexusProtocolError);
        expect(result.error.message).toContain(
          "ArrayBuffer chunk data is not supported",
        );
      }
    }
  });

  it("rejects the lossy JSON object representation of an ArrayBuffer chunk", () => {
    const result = JsonSerializer.safeDeserialize(
      JSON.stringify([NexusMessageType.CHUNK_DATA, "chunk", 0, {}]),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(NexusProtocolError);
  });

  it("contains deep recursive error validation failures in the Result boundary", () => {
    const depth = 20_000;
    const nested =
      '{"name":"Error","code":"E_DEEP","message":"deep","cause":'.repeat(
        depth,
      ) +
      '{"name":"Error","code":"E_DEEP","message":"deep"}' +
      "}".repeat(depth);
    const packet = `[${NexusMessageType.ERR},"deep",${nested}]`;

    const result = JsonSerializer.safeDeserialize(packet);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusProtocolError);
      expect(result.error.cause?.message).toContain("call stack");
    }
  });

  it("contains deep recursive error serialization failures in the Result boundary", () => {
    const depth = 20_000;
    const error: {
      name: string;
      code: string;
      message: string;
      cause?: unknown;
    } = {
      name: "Error",
      code: "E_DEEP",
      message: "deep",
    };
    let current = error;
    for (let index = 0; index < depth; index += 1) {
      current.cause = {
        name: "Error",
        code: "E_DEEP",
        message: "deep",
      };
      current = current.cause as typeof error;
    }

    const result = JsonSerializer.safeSerialize({
      type: NexusMessageType.ERR,
      id: "deep",
      error,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusProtocolError);
      expect(result.error.cause?.message).toContain("call stack");
    }
  });
});
