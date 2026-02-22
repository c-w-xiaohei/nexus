import { describe, expect, it } from "vitest";
import { NexusUsageError } from "./usage-errors";

describe("NexusUsageError", () => {
  it("treats ambiguous objects as context", () => {
    const error = new NexusUsageError("bad input", "E_USAGE_INVALID", {
      cause: "field value",
      field: "target",
    });

    expect(error.context).toEqual({
      cause: "field value",
      field: "target",
    });
    expect(error.cause).toBeUndefined();
  });

  it("preserves cause while merging extra context keys", () => {
    const error = new NexusUsageError("bad input", "E_USAGE_INVALID", {
      cause: { name: "Cause", code: "E_UNKNOWN", message: "x" },
      tokenId: "service-1",
    });

    expect(error.cause).toEqual({
      name: "Cause",
      code: "E_UNKNOWN",
      message: "x",
    });
    expect(error.context).toEqual({ tokenId: "service-1" });
  });
});
