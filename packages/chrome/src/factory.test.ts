import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBackgroundScriptConfig,
  createContentScriptConfig,
  createPopupConfig,
  createOptionsPageConfig,
  createExtensionPageConfig,
  usingBackgroundScript,
  usingContentScript,
  usingPopup,
  usingExtensionPage,
  usingOptionsPage,
  usingOffscreenDocument,
  createSidePanelConfig,
  usingSidePanel,
} from "./factory";
import { nexus } from "@nexus-js/core";
import type { ChromeContextMeta } from "./types/meta";
import { chromePortName } from "./ports/chrome-port-name";

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
      removeListener: vi.fn(),
    },
    connect: vi.fn(() => ({ ...mockPort, sender: undefined })),
  },
  tabs: {
    query: vi.fn(),
    connect: vi.fn(() => ({ ...mockPort, sender: undefined })),
  },
  windows: {
    WINDOW_ID_CURRENT: 1,
    getCurrent: vi.fn(async () => ({ id: 456 })),
  },
  devtools: {
    inspectedWindow: {
      tabId: 123,
    },
  },
};

type TestLock = { readonly name: string };
type LockCallback = (lock: TestLock | null) => Promise<unknown> | unknown;
type PendingLockRequest = {
  name: string;
  callback: LockCallback;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
  rejection?: unknown;
};

