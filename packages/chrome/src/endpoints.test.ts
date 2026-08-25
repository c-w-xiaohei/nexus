import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundEndpoint } from "./endpoints/background";
import {
  createChromeConnectionMeta,
  matchesChromeTarget,
} from "./endpoints/connection-meta";
import { ContentScriptEndpoint } from "./endpoints/content-script";
import { UIClientEndpoint } from "./endpoints/ui-client";
import { chromeTarget } from "./types/meta";

const mockPort = {
  postMessage: vi.fn(),
  onMessage: { addListener: vi.fn() },
  onDisconnect: { addListener: vi.fn() },
  disconnect: vi.fn(),
};

const mockChrome = {
  runtime: {
    connect: vi.fn(() => ({ ...mockPort, sender: undefined })),
    onConnect: { addListener: vi.fn() },
  },
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
  beforeEach(() => vi.clearAllMocks());

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
    });
    expect(mockChrome.tabs.connect).toHaveBeenNthCalledWith(2, 7, {
      documentId: "doc-7",
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

  it("copies and freezes connection observations without retaining sender objects", () => {
    const sender = {
      tab: { id: 7, windowId: 3 },
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
      sender: { tab: { id: 7, windowId: 3 }, frameId: 2, documentId: "doc-7" },
    });
    expect(() => {
      (meta.observed.sender!.tab as { id?: number }).id = 99;
    }).toThrow(TypeError);
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
    const ui = new UIClientEndpoint();

    await expect(
      background.connect(chromeTarget.background()),
    ).rejects.toMatchObject({
      code: "E_ENDPOINT_CONNECT_FAILED",
    });
    await expect(
      content.connect(chromeTarget.contentFrame({ tabId: 7, frameId: 2 })),
    ).rejects.toMatchObject({ code: "E_ENDPOINT_CONNECT_FAILED" });
    await expect(
      ui.connect(
        chromeTarget.contentDocument({ tabId: 7, documentId: "doc-7" }),
      ),
    ).rejects.toMatchObject({ code: "E_ENDPOINT_CONNECT_FAILED" });
    expect(mockChrome.tabs.connect).not.toHaveBeenCalled();
    expect(mockChrome.runtime.connect).not.toHaveBeenCalled();
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

    expect(background).toEqual({ kind: "background" });
    expect(frame).toEqual({ kind: "content-frame", tabId: 7, frameId: 2 });
    expect(document).toEqual({
      kind: "content-document",
      tabId: 7,
      documentId: "doc-7",
    });
    expect(Object.isFrozen(background)).toBe(true);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(document)).toBe(true);
  });
});
