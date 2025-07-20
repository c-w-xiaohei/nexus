import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  usingBackgroundScript,
  usingContentScript,
  usingOptionsPage,
  usingOffscreenDocument,
} from "./factory";

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

  describe("usingBackgroundScript", () => {
    it("should configure background script context correctly", () => {
      const nexus = usingBackgroundScript();

      expect(mockChrome.runtime.getManifest).toHaveBeenCalled();
      expect(nexus).toBeDefined();
    });
  });

  describe("usingContentScript", () => {
    it("should configure content script context correctly", () => {
      const nexus = usingContentScript();

      expect(nexus).toBeDefined();
      expect(global.document.addEventListener).toHaveBeenCalledWith(
        "visibilitychange",
        expect.any(Function)
      );
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