function createLockManagerFake() {
  const heldNames = new Set<string>();
  const pending: PendingLockRequest[] = [];
  const active = new Set<Promise<void>>();
  let deferred = false;

  const settle = async (request: PendingLockRequest): Promise<void> => {
    if (request.settled) return;
    request.settled = true;
    if (request.rejection !== undefined) {
      request.reject(request.rejection);
      return;
    }

    const lock = heldNames.has(request.name) ? null : { name: request.name };
    if (lock) heldNames.add(request.name);
    try {
      request.resolve(await request.callback(lock));
    } catch (error) {
      request.reject(error);
    } finally {
      if (lock) heldNames.delete(request.name);
    }
  };

  const start = (request: PendingLockRequest) => {
    const task = settle(request);
    active.add(task);
    void task.finally(() => active.delete(task));
  };

  const request = vi.fn(
    (
      name: string,
      _options: { ifAvailable?: boolean },
      callback: LockCallback,
    ) => {
      const promise = new Promise<unknown>((resolve, reject) => {
        const pendingRequest: PendingLockRequest = {
          name,
          callback,
          resolve,
          reject,
          settled: false,
        };
        pending.push(pendingRequest);
        if (!deferred) queueMicrotask(() => start(pendingRequest));
      });
      promise.catch(() => undefined);
      return promise;
    },
  );

  return {
    request,
    deferRequests: () => {
      deferred = true;
    },
    resolveNext: async () => {
      const next = pending.find((candidate) => !candidate.settled);
      if (!next) throw new Error("No pending Web Lock request.");
      start(next);
      await Promise.all(active);
    },
    rejectNext: async (error: unknown) => {
      const next = pending.find((candidate) => !candidate.settled);
      if (!next) throw new Error("No pending Web Lock request.");
      next.rejection = error;
      start(next);
      await Promise.all(active);
    },
    waitForIdle: async () => {
      while (active.size > 0) await Promise.all([...active]);
    },
    isHeld: (name: string) => heldNames.has(name),
  };
}

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
  const optionsLockName = "nexus.chrome/1/options-page";
  const listeningEndpoints: Array<{ close(): void }> = [];
  let locks: ReturnType<typeof createLockManagerFake>;

  beforeEach(() => {
    vi.clearAllMocks();
    locks = createLockManagerFake();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks },
    });
  });

  afterEach(() => {
    for (const endpoint of listeningEndpoints.splice(0)) endpoint.close();
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
    it("is sync and resolves its route during readiness", () => {
      const popup = usingPopup();

      expect(popup).toBeDefined();
      expect(popup).not.toBeInstanceOf(Promise);
      expect(mockChrome.tabs.query).not.toHaveBeenCalled();
    });
  });

  describe("createPopupConfig", () => {
    it("keeps startup configuration separate from metadata and the default target", () => {
      const config = createPopupConfig({
        connectTo: [],
      });

      expect(config.endpoint?.connectTo).toEqual([]);
      expect(config.endpoint?.meta).toEqual({
        context: "popup",
      });
      expect(mockChrome.tabs.query).not.toHaveBeenCalled();
    });

    it("derives the receiver route from the popup's current window", async () => {
      const endpoint = createPopupConfig().endpoint!.implementation;
      const accept = vi.fn();

      await endpoint.listen?.(accept);

      expect(mockChrome.windows.getCurrent).toHaveBeenCalledOnce();
      expect(mockChrome.runtime.onConnect.addListener).toHaveBeenCalledOnce();

      const [nativeListener] =
        mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
      nativeListener({
        ...mockPort,
        name: chromePortName.page({ kind: "popup", windowId: 456 }),
        sender: undefined,
      });

      expect(accept).toHaveBeenCalledOnce();
    });

    it.each([
      [undefined, "missing"],
      [-1, "negative"],
    ])(
      "rejects a %s current popup window ID",
      async (id: number | undefined, _label: string) => {
        mockChrome.windows.getCurrent.mockResolvedValueOnce({
          id,
        } as unknown as { id: number });
        const endpoint = createPopupConfig().endpoint!.implementation;

        await expect(endpoint.listen?.(vi.fn())).rejects.toThrow(
          "Chrome did not expose a concrete current window ID.",
        );
      },
    );
  });

  describe("createExtensionPageConfig", () => {
    it("creates a background-connected custom extension page config without side panel calls", () => {
      const sidePanel = { getOptions: vi.fn() };
      Object.assign(mockChrome, { sidePanel });

      const connectTo = [{ kind: "background" as const }];
      const config = createExtensionPageConfig(
        { context: "extension-page", page: "settings.html" },
        { connectTo },
      );

      expect(config.endpoint?.connectTo).toEqual(connectTo);
      expect(config.endpoint?.meta).toEqual({
        context: "extension-page",
        page: "settings.html",
      });
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

  it("does not use the current-window sentinel as a concrete route", () => {
    const config = createOptionsPageConfig();

    expect(config.endpoint?.meta).toEqual({
      context: "options-page",
    });
    expect(config.endpoint?.implementation).toBeDefined();
  });

  describe("Options receiver lock", () => {
    it("acquires the named Web Lock before becoming ready", async () => {
      const endpoint = createOptionsPageConfig().endpoint!.implementation;
      const onConnect = vi.fn();
      listeningEndpoints.push(endpoint);

      await endpoint.listen?.(onConnect);

      expect(locks.request).toHaveBeenCalledWith(
        optionsLockName,
        { ifAvailable: true },
        expect.any(Function),
      );
      expect(locks.isHeld(optionsLockName)).toBe(true);

      const [nativeListener] =
        mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
      nativeListener({
        ...mockPort,
        name: chromePortName.page({ kind: "options-page" }),
        sender: undefined,
      });

      expect(onConnect).toHaveBeenCalledOnce();
    });

    it("rejects a duplicate and does not deliver its Ports to Core", async () => {
      const owner = createOptionsPageConfig().endpoint!.implementation;
      const duplicate = createOptionsPageConfig().endpoint!.implementation;
      const ownerListener = vi.fn();
      const duplicateListener = vi.fn();
      listeningEndpoints.push(owner, duplicate);

      await owner.listen?.(ownerListener);
      const duplicateListening = duplicate.listen?.(duplicateListener);
      const [duplicateNativeListener] =
        mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
      duplicateNativeListener({
        ...mockPort,
        name: chromePortName.page({ kind: "options-page" }),
        sender: undefined,
      });

      await expect(duplicateListening).rejects.toThrow(
        `Chrome receiver '${optionsLockName}' is already active.`,
      );
      expect(duplicateListener).not.toHaveBeenCalled();
      expect(mockChrome.runtime.onConnect.removeListener).toHaveBeenCalledWith(
        duplicateNativeListener,
      );
    });

    it("releases ownership on close so a replacement can acquire it", async () => {
      const owner = createOptionsPageConfig().endpoint!.implementation;
      const replacement = createOptionsPageConfig().endpoint!.implementation;
      listeningEndpoints.push(owner, replacement);

      await owner.listen?.(vi.fn());
      expect(locks.isHeld(optionsLockName)).toBe(true);

      owner.close();
      await locks.waitForIdle();
      expect(locks.isHeld(optionsLockName)).toBe(false);

      await replacement.listen?.(vi.fn());

      expect(locks.isHeld(optionsLockName)).toBe(true);
    });

    it("does not leak a pending lock or buffered Port when closed", async () => {
      locks.deferRequests();
      const endpoint = createOptionsPageConfig().endpoint!.implementation;
      const onConnect = vi.fn();
      listeningEndpoints.push(endpoint);
      const listening = endpoint.listen?.(onConnect);
      const [nativeListener] =
        mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;

      nativeListener({
        ...mockPort,
        name: chromePortName.page({ kind: "options-page" }),
        sender: undefined,
      });
      endpoint.close();
      await locks.resolveNext();
      await listening;

      expect(locks.isHeld(optionsLockName)).toBe(false);
      expect(onConnect).not.toHaveBeenCalled();
    });

    it("rejects listen and removes the native listener when lock request rejects", async () => {
      const error = new Error("Web Locks unavailable.");
      const endpoint = createOptionsPageConfig().endpoint!.implementation;
      listeningEndpoints.push(endpoint);
      const listening = endpoint.listen?.(vi.fn());
      const [nativeListener] =
        mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;

      await locks.rejectNext(error);
      await expect(listening).rejects.toBe(error);

      expect(mockChrome.runtime.onConnect.removeListener).toHaveBeenCalledWith(
        nativeListener,
      );
    });
  });

  it("creates a side panel without receiver route configuration", () => {
    const config = createSidePanelConfig();

    expect(config.endpoint?.meta).toEqual({
      context: "side-panel",
    });
    expect(usingSidePanel()).toBeDefined();
  });

  it("derives the Side Panel receiver route from its current window", async () => {
    mockChrome.windows.getCurrent.mockResolvedValueOnce({ id: 456 });
    const endpoint = createSidePanelConfig().endpoint!.implementation;
    const accept = vi.fn();

    await endpoint.listen?.(accept);

    expect(mockChrome.windows.getCurrent).toHaveBeenCalledOnce();

    const [nativeListener] =
      mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
    nativeListener({
      ...mockPort,
      name: chromePortName.page({ kind: "side-panel", windowId: 456 }),
      sender: undefined,
    });

    expect(accept).toHaveBeenCalledOnce();
  });

  it.each([
    [undefined, "missing"],
    [-1, "negative"],
  ])(
    "rejects a %s current side panel window ID",
    async (id: number | undefined, _label: string) => {
      mockChrome.windows.getCurrent.mockResolvedValueOnce({
        id,
      } as unknown as { id: number });
      const endpoint = createSidePanelConfig().endpoint!.implementation;

      await expect(endpoint.listen?.(vi.fn())).rejects.toThrow(
        "Chrome did not expose a concrete current window ID.",
      );
    },
  );

  describe("usingExtensionPage", () => {
    it("configures custom extension page config", () => {
      const configureSpy = vi.spyOn(nexus, "configure");

      const instance = usingExtensionPage(
        { context: "extension-page", page: "settings.html" },
        { connectTo: [] },
      );

      expect(instance).toBeDefined();
      expect(configureSpy).toHaveBeenCalledOnce();
      expect(configureSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: expect.objectContaining({ connectTo: [] }),
        }),
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
