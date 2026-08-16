import { describe, expect, it } from "vitest";
import { TargetResolver } from "./target-resolver";

type TestModel = {
  contextMeta: { context: "bg" | "cs" };
  connectionMeta: object;
  connectionTarget: { context: "bg" } | { context: "cs"; id: string };
};

describe("TargetResolver.resolveUnicastTarget", () => {
  it("uses explicit target before Token and endpoint defaults", () => {
    const result = TargetResolver.resolveUnicastTarget<TestModel>(
      { context: "cs", id: "explicit" },
      { context: "bg" },
      { context: "cs", id: "endpoint" },
      "service",
    );
    expect(result).toMatchObject({ value: { context: "cs", id: "explicit" } });
  });

  it("uses Token default before endpoint default", () => {
    const result = TargetResolver.resolveUnicastTarget<TestModel>(
      undefined,
      { context: "bg" },
      { context: "cs", id: "endpoint" },
      "service",
    );
    expect(result).toMatchObject({ value: { context: "bg" } });
  });

  it("requires a target when all sources are absent", () => {
    const result = TargetResolver.resolveUnicastTarget<TestModel>(
      undefined,
      undefined,
      undefined,
      "service",
    );
    expect(result).toMatchObject({ error: { code: "E_TARGET_REQUIRED" } });
  });
});
