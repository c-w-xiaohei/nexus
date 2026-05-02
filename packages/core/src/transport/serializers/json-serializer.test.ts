import { describe, expect, it } from "vitest";
import { JsonSerializer } from "./json-serializer";
import { NexusProtocolError } from "../../errors/transport-errors";
import { NexusMessageType } from "../../types/message";

describe("JsonSerializer", () => {
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
      })._unsafeUnwrap(),
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
      })._unsafeUnwrap(),
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
      })._unsafeUnwrap(),
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
      })._unsafeUnwrap(),
    ).toBe(JSON.stringify([1, "get-1", "resource-1", ["state"]]));

    expect(
      JsonSerializer.safeSerialize({
        type: NexusMessageType.SET,
        id: "set-1",
        resourceId: "resource-1",
        path: ["state"],
        value: 42,
      })._unsafeUnwrap(),
    ).toBe(JSON.stringify([2, "set-1", "resource-1", ["state"], 42]));

    expect(
      JsonSerializer.safeSerialize({
        type: NexusMessageType.APPLY,
        id: "apply-1",
        resourceId: "resource-1",
        path: ["actions", "increment"],
        args: ["alpha", 1],
      })._unsafeUnwrap(),
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
    )._unsafeUnwrap();
    expect(getMessage).toEqual({
      type: NexusMessageType.GET,
      id: "get-1",
      resourceId: "resource-1",
      path: ["state"],
    });
    expect(getMessage).not.toHaveProperty("invocationServiceName");
    expect(JsonSerializer.safeSerialize(getMessage)._unsafeUnwrap()).toBe(
      JSON.stringify([1, "get-1", "resource-1", ["state"]]),
    );

    const setMessage = JsonSerializer.safeDeserialize(
      JSON.stringify([2, "set-1", "resource-1", ["state"], 42]),
    )._unsafeUnwrap();
    expect(setMessage).toEqual({
      type: NexusMessageType.SET,
      id: "set-1",
      resourceId: "resource-1",
      path: ["state"],
      value: 42,
    });
    expect(setMessage).not.toHaveProperty("invocationServiceName");
    expect(JsonSerializer.safeSerialize(setMessage)._unsafeUnwrap()).toBe(
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
    )._unsafeUnwrap();
    expect(applyMessage).toEqual({
      type: NexusMessageType.APPLY,
      id: "apply-1",
      resourceId: "resource-1",
      path: ["actions", "increment"],
      args: ["alpha", 1],
    });
    expect(applyMessage).not.toHaveProperty("invocationServiceName");
    expect(JsonSerializer.safeSerialize(applyMessage)._unsafeUnwrap()).toBe(
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
