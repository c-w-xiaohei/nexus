import { Nexus, Token } from "@nexus-js/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundEndpoint } from "./endpoints/background";
import { ContentScriptEndpoint } from "./endpoints/content-script";
import type { ChromeAdapterModel } from "./types/meta";
import { chromeTarget } from "./types/meta";

interface ContentService {
  identity(): string;
}

interface BackgroundService {
  ready(): string;
}

const ContentToken = new Token<ContentService, ChromeAdapterModel>(
  "chrome-targeting-content",
);
const BackgroundToken = new Token<BackgroundService, ChromeAdapterModel>(
  "chrome-targeting-background",
);

type Listener<T> = (value: T) => void;

function createLinkedPorts(options: {
  readonly clientSender?: chrome.runtime.MessageSender;
  readonly serverSender?: chrome.runtime.MessageSender;
}) {
  let clientMessageListener: Listener<unknown> | undefined;
  let serverMessageListener: Listener<unknown> | undefined;
  let clientDisconnectListener: (() => void) | undefined;
  let serverDisconnectListener: (() => void) | undefined;
  let disconnected = false;

  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    clientDisconnectListener?.();
    serverDisconnectListener?.();
  };

  const client = {
    sender: options.clientSender,
    postMessage: (message: unknown) =>
      setTimeout(() => serverMessageListener?.(message)),
    onMessage: {
      addListener: (listener: Listener<unknown>) =>
        (clientMessageListener = listener),
    },
    onDisconnect: {
      addListener: (listener: () => void) =>
        (clientDisconnectListener = listener),
    },
    disconnect,
  } as unknown as chrome.runtime.Port;
  const server = {
    sender: options.serverSender,
    postMessage: (message: unknown) =>
      setTimeout(() => clientMessageListener?.(message)),
    onMessage: {
      addListener: (listener: Listener<unknown>) =>
        (serverMessageListener = listener),
    },
    onDisconnect: {
      addListener: (listener: () => void) =>
        (serverDisconnectListener = listener),
    },
    disconnect,
  } as unknown as chrome.runtime.Port;

  return { client, server, disconnect };
}

