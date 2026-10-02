import { describe, expect, it, vi } from "vitest";
import { JsonSerializer } from "./json-serializer";
import { NexusProtocolError } from "../../errors/transport-errors";
import { NexusMessageType } from "../../types/message";
import { BinarySerializer } from "./binary-serializer";
import {
  createBinaryValue,
  isBinaryValue,
} from "../../service/payload/binary-value";
import { createByteReservationLease } from "../../service/payload/byte-reservation";
import {
  NexusResourceError,
  serializeFrameworkError,
  reviveFrameworkError,
} from "@/errors";

describe("JsonSerializer", () => {
  it("round-trips binary values with Base64 without reviving marker-shaped user objects", () => {
    const markerCollision = {
      __nexusBinaryValue: 1,
      kind: "bytes",
      data: "AQI=",
    };
    const message = {
      type: NexusMessageType.RES,
      id: "binary-json",
      result: { bytes: new Uint8Array([1, 2, 3]), collision: markerCollision },
    };
    const decoded = JsonSerializer.safeDeserialize(
      JsonSerializer.safeSerialize(message).unwrap(),
    ).unwrap();
    expect(decoded).toMatchObject({
      type: NexusMessageType.RES,
      result: { collision: markerCollision },
    });
    if (decoded.type !== NexusMessageType.RES) throw new Error("Expected RES");
    expect(isBinaryValue(decoded.result.bytes)).toBe(true);
    if (!isBinaryValue(decoded.result.bytes))
      throw new Error("Expected binary value");
    expect([...decoded.result.bytes.bytes]).toEqual([1, 2, 3]);
  });

  it("does not accept malformed or nested user marker lookalikes as binary", () => {
    const malformed = JsonSerializer.safeDeserialize(
      JSON.stringify([
        NexusMessageType.RES,
        "fake-marker",
        {
          __proto__: null,
          "\u0000nexus-binary-v1": "bytes",
          data: "AQI=",
          extra: "user-owned",
        },
      ]),
    );
    expect(malformed.isErr()).toBe(true);

    const nested = {
      "\u0000nexus-binary-v1": { nested: true },
      data: "ordinary user data",
    };
    const decoded = JsonSerializer.safeDeserialize(
      JsonSerializer.safeSerialize({
        type: NexusMessageType.RES,
        id: "nested-marker",
        result: { inner: nested },
      }).unwrap(),
    ).unwrap();
    expect(decoded).toMatchObject({ result: { inner: nested } });
  });

  it("decodes binary values nested under either reserved user marker key", () => {
    const marker = "\u0000nexus-binary-v1";
    const escaped = "\u0000nexus-escaped-object-v1";
    const value = {
      [marker]: { bytes: new Uint8Array([1, 2]) },
      [escaped]: { bytes: new Uint8Array([3, 4]) },
    };
    const message = {
      type: NexusMessageType.RES,
      id: "json-colliding-binary",
      result: value,
    };

    const decoded = JsonSerializer.safeDeserialize(
      JsonSerializer.safeSerialize(message).unwrap(),
    ).unwrap();

    expect(decoded.type).toBe(NexusMessageType.RES);
    if (decoded.type !== NexusMessageType.RES) throw new Error("Expected RES");
    for (const [key, bytes] of [
      [marker, [1, 2]],
      [escaped, [3, 4]],
    ] as const) {
      const nested = decoded.result[key] as { bytes: unknown };
      expect(isBinaryValue(nested.bytes)).toBe(true);
      if (!isBinaryValue(nested.bytes))
        throw new Error("Expected binary value");
      expect([...nested.bytes.bytes]).toEqual(bytes);
    }
  });

  it("decodes binary attachments nested under either reserved user marker key", () => {
    const marker = "\u0000nexus-binary-v1";
    const escaped = "\u0000nexus-escaped-object-v1";
    const message = {
      type: NexusMessageType.RES,
      id: "binary-colliding-attachments",
      result: {
        [marker]: { bytes: new Uint8Array([5, 6]) },
        [escaped]: { bytes: new Uint8Array([7, 8]) },
      },
    };

    const decoded = BinarySerializer.safeDeserialize(
      BinarySerializer.safeSerialize(message).unwrap(),
    ).unwrap();

    expect(decoded.type).toBe(NexusMessageType.RES);
    if (decoded.type !== NexusMessageType.RES) throw new Error("Expected RES");
    for (const [key, bytes] of [
      [marker, [5, 6]],
      [escaped, [7, 8]],
    ] as const) {
      const nested = decoded.result[key] as { bytes: unknown };
      expect(isBinaryValue(nested.bytes)).toBe(true);
      if (!isBinaryValue(nested.bytes))
        throw new Error("Expected binary value");
      expect([...nested.bytes.bytes]).toEqual(bytes);
    }
  });

  it("reserves codec output before allocating JSON or binary packets", () => {
    const reserveBytes = vi.fn(() => false);
    const lease = createByteReservationLease({
      reserveBytes,
      releaseBytes: vi.fn(),
    });
    const message = {
      type: NexusMessageType.RES,
      id: "codec-capacity",
      result: new Uint8Array([1, 2, 3]),
    };

    expect(JsonSerializer.safeSerialize(message, { lease }).isErr()).toBe(true);
    expect(BinarySerializer.safeSerialize(message, { lease }).isErr()).toBe(
      true,
    );
    expect(reserveBytes).toHaveBeenCalledTimes(2);
    expect(reserveBytes.mock.calls[0][0]).toBeGreaterThan(3);
  });

  it.each([
    [
      "many empty containers",
      {
        objects: Array.from({ length: 160 }, () => ({})),
        arrays: Array.from({ length: 160 }, () => []),
        maps: Array.from({ length: 80 }, () => new Map()),
        sets: Array.from({ length: 80 }, () => new Set()),
      },
    ],
    [
      "long Blob MIME metadata",
      createBinaryValue(
        "blob",
        new Uint8Array([1]),
        `image/${"x".repeat(4096)}`,
      ),
    ],
  ])(
    "reserves at least the actual encoded bytes for %s in both codecs",
    (_case, value) => {
      for (const codec of [JsonSerializer, BinarySerializer]) {
        let reserved = 0;
        const lease = createByteReservationLease({
          reserveBytes: (bytes) => {
            reserved += bytes;
            return true;
          },
          releaseBytes: (bytes) => {
            reserved -= bytes;
          },
        });
        const message = {
          type: NexusMessageType.RES,
          id: `reservation-${String(_case)}`,
          result: value,
        };
        const packet = codec.safeSerialize(message, { lease }).unwrap();
        const packetBytes =
          typeof packet === "string"
            ? new TextEncoder().encode(packet).byteLength
            : packet.byteLength;

        expect(reserved).toBeGreaterThanOrEqual(packetBytes);
        lease.releaseAll();
        expect(reserved).toBe(0);
      }
    },
  );

  it("keeps binary serializer packets length-framed and round-trips raw attachments", () => {
    const message = {
      type: NexusMessageType.RES,
      id: "binary-frame",
      result: { bytes: new Uint8Array([0, 127, 255]) },
    };
    const packet = BinarySerializer.safeSerialize(message).unwrap();
    const bytes = new Uint8Array(packet);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).not.toBe("[5,");
    const decoded = BinarySerializer.safeDeserialize(packet).unwrap();
    expect(decoded.type).toBe(NexusMessageType.RES);
    if (decoded.type !== NexusMessageType.RES) throw new Error("Expected RES");
    expect(isBinaryValue(decoded.result.bytes)).toBe(true);
    if (!isBinaryValue(decoded.result.bytes))
      throw new Error("Expected binary value");
    expect([...decoded.result.bytes.bytes]).toEqual([0, 127, 255]);
  });

  it("preserves nested Map and Set entries containing binary values in both codecs", () => {
    const message = {
      type: NexusMessageType.RES,
      id: "binary-collections",
      result: new Map([["nested", new Set([new Uint8Array([7, 8])])]]),
    };
    const packets = [
      JsonSerializer.safeSerialize(message).unwrap(),
      BinarySerializer.safeSerialize(message).unwrap(),
    ];
    for (const packet of packets) {
      const decoded =
        typeof packet === "string"
          ? JsonSerializer.safeDeserialize(packet).unwrap()
          : BinarySerializer.safeDeserialize(packet).unwrap();
      expect(decoded.type).toBe(NexusMessageType.RES);
      if (decoded.type !== NexusMessageType.RES)
        throw new Error("Expected RES");
      const set = (decoded.result as Map<string, Set<unknown>>).get("nested");
      expect(set).toBeInstanceOf(Set);
      const [binary] = set!;
      expect(isBinaryValue(binary)).toBe(true);
      if (!isBinaryValue(binary)) throw new Error("Expected binary value");
      expect([...binary.bytes]).toEqual([7, 8]);
    }
  });

  it("exposes the same validated packet shape to alternative codecs", () => {
    const message = {
      type: NexusMessageType.APPLY as const,
      id: "codec-1",
      resourceId: null,
      path: ["echo"],
      args: [{ value: 1 }],
    };
    const packed = JsonSerializer.safePack(message).unwrap();
    expect(JSON.stringify(packed)).toBe(
      JsonSerializer.safeSerialize(message).unwrap(),
    );
    expect(JsonSerializer.safeUnpack(packed).unwrap()).toEqual(message);
    expect(JsonSerializer.safeUnpack([999, "id"])).toMatchObject({
      error: { code: "E_PROTOCOL_ERROR" },
    });
  });

  it("preserves framework diagnostics through JSON and binary transports", () => {
    const error = new NexusResourceError("denied", "E_AUTH_CALL_DENIED", {
      resourceId: "resource",
      path: ["read"],
      serviceName: "vault",
    });
    const cause = {
      name: "Error",
      code: "E_UNKNOWN",
      message: "policy unavailable",
    };
    Object.defineProperty(error, "cause", { value: cause });
    error.stack = "remote-stack";
    const message = {
      type: NexusMessageType.ERR as const,
      id: 1,
      error: serializeFrameworkError(error),
    };
    const json = JsonSerializer.safeDeserialize(
      JsonSerializer.safeSerialize(message).unwrap(),
    ).unwrap();
    const binary = BinarySerializer.safeDeserialize(
      BinarySerializer.safeSerialize(message).unwrap(),
    ).unwrap();
    for (const response of [json, binary]) {
      expect(response.type).toBe(NexusMessageType.ERR);
      if (response.type !== NexusMessageType.ERR)
        throw new Error("Expected error packet");
      expect(reviveFrameworkError(response.error)?.context).toMatchObject({
        resourceId: "resource",
        path: ["read"],
        serviceName: "vault",
      });
      expect(reviveFrameworkError(response.error)).toMatchObject({
        cause,
        stack: "remote-stack",
      });
    }
  });
  it("returns protocol error for malformed batch calls payload", () => {
    const malformedPacket = JSON.stringify([8, "batch-1", null]);
    const result = JsonSerializer.safeDeserialize(malformedPacket);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusProtocolError);
      expect(result.error.message).toContain("calls must be an array");
    }
  });

  it("returns protocol error for malformed nested batch packet", () => {
    const malformedPacket = JSON.stringify([8, "batch-1", [null]]);
    const result = JsonSerializer.safeDeserialize(malformedPacket);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusProtocolError);
      expect(result.error.message).toContain("nested call must be an array");
    }
  });

  it("returns protocol error for malformed nested batch message", () => {
    const malformedMessage = {
      type: 8,
      id: "batch-1",
      calls: [null],
    } as any;
    const result = JsonSerializer.safeSerialize(malformedMessage);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusProtocolError);
      expect(result.error.message).toContain("call must be an object");
    }
  });

  it("returns protocol error for non-object message input", () => {
    const result = JsonSerializer.safeSerialize(null as any);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("expected an object");
    }
  });

  it("serializes service invocation names before SET values and APPLY args", () => {
    expect(
      JsonSerializer.safeSerialize({
        type: NexusMessageType.GET,
        id: "get-1",
        resourceId: "resource-1",
        path: ["state"],
        invocationServiceName: "CounterStore",
      }).unwrap(),
    ).toBe(
      JSON.stringify([1, "get-1", "resource-1", ["state"], "CounterStore"]),
    );

    expect(
      JsonSerializer.safeSerialize({
        type: NexusMessageType.SET,
        id: "set-1",
        resourceId: "resource-1",
        path: ["state"],
        invocationServiceName: "CounterStore",
        value: 42,
      }).unwrap(),
    ).toBe(
      JSON.stringify([2, "set-1", "resource-1", ["state"], "CounterStore", 42]),
    );

    expect(
      JsonSerializer.safeSerialize({
        type: NexusMessageType.APPLY,
        id: "apply-1",
        resourceId: "resource-1",
        path: ["actions", "increment"],
        invocationServiceName: "CounterStore",
        args: ["alpha", 1],
      }).unwrap(),
    ).toBe(
      JSON.stringify([
        3,
        "apply-1",
        "resource-1",
        ["actions", "increment"],
        "CounterStore",
        ["alpha", 1],
      ]),
    );
  });

  it("serializes unnamed GET, SET, and APPLY packets in legacy shape", () => {
    expect(
      JsonSerializer.safeSerialize({
        type: NexusMessageType.GET,
        id: "get-1",
        resourceId: "resource-1",
        path: ["state"],
      }).unwrap(),
    ).toBe(JSON.stringify([1, "get-1", "resource-1", ["state"]]));

    expect(
      JsonSerializer.safeSerialize({
        type: NexusMessageType.SET,
        id: "set-1",
        resourceId: "resource-1",
        path: ["state"],
        value: 42,
      }).unwrap(),
    ).toBe(JSON.stringify([2, "set-1", "resource-1", ["state"], 42]));

    expect(
      JsonSerializer.safeSerialize({
        type: NexusMessageType.APPLY,
        id: "apply-1",
        resourceId: "resource-1",
        path: ["actions", "increment"],
        args: ["alpha", 1],
      }).unwrap(),
    ).toBe(
      JSON.stringify([
        3,
        "apply-1",
        "resource-1",
        ["actions", "increment"],
        ["alpha", 1],
      ]),
    );
  });

  it("decodes legacy GET, SET, and APPLY packets without invocation service names", () => {
    const getMessage = JsonSerializer.safeDeserialize(
      JSON.stringify([1, "get-1", "resource-1", ["state"]]),
    ).unwrap();
    expect(getMessage).toEqual({
      type: NexusMessageType.GET,
      id: "get-1",
      resourceId: "resource-1",
      path: ["state"],
    });
    expect(getMessage).not.toHaveProperty("invocationServiceName");
    expect(JsonSerializer.safeSerialize(getMessage).unwrap()).toBe(
      JSON.stringify([1, "get-1", "resource-1", ["state"]]),
    );

    const setMessage = JsonSerializer.safeDeserialize(
      JSON.stringify([2, "set-1", "resource-1", ["state"], 42]),
    ).unwrap();
    expect(setMessage).toEqual({
      type: NexusMessageType.SET,
      id: "set-1",
      resourceId: "resource-1",
      path: ["state"],
      value: 42,
    });
    expect(setMessage).not.toHaveProperty("invocationServiceName");
    expect(JsonSerializer.safeSerialize(setMessage).unwrap()).toBe(
      JSON.stringify([2, "set-1", "resource-1", ["state"], 42]),
    );

    const applyMessage = JsonSerializer.safeDeserialize(
      JSON.stringify([
        3,
        "apply-1",
        "resource-1",
        ["actions", "increment"],
        ["alpha", 1],
      ]),
    ).unwrap();
    expect(applyMessage).toEqual({
      type: NexusMessageType.APPLY,
      id: "apply-1",
      resourceId: "resource-1",
      path: ["actions", "increment"],
      args: ["alpha", 1],
    });
    expect(applyMessage).not.toHaveProperty("invocationServiceName");
    expect(JsonSerializer.safeSerialize(applyMessage).unwrap()).toBe(
      JSON.stringify([
        3,
        "apply-1",
        "resource-1",
        ["actions", "increment"],
        ["alpha", 1],
      ]),
    );
  });
});
