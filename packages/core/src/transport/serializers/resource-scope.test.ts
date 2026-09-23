import { describe, expect, it } from "vitest";
import { BinarySerializer } from "./binary-serializer";
import { JsonSerializer } from "./json-serializer";
import { NexusMessageType } from "../../types/message";

const scopeId = "scope-a";
const requestScope = {
  scopeId,
  timeoutMs: 1_000,
  hops: 16,
};

const scopedMessages = [
  {
    type: NexusMessageType.GET as const,
    id: 1,
    resourceId: null,
    path: ["documents", "title"],
    ...requestScope,
  },
  {
    type: NexusMessageType.SET as const,
    id: 2,
    resourceId: null,
    path: ["documents", "title"],
    value: "updated",
    ...requestScope,
  },
  {
    type: NexusMessageType.APPLY as const,
    id: 3,
    resourceId: null,
    path: ["documents", "watch"],
    args: ["\u0003R:res-1"],
    ...requestScope,
  },
  {
    type: NexusMessageType.RES as const,
    id: 4,
    result: "done",
    scopeId,
  },
  {
    type: NexusMessageType.ERR as const,
    id: 5,
    error: { name: "Error", code: "BUSINESS", message: "failed" },
    scopeId,
  },
  {
    type: NexusMessageType.RELEASE as const,
    id: null,
    target: "resource" as const,
    resourceId: "res-1",
    scopeId,
  },
  {
    type: NexusMessageType.RELEASE as const,
    id: null,
    target: "scope" as const,
    scopeId,
  },
  {
    type: NexusMessageType.BATCH as const,
    id: 6,
    scopeId,
    calls: [
      {
        type: NexusMessageType.GET as const,
        id: 7,
        resourceId: null,
        path: ["documents", "title"],
        scopeId,
      },
      {
        type: NexusMessageType.APPLY as const,
        id: 8,
        resourceId: null,
        path: ["documents", "watch"],
        args: [],
        scopeId,
      },
    ],
  },
  {
    type: NexusMessageType.BATCH_RES as const,
    id: 9,
    scopeId,
    results: [
      [0, "done"],
      [1, { name: "Error", code: "BUSINESS", message: "failed" }],
    ],
  },
];

const codecs = [
  {
    name: "JSON",
    codec: JsonSerializer,
    malformedPacket: (packet: unknown) => JSON.stringify(packet),
  },
  {
    name: "binary",
    codec: BinarySerializer,
    malformedPacket: (packet: unknown) =>
      new TextEncoder().encode(JSON.stringify(packet)).buffer,
  },
] as const;

describe.each(codecs)(
  "resource scope $name packets",
  ({ codec, malformedPacket }) => {
    it.each(scopedMessages)("roundtrips scoped %#", (message) => {
      const encoded = codec.safeSerialize(message);
      expect(encoded.isOk()).toBe(true);
      if (encoded.isErr()) throw encoded.error;

      const decoded = codec.safeDeserialize(encoded.value);
      expect(decoded.isOk()).toBe(true);
      if (decoded.isErr()) throw decoded.error;
      expect(decoded.value).toEqual(message);
    });

    it.each([
      { scopeId: "x".repeat(129) },
      { timeoutMs: Number.NaN },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { hops: Number.NaN },
      { hops: 1.5 },
      { hops: Number.POSITIVE_INFINITY },
    ])("rejects malformed scoped request %#", (extra) => {
      expect(
        codec
          .safeSerialize({
            type: NexusMessageType.APPLY,
            id: 10,
            resourceId: null,
            path: ["documents", "watch"],
            args: [],
            ...requestScope,
            ...extra,
          } as never)
          .isErr(),
      ).toBe(true);
    });

    it.each([
      {
        type: NexusMessageType.RELEASE,
        id: null,
        target: "resource",
        scopeId,
      },
      {
        type: NexusMessageType.RELEASE,
        id: null,
        target: "scope",
      },
      {
        type: NexusMessageType.RELEASE,
        id: null,
        target: "scope",
        resourceId: "res-1",
        scopeId,
      },
    ])("rejects malformed release %#", (message) => {
      expect(codec.safeSerialize(message as never).isErr()).toBe(true);
    });

    it.each([
      [
        NexusMessageType.APPLY,
        11,
        null,
        ["documents", "watch"],
        null,
        [],
        "x".repeat(129),
        1_000,
        16,
      ],
      [
        NexusMessageType.APPLY,
        12,
        null,
        ["documents", "watch"],
        null,
        [],
        scopeId,
        1_000,
        1.5,
      ],
      [NexusMessageType.RELEASE, null, null, scopeId, "scope"],
      [NexusMessageType.RELEASE, null, "res-1", scopeId, "scope"],
    ])("rejects malformed wire packet %#", (packet) => {
      expect(codec.safeDeserialize(malformedPacket(packet)).isErr()).toBe(true);
    });
  },
);
