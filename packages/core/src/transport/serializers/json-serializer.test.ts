import { describe, expect, it } from "vitest";
import { JsonSerializer } from "./json-serializer";
import { NexusProtocolError } from "../../errors/transport-errors";

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
});
