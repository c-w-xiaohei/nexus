import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  safeParsePayload,
  safeValidateState,
  safeValidateValue,
  SyncEnvelopeSchema,
} from "./protocol";

describe("state protocol", () => {
  it("preserves parsed outputs, including promise-valued payloads", () => {
    const normalized = safeParsePayload(
      v.object({ count: v.optional(v.number(), 1) }),
      {},
      "Invalid payload.",
    );
    expect(normalized.unwrap()).toEqual({ count: 1 });
    const value = Promise.resolve(2);
    const parsed = safeParsePayload(
      v.custom<Promise<number>>((candidate) => candidate instanceof Promise),
      value,
      "Invalid payload.",
    );
    expect(parsed.unwrap()).toBe(value);
  });

  it("converts validation and transform failures to structured protocol errors", () => {
    const cause = new Error("transform failed");
    const schemas = [
      v.number(),
      v.pipe(
        v.string(),
        v.transform(() => {
          throw cause;
        }),
      ),
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

  it("validates through Standard Schema while preserving raw values", () => {
    const value = { count: 1 };
    const schema = v.pipe(
      v.object({ count: v.number() }),
      v.transform(({ count }) => ({ count: count + 1 })),
    );

    const result = safeValidateState(value, schema, "Invalid state.");

    expect(result.unwrap()).toBe(value);
  });

  it("rejects an async validation result and consumes its rejection", async () => {
    const rejection = new Error("async validation failed");
    let consumed = false;
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: () => ({
          then: (_resolve: unknown, reject: (reason: unknown) => void) => {
            reject(rejection);
            consumed = true;
          },
        }),
      },
    };
    const result = safeValidateValue(1, schema, "Invalid action result.");

    expect(result.isErr()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(consumed).toBe(true);
  });

  it("preserves a promise returned as the validated output", () => {
    const value = Promise.resolve(2);
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: () => ({ value }),
      },
    };

    expect(safeValidateValue(value, schema, "Invalid output.").unwrap()).toBe(
      value,
    );
  });

  it("accepts callback init, snapshot, and terminal envelopes", () => {
    const action = async () => 1;
    expect(
      v.safeParse(SyncEnvelopeSchema, {
        type: "init",
        storeInstanceId: "instance-1",
        version: 0,
        state: { count: 1 },
        actions: { increment: action },
        unsubscribe: action,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(SyncEnvelopeSchema, {
        type: "snapshot",
        storeInstanceId: "instance-1",
        version: 1,
        state: { count: 2 },
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(SyncEnvelopeSchema, {
        type: "terminal",
        storeInstanceId: "instance-1",
        lastKnownVersion: 1,
        reason: "provider-shutdown",
      }).success,
    ).toBe(true);
  });
});
