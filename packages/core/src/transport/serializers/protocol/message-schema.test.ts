import { describe, expect, it } from "vitest";
import { safeParse } from "valibot";
import {
  ChunkAckMessageSchema,
  ChunkCancelMessageSchema,
  ChunkDataMessageSchema,
  ChunkStartMessageSchema,
  HandshakeAckMessageSchema,
  HandshakeReadyMessageSchema,
  HandshakeReqMessageSchema,
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
    transport: {
      version: 1,
      receive: { maxFrameBytes: 1024, maxMessageBytes: 4096 },
      packetModes: ["json"],
    },
  },
  {
    type: NexusMessageType.HANDSHAKE_ACK,
    id: "handshake-ack",
    metadata: { opaque: true },
    capabilities: ["capability"],
    providers: ["provider"],
    transport: {
      version: 1,
      receive: { maxFrameBytes: 1024, maxMessageBytes: 4096 },
      packetModes: ["json"],
    },
  },
  {
    type: NexusMessageType.HANDSHAKE_READY,
    id: "handshake-ready",
    capabilities: [],
    providers: [],
    transport: {
      initiatorReceive: { maxFrameBytes: 1024, maxMessageBytes: 4096 },
      responderReceive: { maxFrameBytes: 1024, maxMessageBytes: 4096 },
      selectedPacketMode: "json",
    },
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
    id: 1,
    version: 1,
    packetKind: NexusMessageType.APPLY,
    totalBytes: 10,
  },
  {
    type: NexusMessageType.CHUNK_DATA,
    id: 1,
    version: 1,
    offset: 0,
    data: new Uint8Array([1, 2]),
  },
  {
    type: NexusMessageType.CHUNK_ACK,
    id: 1,
    version: 1,
    offset: 0,
    committed: false,
  },
  {
    type: NexusMessageType.CHUNK_CANCEL,
    id: 1,
    version: 1,
    reason: "capacity",
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
    packet: [
      10,
      "handshake-req",
      { opaque: true },
      null,
      null,
      messages[8].transport,
    ],
  },
  {
    message: messages[9],
    packet: [
      11,
      "handshake-ack",
      { opaque: true },
      ["capability"],
      ["provider"],
      messages[9].transport,
    ],
  },
  {
    message: messages[10],
    packet: [14, "handshake-ready", [], [], messages[10].transport],
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
    packet: [16, 1, 1, 3, 10],
  },
  {
    message: messages[15],
    packet: [
      17,
      1,
      1,
      0,
      { "\u0000nexus-binary-v1": "uint8-array", data: "AQI=" },
    ],
  },
  { message: messages[16], packet: [18, 1, 1, 0, false] },
  { message: messages[17], packet: [19, 1, 1, "capacity"] },
] as const;

describe("Nexus message schemas", () => {
  it("rejects unknown chunk fields, versions, offsets and packet kinds", () => {
    const chunkSchemas = [
      ChunkStartMessageSchema,
      ChunkDataMessageSchema,
      ChunkAckMessageSchema,
      ChunkCancelMessageSchema,
    ] as const;
    for (const [index, schema] of chunkSchemas.entries()) {
      const message = messages[14 + index];
      expect(safeParse(schema, { ...message, extra: true }).success).toBe(
        false,
      );
      expect(safeParse(schema, { ...message, version: 2 }).success).toBe(false);
    }
    expect(
      safeParse(ChunkAckMessageSchema, {
        ...messages[16],
        offset: -1,
      }).success,
    ).toBe(false);
    for (const packetKind of [
      NexusMessageType.HANDSHAKE_REQ,
      NexusMessageType.CHUNK_START,
      NexusMessageType.CHUNK_DATA,
      NexusMessageType.CHUNK_ACK,
      NexusMessageType.CHUNK_CANCEL,
    ]) {
      expect(
        safeParse(ChunkStartMessageSchema, {
          ...messages[14],
          packetKind,
        }).success,
      ).toBe(false);
    }
  });

  it("requires transport negotiation on each handshake phase", () => {
    for (const [index, schema] of [
      HandshakeReqMessageSchema,
      HandshakeAckMessageSchema,
      HandshakeReadyMessageSchema,
    ].entries()) {
      const { transport: _transport, ...message } = messages[8 + index];
      expect(safeParse(schema, message).success).toBe(false);
    }
    expect(
      safeParse(HandshakeReqMessageSchema, {
        ...messages[8],
        transport: {
          version: 1,
          receive: { maxFrameBytes: 0, maxMessageBytes: 4096 },
          packetModes: ["json"],
        },
      }).success,
    ).toBe(false);
    expect(
      safeParse(HandshakeReadyMessageSchema, {
        ...messages[10],
        transport: {
          ...messages[10].transport,
          selectedPacketMode: "msgpack",
        },
      }).success,
    ).toBe(false);
  });

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

  it("round-trips all message variants through the existing arrays", () => {
    for (const message of messages) {
      const decoded = JsonSerializer.safeDeserialize(
        JsonSerializer.safeSerialize(message).unwrap(),
      );
      expect(
        decoded.isOk(),
        `message type ${message.type}: ${decoded.isErr() ? decoded.error.message : ""}`,
      ).toBe(true);
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
        {
          initiatorReceive: { maxFrameBytes: 1024, maxMessageBytes: 4096 },
          responderReceive: { maxFrameBytes: 1024, maxMessageBytes: 4096 },
          selectedPacketMode: "json",
        },
        "future-field",
      ]),
    );

    expect(result.unwrap()).toEqual({
      type: NexusMessageType.HANDSHAKE_READY,
      id: "ready",
      transport: {
        initiatorReceive: { maxFrameBytes: 1024, maxMessageBytes: 4096 },
        responderReceive: { maxFrameBytes: 1024, maxMessageBytes: 4096 },
        selectedPacketMode: "json",
      },
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

  it("encodes chunk controls in both native serializer modes", () => {
    const message = {
      type: NexusMessageType.CHUNK_DATA,
      id: 1,
      version: 1,
      offset: 0,
      data: new Uint8Array([1, 2]),
    };

    for (const result of [
      JsonSerializer.safeSerialize(message),
      BinarySerializer.safeSerialize(message),
    ]) {
      expect(result.isOk()).toBe(true);
    }
  });

  it("rejects the lossy JSON object representation of an ArrayBuffer chunk", () => {
    const result = JsonSerializer.safeDeserialize(
      JSON.stringify([NexusMessageType.CHUNK_DATA, 1, 1, 0, {}]),
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
