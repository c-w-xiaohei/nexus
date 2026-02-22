import { describe, expect, it } from "vitest";
import { TargetResolver } from "./target-resolver";

type Meta = { context: "bg" | "cs"; active?: boolean };

describe("TargetResolver.resolveNamedTarget", () => {
  it("should resolve named descriptor and matcher", () => {
    const result = TargetResolver.resolveNamedTarget<Meta>(
      { descriptor: "bg", matcher: "active" },
      new Map([["bg", { context: "bg" as const }]]),
      new Map([["active", (identity: Meta) => identity.active === true]]),
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.descriptor).toEqual({ context: "bg" });
      expect(result.value.matcher?.({ context: "cs", active: true })).toBe(
        true,
      );
    }
  });

  it("should return configuration error when named descriptor is missing", () => {
    const result = TargetResolver.resolveNamedTarget<Meta>(
      { descriptor: "missing" },
      new Map(),
      new Map(),
      "in connectTo",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("missing");
      expect(result.error.message).toContain("in connectTo");
    }
  });

  it("should return configuration error when named matcher is missing", () => {
    const result = TargetResolver.resolveNamedTarget<Meta>(
      { matcher: "missing" },
      new Map(),
      new Map(),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('Matcher with name "missing"');
    }
  });
});

describe("TargetResolver.resolveUnicastTarget", () => {
  it("should keep explicit options target with highest priority", () => {
    const result = TargetResolver.resolveUnicastTarget<Meta>(
      { descriptor: { context: "cs" } },
      { descriptor: { context: "bg" } },
      [{ descriptor: { context: "bg" } }],
      "token-a",
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ descriptor: { context: "cs" } });
    }
  });

  it("should fallback to token default target then connectTo singleton", () => {
    const useTokenDefault = TargetResolver.resolveUnicastTarget<Meta>(
      {},
      { descriptor: { context: "bg" } },
      undefined,
      "token-b",
    );
    expect(useTokenDefault.isOk()).toBe(true);
    if (useTokenDefault.isOk()) {
      expect(useTokenDefault.value).toEqual({ descriptor: { context: "bg" } });
    }

    const useConnectTo = TargetResolver.resolveUnicastTarget<Meta>(
      {},
      undefined,
      [{ descriptor: { context: "cs" } }],
      "token-c",
    );
    expect(useConnectTo.isOk()).toBe(true);
    if (useConnectTo.isOk()) {
      expect(useConnectTo.value).toEqual({ descriptor: { context: "cs" } });
    }
  });

  it("should return error for ambiguous connectTo and empty target", () => {
    const ambiguous = TargetResolver.resolveUnicastTarget<Meta>(
      {},
      undefined,
      [{ descriptor: { context: "bg" } }, { descriptor: { context: "cs" } }],
      "token-d",
    );
    expect(ambiguous.isErr()).toBe(true);
    if (ambiguous.isErr()) {
      expect(ambiguous.error.code).toBe("E_TARGET_UNEXPECTED_COUNT");
    }

    const missing = TargetResolver.resolveUnicastTarget<Meta>(
      {},
      undefined,
      undefined,
      "token-e",
    );
    expect(missing.isErr()).toBe(true);
    if (missing.isErr()) {
      expect(missing.error.code).toBe("E_TARGET_NO_MATCH");
    }
  });
});