describe("Chrome exact content-script targets", () => {
  let backgroundConnectListener: Listener<chrome.runtime.Port> | undefined;
  let contentConnectListener: Listener<chrome.runtime.Port> | undefined;
  let connectedPorts: ReturnType<typeof createLinkedPorts>[];
  let runtimeConnect: ReturnType<typeof vi.fn>;
  let tabsConnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connectedPorts = [];
    backgroundConnectListener = undefined;
    contentConnectListener = undefined;
    runtimeConnect = vi.fn(() => {
      const ports = createLinkedPorts({
        serverSender: {
          tab: { id: 7 } as chrome.tabs.Tab,
          frameId: 2,
          documentId: "doc-7",
        },
      });
      connectedPorts.push(ports);
      backgroundConnectListener?.(ports.server);
      return ports.client;
    });
    tabsConnect = vi.fn((_tabId: number, _info?: chrome.tabs.ConnectInfo) => {
      const ports = createLinkedPorts({
        // The content-script peer sees the background sender. The caller-side
        // background port cannot authoritatively identify the content document.
        clientSender: { id: "test-extension" },
      });
      connectedPorts.push(ports);
      contentConnectListener?.(ports.client);
      return ports.server;
    });
    global.chrome = {
      runtime: {
        onConnect: {
          addListener: (listener: Listener<chrome.runtime.Port>) => {
            if (!backgroundConnectListener)
              backgroundConnectListener = listener;
            else contentConnectListener = listener;
          },
        },
        connect: runtimeConnect,
      },
      tabs: { connect: tabsConnect },
    } as unknown as typeof chrome;
  });

  it("accepts a content-initiated connection and reuses it for an exact background-to-content RPC", async () => {
    const background = new Nexus<ChromeAdapterModel>().configure({
      endpoint: {
        meta: { context: "background", extensionId: "test" },
        implementation: new BackgroundEndpoint(),
      },
      providers: [
        { token: BackgroundToken, service: { ready: () => "background" } },
      ],
    });
    const content = new Nexus<ChromeAdapterModel>().configure({
      endpoint: {
        meta: {
          context: "content-script",
          url: "https://example.test",
          origin: "https://example.test",
        },
        implementation: new ContentScriptEndpoint(),
        defaultTarget: chromeTarget.background(),
      },
      providers: [
        { token: ContentToken, service: { identity: () => "tab-7-frame-2" } },
      ],
    });

    await background.ready();
    const backgroundProxy = await content.create(BackgroundToken);
    await expect(backgroundProxy.ready()).resolves.toBe("background");

    const contentProxy = await background.create(ContentToken, {
      target: chromeTarget.contentDocument({ tabId: 7, documentId: "doc-7" }),
    });

    await expect(contentProxy.identity()).resolves.toBe("tab-7-frame-2");
    expect(runtimeConnect).toHaveBeenCalledOnce();
    expect(tabsConnect).not.toHaveBeenCalled();
  });

  it("reuses an outgoing exact target from its private selected route", async () => {
    let policyConnectionMeta: object | undefined;
    const background = new Nexus<ChromeAdapterModel>().configure({
      endpoint: {
        meta: { context: "background", extensionId: "test" },
        implementation: new BackgroundEndpoint(),
      },
      policy: {
        canConnect: ({ connection }) => {
          policyConnectionMeta = connection;
          return true;
        },
      },
    });
    const content = new Nexus<ChromeAdapterModel>().configure({
      endpoint: {
        meta: {
          context: "content-script",
          url: "https://example.test",
          origin: "https://example.test",
        },
        implementation: new ContentScriptEndpoint(),
      },
      providers: [
        { token: ContentToken, service: { identity: () => "tab-8-frame-0" } },
      ],
    });

    await content.ready();
    const contentProxy = await background.create(ContentToken, {
      target: chromeTarget.contentFrame({ tabId: 8, frameId: 0 }),
    });

    await expect(contentProxy.identity()).resolves.toBe("tab-8-frame-0");
    const reusedProxy = await background.create(ContentToken, {
      target: chromeTarget.contentFrame({ tabId: 8, frameId: 0 }),
    });
    await expect(reusedProxy.identity()).resolves.toBe("tab-8-frame-0");
    expect(tabsConnect).toHaveBeenCalledWith(8, { frameId: 0 });
    expect(tabsConnect).toHaveBeenCalledOnce();
    expect(Reflect.ownKeys(policyConnectionMeta!)).toEqual(["observed"]);
  });

  it("does not reuse a connected content script in another frame", async () => {
    const background = new Nexus<ChromeAdapterModel>().configure({
      endpoint: {
        meta: { context: "background", extensionId: "test" },
        implementation: new BackgroundEndpoint(),
      },
      providers: [
        { token: BackgroundToken, service: { ready: () => "background" } },
      ],
    });
    const content = new Nexus<ChromeAdapterModel>().configure({
      endpoint: {
        meta: {
          context: "content-script",
          url: "https://example.test",
          origin: "https://example.test",
        },
        implementation: new ContentScriptEndpoint(),
        defaultTarget: chromeTarget.background(),
      },
      providers: [
        { token: ContentToken, service: { identity: () => "content" } },
      ],
    });

    await background.ready();
    const backgroundProxy = await content.create(BackgroundToken);
    await backgroundProxy.ready();

    const contentProxy = await background.create(ContentToken, {
      target: chromeTarget.contentFrame({ tabId: 7, frameId: 3 }),
    });

    await expect(contentProxy.identity()).resolves.toBe("content");
    expect(tabsConnect).toHaveBeenCalledWith(7, { frameId: 3 });
  });

  it("preserves synchronous document capability failures through public acquisition", async () => {
    tabsConnect = vi.fn(() => {
      throw new TypeError("Unexpected property: documentId");
    });
    global.chrome.tabs.connect = tabsConnect as typeof chrome.tabs.connect;
    const background = new Nexus<ChromeAdapterModel>().configure({
      endpoint: {
        meta: { context: "background", extensionId: "test" },
        implementation: new BackgroundEndpoint(),
      },
    });

    await expect(
      background.create(ContentToken, {
        target: chromeTarget.contentDocument({ tabId: 7, documentId: "doc-7" }),
      }),
    ).rejects.toMatchObject({ code: "E_ENDPOINT_CAPABILITY_MISMATCH" });
  });

  it("classifies an asynchronous Port disconnect as a handshake failure", async () => {
    tabsConnect = vi.fn((_tabId: number, _info?: chrome.tabs.ConnectInfo) => {
      const ports = createLinkedPorts({
        clientSender: { id: "test-extension" },
      });
      setTimeout(ports.disconnect);
      return ports.server;
    });
    global.chrome.tabs.connect = tabsConnect as typeof chrome.tabs.connect;
    const background = new Nexus<ChromeAdapterModel>().configure({
      endpoint: {
        meta: { context: "background", extensionId: "test" },
        implementation: new BackgroundEndpoint(),
      },
    });

    await expect(
      background.create(ContentToken, {
        target: chromeTarget.contentFrame({ tabId: 7, frameId: 2 }),
        timeout: 100,
      }),
    ).rejects.toMatchObject({ code: "E_HANDSHAKE_FAILED" });
  });

  it("invalidates a disconnected proxy and establishes a new exact-target session", async () => {
    const background = new Nexus<ChromeAdapterModel>().configure({
      endpoint: {
        meta: { context: "background", extensionId: "test" },
        implementation: new BackgroundEndpoint(),
      },
      providers: [
        { token: BackgroundToken, service: { ready: () => "background" } },
      ],
    });
    const content = new Nexus<ChromeAdapterModel>().configure({
      endpoint: {
        meta: {
          context: "content-script",
          url: "https://example.test",
          origin: "https://example.test",
        },
        implementation: new ContentScriptEndpoint(),
        defaultTarget: chromeTarget.background(),
      },
      providers: [
        { token: ContentToken, service: { identity: () => "content" } },
      ],
    });

    await background.ready();
    const backgroundProxy = await content.create(BackgroundToken);
    await backgroundProxy.ready();
    const oldProxy = await background.create(ContentToken, {
      target: chromeTarget.contentDocument({ tabId: 7, documentId: "doc-7" }),
    });
    await oldProxy.identity();

    connectedPorts[0]?.disconnect();

    await expect(oldProxy.identity()).rejects.toMatchObject({
      code: "E_CONN_CLOSED",
    });
    const freshProxy = await background.create(ContentToken, {
      target: chromeTarget.contentDocument({ tabId: 7, documentId: "doc-7" }),
    });
    await expect(freshProxy.identity()).resolves.toBe("content");
    expect(tabsConnect).toHaveBeenCalledWith(7, {
      documentId: "doc-7",
    });
  });
});
