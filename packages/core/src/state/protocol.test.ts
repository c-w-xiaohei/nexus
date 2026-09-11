import { describe, expect, it } from "vitest";
import { z } from "zod";
import { safeParsePayload, SyncEnvelopeSchema } from "./protocol";

describe("state protocol", () => {
  it("preserves parsed outputs, including promise-valued payloads", () => {
    const normalized = safeParsePayload(
      z.object({ count: z.number().default(1) }),
      {},
      "Invalid payload.",
    );
    expect(normalized.unwrap()).toEqual({ count: 1 });
    const value = Promise.resolve(2);
    const parsed = safeParsePayload(
      z.custom<Promise<number>>(),
      value,
      "Invalid payload.",
    );
    expect(parsed.unwrap()).toBe(value);
  });

  it("converts validation and transform failures to structured protocol errors", () => {
    const cause = new Error("transform failed");
    const schemas = [
      z.number(),
      z.string().transform(() => {
        throw cause;
      }),
    ];
    for (const schema of schemas) {
      const parsed = safeParsePayload(schema, "invalid", "Invalid payload.");
      expect(parsed.isErr()).toBe(true);
      if (parsed.isErr()) {
        expect(parsed.error.code).toBe("E_STORE_PROTOCOL");
        expect(parsed.error.cause).toBeInstanceOf(Error);
        if (schema === schemas[1]) expect(parsed.error.cause).toBe(cause);
      }
    }
  });

  it("accepts callback init, snapshot, and terminal envelopes", () => {
    const action = async () => 1;
    expect(
      SyncEnvelopeSchema.safeParse({
        type: "init",
        storeInstanceId: "instance-1",
        version: 0,
        state: { count: 1 },
        actions: { increment: action },
        unsubscribe: action,
      }).success,
    ).toBe(true);
    expect(
      SyncEnvelopeSchema.safeParse({
        type: "snapshot",
        storeInstanceId: "instance-1",
        version: 1,
        state: { count: 2 },
      }).success,
    ).toBe(true);
    expect(
      SyncEnvelopeSchema.safeParse({
        type: "terminal",
        storeInstanceId: "instance-1",
        lastKnownVersion: 1,
        reason: "provider-shutdown",
      }).success,
    ).toBe(true);
  });
});
