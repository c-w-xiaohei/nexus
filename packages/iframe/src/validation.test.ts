import { describe, expect, it } from "vitest";
import { originMatches } from "./validation";

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

  it("accepts wildcard origin only when allowAnyOrigin is true", () => {
    expect(originMatches("https://any.test", "*", true)).toBe(true);
    expect(originMatches("https://any.test", "*", false)).toBe(false);
    expect(originMatches("https://any.test", "*")).toBe(false);
  });
});
