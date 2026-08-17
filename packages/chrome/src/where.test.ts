import { describe, expect, it } from "vitest";
import {
  whereBackground,
  whereContentScript,
  whereContentScriptByOrigin,
  whereContentScriptByUrl,
  whereContentScriptInFrame,
  wherePopup,
  whereVisibleContentScript,
} from "./where";

const connectionMeta = { observed: { tabId: 7, frameId: 2 } };

describe("Chrome where predicates", () => {
  it("filters common Chrome contexts with both metadata sources", () => {
    expect(
      whereContentScript(
        {
          context: "content-script",
          url: "https://example.com",
          origin: "https://example.com",
        },
        connectionMeta,
      ),
    ).toBe(true);
    expect(
      whereContentScript(
        { context: "background", extensionId: "extension" },
        connectionMeta,
      ),
    ).toBe(false);
    expect(wherePopup({ context: "popup" }, connectionMeta)).toBe(true);
    expect(
      whereBackground(
        { context: "background", extensionId: "extension" },
        connectionMeta,
      ),
    ).toBe(true);
    expect(
      whereVisibleContentScript(
        {
          context: "content-script",
          url: "https://example.com",
          origin: "https://example.com",
          isVisible: true,
        },
        connectionMeta,
      ),
    ).toBe(true);
    expect(
      whereContentScriptInFrame(7, 2)(
        {
          context: "content-script",
          url: "https://example.com",
          origin: "https://example.com",
        },
        connectionMeta,
      ),
    ).toBe(true);
  });

  it("filters content scripts by declared URL and origin", () => {
    const contextMeta = {
      context: "content-script" as const,
      url: "https://github.com/example/issues",
      origin: "https://github.com",
    };
    expect(
      whereContentScriptByUrl("github.com")(contextMeta, connectionMeta),
    ).toBe(true);
    expect(
      whereContentScriptByUrl(/\/issues/)(contextMeta, connectionMeta),
    ).toBe(true);
    expect(
      whereContentScriptByOrigin("https://github.com")(
        contextMeta,
        connectionMeta,
      ),
    ).toBe(true);
  });
});
