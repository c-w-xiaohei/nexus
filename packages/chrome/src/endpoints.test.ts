import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundEndpoint } from "./endpoints/background";
import {
  createChromeConnectionMeta,
  matchesChromeTarget,
} from "./endpoints/connection-meta";
import { ContentScriptEndpoint } from "./endpoints/content-script";
import { UIClientEndpoint } from "./endpoints/ui-client";
import { chromeTarget, type ChromePageTarget } from "./types/meta";
import { chromePortName } from "./ports/chrome-port-name";

const mockPort = {
  postMessage: vi.fn(),
  onMessage: { addListener: vi.fn() },
  onDisconnect: { addListener: vi.fn() },
  disconnect: vi.fn(),
};

function createTestPort(name: string) {
  const disconnectListeners: Array<() => void> = [];
  return {
    name,
    postMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: {
      addListener: vi.fn((listener: () => void) => {
        disconnectListeners.push(listener);
      }),
    },
    disconnect: vi.fn(),
    sender: undefined,
    emitDisconnect: () => {
      for (const listener of disconnectListeners) listener();
    },
  };
}

const mockChrome = {
  runtime: {
    connect: vi.fn(() => ({ ...mockPort, sender: undefined })),
    onConnect: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  windows: { getCurrent: vi.fn() },
  tabs: {
    connect: vi.fn(() => ({
      ...mockPort,
      sender: { tab: { id: 7 }, frameId: 2, documentId: "doc-7" },
    })),
  },
};

// @ts-expect-error test-only Chrome API stub
global.chrome = mockChrome;

describe("Chrome endpoint connection metadata", () => {
  const listeningEndpoints: Array<{ close(): void }> = [];
  beforeEach(() => {
    vi.clearAllMocks();
    mockChrome.runtime.connect.mockImplementation(() => ({
      ...mockPort,
      sender: undefined,
    }));
    mockChrome.tabs.connect.mockImplementation(() => ({
      ...mockPort,
      sender: { tab: { id: 7 }, frameId: 2, documentId: "doc-7" },
    }));
  });
  afterEach(() => {
    for (const endpoint of listeningEndpoints.splice(0)) endpoint.close();
  });

  it("keeps the selected outgoing route private while allowing exact reuse", async () => {
    const endpoint = new BackgroundEndpoint();
    const target = chromeTarget.contentDocument({
      tabId: 7,
      documentId: "doc-7",
    });
    const result = await endpoint.connect(target);

    expect(Reflect.ownKeys(result.connectionMeta)).toEqual(["observed"]);
    expect(
      endpoint.matchesTarget(
        target,
        {
          context: "content-script",
          url: "https://example.com",
          origin: "https://example.com",
        },
        result.connectionMeta,
      ),
    ).toBe(true);
  });

  it("routes frame and document targets through tabs.connect", async () => {
    const endpoint = new BackgroundEndpoint();

    await endpoint.connect(chromeTarget.contentFrame({ tabId: 7, frameId: 2 }));
    await endpoint.connect(
      chromeTarget.contentDocument({ tabId: 7, documentId: "doc-7" }),
    );

    expect(mockChrome.tabs.connect).toHaveBeenNthCalledWith(1, 7, {
      frameId: 2,
      name: chromePortName.contentScript,
    });
    expect(mockChrome.tabs.connect).toHaveBeenNthCalledWith(2, 7, {
      documentId: "doc-7",
      name: chromePortName.contentScript,
    });
  });

  it("matches incoming connections only using observed sender facts", () => {
    const meta = createChromeConnectionMeta({
      tab: { id: 7, windowId: 3 } as chrome.tabs.Tab,
      frameId: 2,
      documentId: "doc-7",
    });
    const contextMeta = {
      context: "content-script" as const,
      url: "https://example.com",
      origin: "https://example.com",
    };

    expect(
      matchesChromeTarget(
        chromeTarget.contentFrame({ tabId: 7, frameId: 2 }),
        contextMeta,
        meta,
      ),
    ).toBe(true);
    expect(
      matchesChromeTarget(
        chromeTarget.contentDocument({ tabId: 7, documentId: "doc-7" }),
        contextMeta,
        meta,
      ),
    ).toBe(true);
    expect(
      matchesChromeTarget(
        chromeTarget.contentFrame({ tabId: 7, frameId: 3 }),
        contextMeta,
        meta,
      ),
    ).toBe(false);
  });

  it("snapshots a selected route before callers can mutate it", () => {
    const selectedTarget = {
      kind: "content-frame" as const,
      tabId: 7,
      frameId: 2,
    };
    const meta = createChromeConnectionMeta(undefined, selectedTarget);
    const contextMeta = {
      context: "content-script" as const,
      url: "https://example.com",
      origin: "https://example.com",
    };

    selectedTarget.frameId = 3;

    expect(
      matchesChromeTarget(
        chromeTarget.contentFrame({ tabId: 7, frameId: 2 }),
        contextMeta,
        meta,
      ),
    ).toBe(true);
    expect(
      matchesChromeTarget(
        chromeTarget.contentFrame({ tabId: 7, frameId: 3 }),
        contextMeta,
        meta,
      ),
    ).toBe(false);
  });

  it("does not reuse an exact extension-page route as background", () => {
    const pageMeta = createChromeConnectionMeta(
      undefined,
      chromeTarget.extensionPage({ endpointId: "settings" }),
    );

    expect(
      matchesChromeTarget(
        chromeTarget.background(),
        { context: "background", extensionId: "extension-id" },
        pageMeta,
      ),
    ).toBe(false);
  });

  it("copies and freezes connection observations without retaining sender objects", () => {
    const sender = {
      tab: { id: 7, windowId: 3, incognito: true },
      frameId: 2,
      documentId: "doc-7",
      url: "https://example.com",
    } as chrome.runtime.MessageSender;
    const meta = createChromeConnectionMeta(sender);

    expect(Object.isFrozen(meta)).toBe(true);
    expect(Object.isFrozen(meta.observed)).toBe(true);
    expect(Object.isFrozen(meta.observed.sender)).toBe(true);
    expect(Object.isFrozen(meta.observed.sender?.tab)).toBe(true);
    expect(meta.observed.sender).not.toBe(sender);
    expect(meta.observed.sender?.tab).not.toBe(sender.tab);
    sender.tab!.id = 99;
    sender.frameId = 8;
    sender.documentId = "doc-8";

    expect(meta.observed).toMatchObject({
      tabId: 7,
      frameId: 2,
      documentId: "doc-7",
      sender: {
        tab: { id: 7, windowId: 3, incognito: true },
        frameId: 2,
        documentId: "doc-7",
      },
    });
    expect(() => {
      (meta.observed.sender!.tab as { id?: number }).id = 99;
    }).toThrow(TypeError);
  });

  it("preserves sender identity and lifecycle observations", () => {
    const meta = createChromeConnectionMeta({
      id: "extension-id",
      origin: "https://example.test",
      documentLifecycle: "active",
      tab: { id: 7, incognito: true } as chrome.tabs.Tab,
    });

    expect(meta.observed).toMatchObject({
      incognito: true,
      sender: {
        id: "extension-id",
        origin: "https://example.test",
        documentLifecycle: "active",
      },
    });
  });

  it("reports only synchronous unsupported document selection as a capability mismatch", async () => {
    const endpoint = new BackgroundEndpoint();
    mockChrome.tabs.connect = vi.fn(() => {
      throw new TypeError("Unexpected property: documentId");
    }) as typeof mockChrome.tabs.connect;

    await expect(
      endpoint.connect(
        chromeTarget.contentDocument({ tabId: 7, documentId: "doc-7" }),
      ),
    ).rejects.toMatchObject({ code: "E_ENDPOINT_CAPABILITY_MISMATCH" });
  });

  it("rejects unsupported endpoint target kinds without opening a Chrome port", async () => {
    const background = new BackgroundEndpoint();
    const content = new ContentScriptEndpoint();

    await expect(
      background.connect(chromeTarget.background()),
    ).rejects.toMatchObject({
      code: "E_ENDPOINT_CONNECT_FAILED",
    });
    await expect(
      content.connect(chromeTarget.contentFrame({ tabId: 7, frameId: 2 })),
    ).rejects.toMatchObject({ code: "E_ENDPOINT_CONNECT_FAILED" });
    expect(mockChrome.tabs.connect).not.toHaveBeenCalled();
    expect(mockChrome.runtime.connect).not.toHaveBeenCalled();
  });

  it("allows ordinary extension pages to dial exact content targets", async () => {
    const endpoint = new UIClientEndpoint();
    const target = chromeTarget.contentDocument({
      tabId: 7,
      documentId: "doc-7",
    });

    await endpoint.connect(target);

    expect(mockChrome.tabs.connect).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ documentId: "doc-7" }),
    );
  });

  it("declares that every Chrome endpoint does not support transferables", () => {
    for (const endpoint of [
      new BackgroundEndpoint(),
      new ContentScriptEndpoint(),
      new UIClientEndpoint(),
    ]) {
      expect(endpoint.capabilities).toEqual({ supportsTransferables: false });
    }
  });

  it("builds frozen, tagged exact targets", () => {
    const background = chromeTarget.background();
    const frame = chromeTarget.contentFrame({ tabId: 7, frameId: 2 });
    const document = chromeTarget.contentDocument({
      tabId: 7,
      documentId: "doc-7",
    });
    const offscreen = chromeTarget.offscreenDocument();
    const sidePanel = chromeTarget.sidePanel({ windowId: 7 });

    expect(background).toEqual({ kind: "background" });
    expect(frame).toEqual({ kind: "content-frame", tabId: 7, frameId: 2 });
    expect(document).toEqual({
      kind: "content-document",
      tabId: 7,
      documentId: "doc-7",
    });
    expect(offscreen).toEqual({ kind: "offscreen-document" });
    expect(sidePanel).toEqual({
      kind: "side-panel",
      windowId: 7,
    });
    expect(Object.isFrozen(background)).toBe(true);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(offscreen)).toBe(true);
    expect(Object.isFrozen(sidePanel)).toBe(true);
  });

  it("names native ports from their receiver target", () => {
    expect(
      chromePortName.page(
        chromeTarget.extensionPage({ endpointId: "settings/panel" }),
      ),
    ).toBe("nexus.chrome/1/extension-page/settings%2Fpanel");
    expect(chromePortName.page(chromeTarget.offscreenDocument())).toBe(
      "nexus.chrome/1/offscreen-document",
    );
    expect(chromePortName.page(chromeTarget.sidePanel({ windowId: 3 }))).toBe(
      "nexus.chrome/1/side-panel/window/3",
    );
    expect(chromePortName.background).toBe("nexus.chrome/1/background");
  });

  it("filters incoming runtime ports before handing them to Core", async () => {
    const listener = vi.fn();
    const endpoint = new BackgroundEndpoint();
    listeningEndpoints.push(endpoint);
    await endpoint.listen(listener);

    const [nativeListener] =
      mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
    nativeListener({
      name: "external-app-port",
      ...mockPort,
      sender: undefined,
    });
    nativeListener({
      name: chromePortName.background,
      ...mockPort,
      sender: undefined,
    });

    expect(listener).toHaveBeenCalledOnce();
  });

  it("accepts only the exact extension page address", async () => {
    const listener = vi.fn();
    const endpoint = new UIClientEndpoint({
      receiver: chromeTarget.extensionPage({ endpointId: "alpha" }),
    });
    listeningEndpoints.push(endpoint);
    await endpoint.listen(listener);

    const [nativeListener] =
      mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
    nativeListener({
      name: chromePortName.page(
        chromeTarget.extensionPage({ endpointId: "beta" }),
      ),
      ...mockPort,
      sender: undefined,
    });
    nativeListener({
      name: chromePortName.page(
        chromeTarget.extensionPage({ endpointId: "alpha" }),
      ),
      ...mockPort,
      sender: undefined,
    });

    expect(listener).toHaveBeenCalledOnce();
  });

  it("buffers matching ports until an async receiver route resolves", async () => {
    let resolveReceiver!: (target: ChromePageTarget) => void;
    const receiver = new Promise<ChromePageTarget>((resolve) => {
      resolveReceiver = resolve;
    });
    const listener = vi.fn();
    const endpoint = new UIClientEndpoint({
      receiver: () => receiver,
    });
    listeningEndpoints.push(endpoint);
    const listening = endpoint.listen(listener);
    const [nativeListener] =
      mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
    const target = chromeTarget.popup({ windowId: 3 });

    nativeListener({
      name: chromePortName.page(target),
      ...mockPort,
      sender: undefined,
    });
    expect(listener).not.toHaveBeenCalled();

    resolveReceiver(target);
    await listening;
    expect(listener).toHaveBeenCalledOnce();
  });

  it("delivers only exact buffered Nexus ports after async receiver resolution", async () => {
    let resolveReceiver!: (target: ChromePageTarget) => void;
    const receiver = new Promise<ChromePageTarget>((resolve) => {
      resolveReceiver = resolve;
    });
    const listener = vi.fn();
    const endpoint = new UIClientEndpoint({ receiver: () => receiver });
    listeningEndpoints.push(endpoint);
    const listening = endpoint.listen(listener);
    const [nativeListener] =
      mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
    const target = chromeTarget.popup({ windowId: 3 });

    nativeListener(createTestPort(chromePortName.page(target)));
    nativeListener(
      createTestPort(
        chromePortName.page(chromeTarget.sidePanel({ windowId: 3 })),
      ),
    );
    nativeListener(
      createTestPort(chromePortName.page(chromeTarget.offscreenDocument())),
    );
    expect(listener).not.toHaveBeenCalled();

    resolveReceiver(target);
    await listening;

    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not deliver a buffered port that disconnects before resolution", async () => {
    let resolveReceiver!: (target: ChromePageTarget) => void;
    const receiver = new Promise<ChromePageTarget>((resolve) => {
      resolveReceiver = resolve;
    });
    const listener = vi.fn();
    const endpoint = new UIClientEndpoint({ receiver: () => receiver });
    listeningEndpoints.push(endpoint);
    const listening = endpoint.listen(listener);
    const [nativeListener] =
      mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
    const target = chromeTarget.popup({ windowId: 3 });
    const port = createTestPort(chromePortName.page(target));

    nativeListener(port);
    port.emitDisconnect();
    resolveReceiver(target);
    await listening;

    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers no more than the pending port cap after resolution", async () => {
    let resolveReceiver!: (target: ChromePageTarget) => void;
    const receiver = new Promise<ChromePageTarget>((resolve) => {
      resolveReceiver = resolve;
    });
    const listener = vi.fn();
    const endpoint = new UIClientEndpoint({ receiver: () => receiver });
    listeningEndpoints.push(endpoint);
    const listening = endpoint.listen(listener);
    const [nativeListener] =
      mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
    const target = chromeTarget.popup({ windowId: 3 });

    for (let index = 0; index < 33; index += 1) {
      nativeListener(createTestPort(chromePortName.page(target)));
    }
    resolveReceiver(target);
    await listening;

    expect(listener).toHaveBeenCalledTimes(32);
  });

  it("stops async receiver delivery when closed before resolution", async () => {
    let resolveReceiver!: (target: ChromePageTarget) => void;
    const receiver = new Promise<ChromePageTarget>((resolve) => {
      resolveReceiver = resolve;
    });
    const listener = vi.fn();
    const endpoint = new UIClientEndpoint({ receiver: () => receiver });
    const listening = endpoint.listen(listener);
    const [nativeListener] =
      mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
    nativeListener(
      createTestPort(chromePortName.page(chromeTarget.popup({ windowId: 3 }))),
    );

    endpoint.close();
    resolveReceiver(chromeTarget.popup({ windowId: 3 }));
    await listening;

    expect(mockChrome.runtime.onConnect.removeListener).toHaveBeenCalledWith(
      nativeListener,
    );
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects listen with the receiver error and removes its native listener", async () => {
    const error = new Error("Unable to identify the current popup window.");
    const receiver = Promise.reject(error);
    const listener = vi.fn();
    const endpoint = new UIClientEndpoint({ receiver: () => receiver });
    const listening = endpoint.listen(listener);
    const [nativeListener] =
      mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
    nativeListener(
      createTestPort(chromePortName.page(chromeTarget.popup({ windowId: 3 }))),
    );

    await expect(listening).rejects.toBe(error);

    expect(mockChrome.runtime.onConnect.removeListener).toHaveBeenCalledWith(
      nativeListener,
    );
    expect(listener).not.toHaveBeenCalled();
  });

  it("filters unknown namespaces and protocol versions before Core", async () => {
    const listener = vi.fn();
    const endpoint = new BackgroundEndpoint();
    listeningEndpoints.push(endpoint);
    await endpoint.listen(listener);

    const [nativeListener] =
      mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;
    for (const name of [
      "external",
      "nexus.chrome/0/background",
      "nexus.chrome/2/background",
    ]) {
      nativeListener(createTestPort(name));
    }
    nativeListener(createTestPort(chromePortName.background));

    expect(listener).toHaveBeenCalledOnce();
  });

  it("delivers static receiver ports synchronously without pending behavior", async () => {
    const listener = vi.fn();
    const endpoint = new UIClientEndpoint({
      receiver: chromeTarget.offscreenDocument(),
    });
    listeningEndpoints.push(endpoint);
    const listening = endpoint.listen(listener);
    const [nativeListener] =
      mockChrome.runtime.onConnect.addListener.mock.calls.at(-1)!;

    nativeListener(
      createTestPort(chromePortName.page(chromeTarget.offscreenDocument())),
    );

    expect(listener).toHaveBeenCalledOnce();
    await listening;
  });

  it("uses exact extension page names for dialing and matching", async () => {
    const endpoint = new UIClientEndpoint({
      receiver: chromeTarget.extensionPage({ endpointId: "settings" }),
    });
    const target = chromeTarget.extensionPage({ endpointId: "other" });

    await endpoint.connect(target);

    expect(mockChrome.runtime.connect).toHaveBeenCalledWith({
      name: chromePortName.page(target),
    });
    expect(
      endpoint.matchesTarget(
        target,
        { context: "reports" } as any,
        createChromeConnectionMeta(undefined, target),
      ),
    ).toBe(true);
  });

  it("dials and matches built-in page targets without route strings", async () => {
    const endpoint = new UIClientEndpoint();
    const target = chromeTarget.offscreenDocument();

    await endpoint.connect(target);

    expect(mockChrome.runtime.connect).toHaveBeenCalledWith({
      name: chromePortName.page(target),
    });
    expect(
      endpoint.matchesTarget(
        target,
        { context: "offscreen-document", reason: "testing" },
        createChromeConnectionMeta(undefined, target),
      ),
    ).toBe(true);
  });

  it("rejects offscreen content dialing as an endpoint capability mismatch", async () => {
    const endpoint = new UIClientEndpoint({ canConnectContent: false });

    await expect(
      endpoint.connect(chromeTarget.contentFrame({ tabId: 7, frameId: 0 })),
    ).rejects.toMatchObject({ code: "E_ENDPOINT_CAPABILITY_MISMATCH" });
    expect(mockChrome.tabs.connect).not.toHaveBeenCalled();
  });
});
