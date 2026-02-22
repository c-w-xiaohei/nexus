import { describe, expect, it } from "vitest";
import { NexusError } from "@/errors";
import { fromUnknownError, toSerializedError, wrapCause } from "@/utils/error";

describe("error utils", () => {
  it("serializes NexusError with code and cause", () => {
    const cause = new NexusError("root cause", "E_PROTOCOL_ERROR");
    const error = new NexusError("top level", "E_REMOTE_EXCEPTION", {
      cause: toSerializedError(cause),
    });

    const serialized = toSerializedError(error);

    expect(serialized.name).toBe("NexusError");
    expect(serialized.code).toBe("E_REMOTE_EXCEPTION");
    expect(serialized.message).toBe("top level");
    expect(serialized.cause).toMatchObject({
      name: "NexusError",
      code: "E_PROTOCOL_ERROR",
      message: "root cause",
    });
  });

  it("normalizes unknown values into NexusError", () => {
    const normalized = fromUnknownError("raw failure", {
      code: "E_USAGE_INVALID",
      name: "WrappedUnknown",
    });

    expect(normalized).toBeInstanceOf(NexusError);
    expect(normalized.code).toBe("E_USAGE_INVALID");
    expect(normalized.name).toBe("WrappedUnknown");
    expect(normalized.message).toBe("raw failure");
  });

  it("normalizes native Error while preserving stack", () => {
    const original = new Error("boom");
    const normalized = fromUnknownError(original, {
      code: "E_UNKNOWN",
      name: "NativeWrapped",
    });

    expect(normalized.code).toBe("E_UNKNOWN");
    expect(normalized.name).toBe("NativeWrapped");
    expect(normalized.stack).toBeDefined();
  });

  it("wraps unknown cause into serialized form", () => {
    const wrapped = wrapCause(
      "endpoint failed",
      "E_ENDPOINT_CONNECT_FAILED",
      new Error("port unavailable"),
    );

    expect(wrapped.code).toBe("E_ENDPOINT_CONNECT_FAILED");
    expect(wrapped.cause).toMatchObject({
      name: "Error",
      code: "E_UNKNOWN",
      message: "port unavailable",
    });
  });
});
