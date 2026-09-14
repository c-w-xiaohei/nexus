import { describe, expect, it } from "vitest";
import { JsonSerializer } from "./json-serializer";
import { NexusProtocolError } from "../../errors/transport-errors";
import { NexusMessageType } from "../../types/message";
import { BinarySerializer } from "./binary-serializer";
import {
  NexusResourceError,
  serializeFrameworkError,
  reviveFrameworkError,
} from "@/errors";

describe("JsonSerializer", () => {
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
