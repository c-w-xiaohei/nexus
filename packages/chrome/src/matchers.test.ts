import { describe, expect, it } from "vitest";
import { ChromeMatchers } from "./matchers";

describe("ChromeMatchers", () => {
  it("matches visible content scripts", () => {
    expect(
      ChromeMatchers.visibleContentScript({
        context: "content-script",
        url: "https://example.com/page",
        origin: "https://example.com",
        isVisible: true,
      }),
    ).toBe(true);
    expect(
      ChromeMatchers.visibleContentScript({
        context: "content-script",
        url: "https://example.com/page",
        origin: "https://example.com",
      }),
    ).toBe(false);
  });

  it("matches content scripts in a tab only when tabId is present", () => {
    const inTab = ChromeMatchers.contentScriptInTab(123);

    expect(
      inTab({
        context: "content-script",
        url: "https://example.com/page",
        origin: "https://example.com",
        tabId: 123,
      }),
    ).toBe(true);
    expect(
      inTab({
        context: "content-script",
        url: "https://example.com/page",
        origin: "https://example.com",
      }),
    ).toBe(false);
  });

  it("matches content scripts in a frame only when tabId and frameId are present", () => {
    const inFrame = ChromeMatchers.contentScriptInFrame(123, 5);

    expect(
      inFrame({
        context: "content-script",
        url: "https://example.com/page",
        origin: "https://example.com",
        tabId: 123,
        frameId: 5,
      }),
    ).toBe(true);
    expect(
      inFrame({
        context: "content-script",
        url: "https://example.com/page",
        origin: "https://example.com",
        tabId: 123,
      }),
    ).toBe(false);
  });
});
