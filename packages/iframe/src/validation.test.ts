import { describe, expect, it } from "vitest";
import { originMatches, targetOriginMatches } from "./validation.js";

describe("iframe origin matching", () => {
  it("accepts exact origin matches", () => {
    expect(originMatches("https://child.test", "https://child.test")).toBe(
      true,
    );
  });

  it("rejects mismatched origins", () => {
    expect(originMatches("https://evil.test", "https://child.test")).toBe(
      false,
    );
  });

  it("follows the exact and wildcard origin truth table", () => {
    const cases = [
      ["https://child.test", "https://child.test", false, true],
      ["https://evil.test", "https://child.test", false, false],
      ["https://any.test", "*", true, true],
      ["https://any.test", "*", false, false],
      ["https://any.test", "*", undefined, false],
      ["*", "*", true, false],
      ["*", "https://any.test", true, false],
    ] as const;

    for (const [actual, expected, allowAnyOrigin, result] of cases) {
      expect(originMatches(actual, expected, allowAnyOrigin)).toBe(result);
    }
  });

  it("separates wildcard connection targets from observed event origins", () => {
    expect(targetOriginMatches("*", "*", true)).toBe(true);
    expect(targetOriginMatches("https://parent.test", "*", true)).toBe(true);
    expect(targetOriginMatches("*", "https://parent.test", true)).toBe(false);
    expect(originMatches("*", "*", true)).toBe(false);
  });
});
