import { Nexus, Token } from "@nexus-js/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundEndpoint } from "./endpoints/background";
import { ContentScriptEndpoint } from "./endpoints/content-script";
import type { ChromeAdapterModel } from "./types/meta";
import { chromeTarget } from "./types/meta";
import { chromePortName } from "./ports/chrome-port-name";

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
  readonly name: string;
  readonly binary?: boolean;
}) {
  let clientMessageListener: Listener<unknown> | undefined;
  let serverMessageListener: Listener<unknown> | undefined;
  let clientDisconnectListener: (() => void) | undefined;
  let serverDisconnectListener: (() => void) | undefined;
  let disconnected = false;
  const sentMessages: unknown[] = [];
  const copyMessage = (message: unknown) => {
    const copy = options.binary
      ? structuredClone(message)
      : JSON.parse(JSON.stringify(message));
    sentMessages.push(copy);
    return copy;
  };

  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    clientDisconnectListener?.();
    serverDisconnectListener?.();
  };

  const client = {
    name: options.name,
    sender: options.clientSender,
    postMessage: (message: unknown) => {
      const copy = copyMessage(message);
      setTimeout(() => serverMessageListener?.(copy));
    },
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
    name: options.name,
    sender: options.serverSender,
    postMessage: (message: unknown) => {
      const copy = copyMessage(message);
      setTimeout(() => clientMessageListener?.(copy));
    },
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

  return { client, server, disconnect, sentMessages };
}

