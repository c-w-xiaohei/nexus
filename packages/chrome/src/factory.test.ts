import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createBackgroundScriptConfig,
  createContentScriptConfig,
  createPopupConfig,
  createExtensionPageConfig,
  usingBackgroundScript,
  usingContentScript,
  usingPopup,
  usingExtensionPage,
  usingOptionsPage,
  usingOffscreenDocument,
} from "./factory";
import { nexus } from "@nexus-js/core";
import type { ChromeContextMeta } from "./types/meta";

const contextlessCustomMeta: ChromeContextMeta<
  never,
  // @ts-expect-error custom Chrome endpoint metadata must include a context discriminator.
  { customFlag: boolean }
> = {
  customFlag: true,
};
void contextlessCustomMeta;

// Mock Chrome APIs
const mockPort = {
  postMessage: vi.fn(),
  onMessage: {
    addListener: vi.fn(),
  },
  onDisconnect: {
    addListener: vi.fn(),
  },
  disconnect: vi.fn(),
};

const mockChrome = {
  runtime: {
    id: "test-extension-id",
    getManifest: vi.fn(() => ({ version: "1.0.0" })),
    onConnect: {
      addListener: vi.fn(),
    },
    connect: vi.fn(() => ({ ...mockPort, sender: undefined })),
  },
  tabs: {
    query: vi.fn(),
    connect: vi.fn(() => ({ ...mockPort, sender: undefined })),
  },
  windows: {
    WINDOW_ID_CURRENT: 1,
  },
  devtools: {
    inspectedWindow: {
      tabId: 123,
    },
  },
};

// @ts-ignore
global.chrome = mockChrome;

// Mock window and document for content script
Object.defineProperty(global, "window", {
  value: {
    location: {
      href: "https://example.com/page",
      origin: "https://example.com",
    },
  },
  writable: true,
});

Object.defineProperty(global, "document", {
  value: {
    hidden: false,
    addEventListener: vi.fn(),
  },
  writable: true,
});

describe("Chrome Factory Functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createBackgroundScriptConfig", () => {
    it("returns background config without configuring nexus", () => {
      const configureSpy = vi.spyOn(nexus, "configure");

      const config = createBackgroundScriptConfig();

      expect(config.endpoint?.meta).toMatchObject({
        context: "background",
        extensionId: "test-extension-id",
        version: "1.0.0",
      });
      expect(configureSpy).not.toHaveBeenCalled();
    });
  });

  describe("usingBackgroundScript", () => {
    it("should configure background script context correctly", () => {
      const configureSpy = vi.spyOn(nexus, "configure");

      const instance = usingBackgroundScript();

      expect(mockChrome.runtime.getManifest).toHaveBeenCalled();
      expect(instance).toBeDefined();
      expect(configureSpy).toHaveBeenCalledOnce();
    });
  });

  describe("createContentScriptConfig", () => {
    it("returns visible content script config without registering listeners", () => {
      const config = createContentScriptConfig();

      expect(config.endpoint?.meta).toEqual({
        context: "content-script",
        url: "https://example.com/page",
        origin: "https://example.com",
        isVisible: true,
      });
      expect(global.document.addEventListener).not.toHaveBeenCalled();
    });
  });

  describe("usingContentScript", () => {
    it("registers visibility listener and updates isVisible", () => {
      const nexus = usingContentScript();

      expect(nexus).toBeDefined();
      expect(global.document.addEventListener).toHaveBeenCalledWith(
        "visibilitychange",
        expect.any(Function),
      );

      const [, handler] = vi.mocked(global.document.addEventListener).mock
        .calls[0] as [string, (event: Event) => void];
      vi.spyOn(nexus, "updateIdentity").mockResolvedValue();
      Object.defineProperty(global.document, "hidden", {
        value: true,
        configurable: true,
      });

      handler(new Event("visibilitychange"));

      expect(nexus.updateIdentity).toHaveBeenCalledWith({
        isVisible: false,
      });
    });
  });

  describe("usingPopup", () => {
    it("is sync and does not query the active tab", () => {
      const popup = usingPopup({ tabId: 123, windowId: 456 });

      expect(popup).toBeDefined();
      expect(popup).not.toBeInstanceOf(Promise);
      expect(mockChrome.tabs.query).not.toHaveBeenCalled();
    });
  });

  describe("createPopupConfig", () => {
    it("uses caller-provided tab and window metadata", () => {
      const config = createPopupConfig({ tabId: 123, windowId: 456 });

      expect(config.endpoint?.meta).toEqual({
        context: "popup",
        tabId: 123,
        windowId: 456,
      });
      expect(mockChrome.tabs.query).not.toHaveBeenCalled();
    });
  });

  describe("createExtensionPageConfig", () => {
    it("creates a background-connected custom extension page config without side panel calls", () => {
      const sidePanel = { getOptions: vi.fn() };
      Object.assign(mockChrome, { sidePanel });

      const config = createExtensionPageConfig({
        context: "extension-page",
        page: "settings.html",
      });

      expect(config.endpoint?.meta).toEqual({
        context: "extension-page",
        page: "settings.html",
      });
      expect(config.endpoint?.defaultTarget).toEqual({ kind: "background" });
      expect(sidePanel.getOptions).not.toHaveBeenCalled();
    });

    it("rejects built-in Chrome contexts at runtime", () => {
      expect(() =>
        createExtensionPageConfig({ context: "popup" } as any),
      ).toThrow(
        "Custom extension page context cannot reuse built-in Chrome context 'popup'.",
      );
    });
  });

  describe("usingExtensionPage", () => {
    it("configures custom extension page config", () => {
      const configureSpy = vi.spyOn(nexus, "configure");

      const instance = usingExtensionPage({
        context: "extension-page",
        page: "settings.html",
      });

      expect(instance).toBeDefined();
      expect(configureSpy).toHaveBeenCalledOnce();
    });
  });

  describe("usingOptionsPage", () => {
    it("should configure options page context correctly", () => {
      const nexus = usingOptionsPage();

      expect(nexus).toBeDefined();
    });
  });

  describe("usingOffscreenDocument", () => {
    it("should configure offscreen document context correctly", () => {
      const reason = "audio-processing";
      const nexus = usingOffscreenDocument(reason);

      expect(nexus).toBeDefined();
    });
  });
});