describe("Chrome exact content-script targets", () => {
  let backgroundConnectListener: Listener<chrome.runtime.Port> | undefined;
  let contentConnectListener: Listener<chrome.runtime.Port> | undefined;
  let connectedPorts: ReturnType<typeof createLinkedPorts>[];
  let runtimeConnect: ReturnType<typeof vi.fn>;
  let tabsConnect: ReturnType<typeof vi.fn>;
  let nativeBinary: boolean;

  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    nativeBinary = false;
    connectedPorts = [];
    backgroundConnectListener = undefined;
    contentConnectListener = undefined;
    runtimeConnect = vi.fn(() => {
      const ports = createLinkedPorts({
        name: chromePortName.background,
        binary: nativeBinary,
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
        name: chromePortName.contentScript,
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
        getManifest: () => ({
          manifest_version: 3,
          message_serialization: nativeBinary ? "structured_clone" : "json",
        }),
        onConnect: {
          addListener: (listener: Listener<chrome.runtime.Port>) => {
            if (!backgroundConnectListener)
              backgroundConnectListener = listener;
            else contentConnectListener = listener;
          },
          removeListener: vi.fn(),
        },
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
        connect: runtimeConnect,
      },
      tabs: { connect: tabsConnect },
    } as unknown as typeof chrome;
  });

  it.each([
    { binary: false, clientHints: true },
    { binary: true, clientHints: true },
    { binary: true, clientHints: false },
  ])(
    "round-trips chunked binary RPC values: %j",
    async ({ binary, clientHints }) => {
      nativeBinary = binary;
      vi.stubGlobal("navigator", {
        userAgentData: {
          brands: [{ brand: "Google Chrome", version: "152" }],
        },
      });
      const token = new Token<
        {
          echo(bytes: Uint8Array): Uint8Array;
        },
        ChromeAdapterModel
      >("chrome-binary-echo");
      const backgroundEndpoint = new BackgroundEndpoint();
      if (!clientHints) vi.stubGlobal("navigator", {});
      const contentEndpoint = new ContentScriptEndpoint();
      expect(backgroundEndpoint.config.binaryPackets).toBe(binary);
      expect(contentEndpoint.config.binaryPackets).toBe(binary && clientHints);
      const background = new Nexus<ChromeAdapterModel>().configure({
        endpoint: {
          meta: { context: "background", extensionId: "test" },
          implementation: backgroundEndpoint,
        },
        providers: [{ token, service: { echo: (bytes: Uint8Array) => bytes } }],
      });
      const content = new Nexus<ChromeAdapterModel>().configure({
        endpoint: {
          meta: {
            context: "content-script",
            url: "https://example.test",
            origin: "https://example.test",
          },
          implementation: contentEndpoint,
        },
      });
      try {
        await background.ready();
        const connection = await content.connect({
          target: chromeTarget.background(),
        });
        const proxy = await connection.get(token);
        // Exceed the default frame size to exercise both chunk codecs.
        const input = Uint8Array.from(
          { length: 128 * 1024 },
          (_, i) => i % 256,
        );
        const output = await proxy.echo(input);
        expect(output).toBeInstanceOf(Uint8Array);
        expect(output).toEqual(input);
        expect(input.byteLength).toBe(128 * 1024);
        const packets = connectedPorts.flatMap((ports) => ports.sentMessages);
        expect(packets.some((packet) => packet instanceof ArrayBuffer)).toBe(
          binary && clientHints,
        );
        expect(packets.some((packet) => typeof packet === "string")).toBe(true);
      } finally {
        for (const ports of connectedPorts) ports.disconnect();
        backgroundEndpoint.close();
        contentEndpoint.close();
      }
    },
  );

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
      },
      providers: [
        { token: ContentToken, service: { identity: () => "tab-7-frame-2" } },
      ],
    });

    await background.ready();
    const backgroundProxy = await content
      .connect({
        target: chromeTarget.background(),
      })
      .then((connection) => connection.get(BackgroundToken));
    await expect(backgroundProxy.ready()).resolves.toBe("background");

    const contentProxy = await background
      .connect({
        target: chromeTarget.contentDocument({ tabId: 7, documentId: "doc-7" }),
      })
      .then((connection) => connection.get(ContentToken));

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
    const contentProxy = await background
      .connect({
        target: chromeTarget.contentFrame({ tabId: 8, frameId: 0 }),
      })
      .then((connection) => connection.get(ContentToken));

    await expect(contentProxy.identity()).resolves.toBe("tab-8-frame-0");
    const reusedProxy = await background
      .connect({
        target: chromeTarget.contentFrame({ tabId: 8, frameId: 0 }),
      })
      .then((connection) => connection.get(ContentToken));
    await expect(reusedProxy.identity()).resolves.toBe("tab-8-frame-0");
    expect(tabsConnect).toHaveBeenCalledWith(8, {
      frameId: 0,
      name: chromePortName.contentScript,
    });
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
      },
      providers: [
        { token: ContentToken, service: { identity: () => "content" } },
      ],
    });

    await background.ready();
    const backgroundProxy = await content
      .connect({
        target: chromeTarget.background(),
      })
      .then((connection) => connection.get(BackgroundToken));
    await backgroundProxy.ready();

    const contentProxy = await background
      .connect({
        target: chromeTarget.contentFrame({ tabId: 7, frameId: 3 }),
      })
      .then((connection) => connection.get(ContentToken));

    await expect(contentProxy.identity()).resolves.toBe("content");
    expect(tabsConnect).toHaveBeenCalledWith(7, {
      frameId: 3,
      name: chromePortName.contentScript,
    });
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
      background
        .connect({
          target: chromeTarget.contentDocument({
            tabId: 7,
            documentId: "doc-7",
          }),
        })
        .then((connection) => connection.get(ContentToken)),
    ).rejects.toMatchObject({ code: "E_ENDPOINT_CAPABILITY_MISMATCH" });
  });

  it("classifies an asynchronous Port disconnect as a handshake failure", async () => {
    tabsConnect = vi.fn((_tabId: number, _info?: chrome.tabs.ConnectInfo) => {
      const ports = createLinkedPorts({
        name: chromePortName.contentScript,
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
      background
        .connect({
          target: chromeTarget.contentFrame({ tabId: 7, frameId: 2 }),
          timeout: 100,
        })
        .then((connection) => connection.get(ContentToken)),
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
      },
      providers: [
        { token: ContentToken, service: { identity: () => "content" } },
      ],
    });

    await background.ready();
    const backgroundProxy = await content
      .connect({
        target: chromeTarget.background(),
      })
      .then((connection) => connection.get(BackgroundToken));
    await backgroundProxy.ready();
    const oldProxy = await background
      .connect({
        target: chromeTarget.contentDocument({ tabId: 7, documentId: "doc-7" }),
      })
      .then((connection) => connection.get(ContentToken));
    await oldProxy.identity();

    connectedPorts[0]?.disconnect();

    await expect(oldProxy.identity()).rejects.toMatchObject({
      code: "E_CONN_CLOSED",
    });
    const freshProxy = await background
      .connect({
        target: chromeTarget.contentDocument({ tabId: 7, documentId: "doc-7" }),
      })
      .then((connection) => connection.get(ContentToken));
    await expect(freshProxy.identity()).resolves.toBe("content");
    expect(tabsConnect).toHaveBeenCalledWith(7, {
      documentId: "doc-7",
      name: chromePortName.contentScript,
    });
  });
});
