import { describe, expect, it, vi } from "vitest";
import { Nexus, Token } from "@nexus-js/core";
import type { IframeAdapterModel, IframeConnectionMeta } from "./types.js";
import { createConnectionMeta } from "./connection-meta.js";
import * as iframePublicApi from "./index.js";
import {
  IframeAdapterError,
  IframeChildEndpoint,
  IframeParentEndpoint,
  usingIframeChild,
  usingIframeParent,
} from "./index.js";
import { postMessageFrom } from "./window.js";

class FakeWindow {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  parent: FakeWindow | null = null;
  constructor(readonly origin: string) {}
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  postMessage(
    data: unknown,
    targetOrigin: string,
    transfer?: Transferable[],
  ): void {
    if (!this.parent) return;
    this.deliver(this.parent, data, targetOrigin, transfer);
  }
  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  deliver(
    target: FakeWindow,
    data: unknown,
    targetOrigin = "*",
    transfer?: Transferable[],
  ): void {
    if (targetOrigin !== "*" && targetOrigin !== target.origin) return;
    target.dispatch("message", {
      data,
      source: this,
      origin: this.origin,
      ports: transfer ?? [],
    });
  }
}

class FakeIframe {
  readonly listeners = new Map<string, Set<() => void>>();
  constructor(
    public contentWindow: FakeWindow | null,
    readonly src: string,
  ) {}
  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  load(): void {
    for (const listener of this.listeners.get("load") ?? []) listener();
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("iframe adapter factories", () => {
  it("does not expose the removed IframeMatchers API", () => {
    expect("IframeMatchers" in iframePublicApi).toBe(false);
  });

  it("returns config with endpoint metadata and capabilities", () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const config = usingIframeParent({
      configure: false,
      appId: "app",
      window: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });
    expect(config.endpoint?.meta).toEqual({
      context: "iframe-parent",
      appId: "app",
      instance: "default",
      origin: "https://parent.test",
    });
    expect(config.endpoint?.implementation).toBeInstanceOf(
      IframeParentEndpoint,
    );
    expect(config.endpoint?.implementation?.capabilities).toMatchObject({
      binaryPackets: true,
      transferables: true,
    });
  });

  it("derives parent config origin from localWindow when window is omitted", () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    const iframe = new FakeIframe(childWindow, "https://child.test/app");

    const config = usingIframeParent({
      configure: false,
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });

    expect(
      (config.endpoint?.meta as { origin?: string } | undefined)?.origin,
    ).toBe("https://parent.test");
  });

  it("builds child config with a frozen parent default target and binary capability override", () => {
    const childWindow = new FakeWindow("https://child.test");
    const config = usingIframeChild({
      configure: false,
      appId: "app",
      frameId: "main",
      parentOrigin: "https://parent.test",
      window: childWindow as unknown as Window,
      binaryPackets: true,
    });
    expect(config.endpoint?.meta).toEqual({
      context: "iframe-child",
      appId: "app",
      instance: "default",
      origin: "https://child.test",
      frameId: "main",
    });
    expect(config.endpoint?.implementation).toBeInstanceOf(IframeChildEndpoint);
    expect(config.endpoint?.implementation?.capabilities).toMatchObject({
      binaryPackets: true,
      transferables: true,
    });
    expect(config.endpoint?.defaultTarget).toEqual({
      context: "iframe-parent",
      appId: "app",
      instance: "default",
      origin: "https://parent.test",
    });
    expect(Object.isFrozen(config.endpoint?.defaultTarget)).toBe(true);
  });

  it("allows iframe endpoints to opt out of binary packet transport", () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    const iframe = new FakeIframe(childWindow, "https://child.test/app");

    const parentConfig = usingIframeParent({
      configure: false,
      appId: "app",
      window: parentWindow as unknown as Window,
      binaryPackets: false,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });
    const childConfig = usingIframeChild({
      configure: false,
      appId: "app",
      frameId: "main",
      parentOrigin: "https://parent.test",
      window: childWindow as unknown as Window,
      binaryPackets: false,
    });

    expect(parentConfig.endpoint?.implementation?.capabilities).toMatchObject({
      binaryPackets: false,
      transferables: true,
    });
    expect(childConfig.endpoint?.implementation?.capabilities).toMatchObject({
      binaryPackets: false,
      transferables: true,
    });
  });

  it("derives child config origin from localWindow when window is omitted", () => {
    const childWindow = new FakeWindow("https://child.test");

    const config = usingIframeChild({
      configure: false,
      appId: "app",
      frameId: "main",
      parentOrigin: "https://parent.test",
      localWindow: childWindow as unknown as Window,
    });

    expect(
      (config.endpoint?.meta as { origin?: string } | undefined)?.origin,
    ).toBe("https://child.test");
  });

  it("validates target origins and app id", () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    expect(() =>
      usingIframeParent({
        configure: false,
        appId: "",
        window: parentWindow as unknown as Window,
        frames: [
          {
            frameId: "main",
            iframe: iframe as unknown as HTMLIFrameElement,
            origin: "https://child.test",
          },
        ],
      }),
    ).toThrow(IframeAdapterError);
    expect(() =>
      usingIframeParent({
        configure: false,
        appId: "app",
        window: parentWindow as unknown as Window,
        frames: [
          {
            frameId: "main",
            iframe: iframe as unknown as HTMLIFrameElement,
            origin: "*",
          },
        ],
      }),
    ).toThrow(IframeAdapterError);
    expect(() =>
      usingIframeChild({
        configure: false,
        appId: "app",
        parentOrigin: "*",
        window: childWindow as unknown as Window,
      }),
    ).toThrow(IframeAdapterError);
    expect(() =>
      usingIframeChild({
        configure: false,
        appId: "app",
        parentOrigin: "*",
        allowAnyOrigin: true,
        window: childWindow as unknown as Window,
      }),
    ).not.toThrow();
  });

  it("matches parent targets from context and connection facts", () => {
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: new FakeWindow("https://parent.test") as unknown as Window,
      frames: [],
    });
    const connectionMeta: IframeConnectionMeta = {
      transport: "iframe-postmessage",
      appId: "app",
      channel: "nexus:iframe",
      frameId: "main",
      localRole: "iframe-parent",
      remoteRole: "iframe-child",
      origin: "https://child.test",
      expectedOrigin: "https://child.test",
      facts: {
        sourceMatched: true,
        originMatched: true,
        nonceMatched: true,
        trusted: true,
      },
    };
    const connection = {
      contextMeta: {
        context: "iframe-child" as const,
        appId: "app",
        instance: "default",
        origin: "https://child.test",
        frameId: "untrusted-child-claim",
      },
      connectionMeta,
    };

    expect(
      parent.matchesTarget?.(
        { context: "iframe-child", frameId: "main" },
        connection.contextMeta,
        connection.connectionMeta,
      ),
    ).toBe(true);
    expect(
      parent.matchesTarget?.(
        {
          context: "iframe-child",
          frameId: "main",
          origin: "https://evil.test",
        },
        connection.contextMeta,
        connection.connectionMeta,
      ),
    ).toBe(false);
  });

  it("requires every iframe trust fact when matching parent connections", () => {
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: new FakeWindow("https://parent.test") as unknown as Window,
      frames: [],
    });
    const connection = {
      contextMeta: {
        context: "iframe-child" as const,
        appId: "app",
        instance: "default",
        origin: "https://child.test",
        frameId: "claimed-frame",
      },
      connectionMeta: {
        transport: "iframe-postmessage" as const,
        appId: "app",
        channel: "nexus:iframe",
        frameId: "main",
        localRole: "iframe-parent" as const,
        remoteRole: "iframe-child" as const,
        origin: "https://child.test",
        expectedOrigin: "https://child.test",
        facts: {
          sourceMatched: true,
          originMatched: true,
          nonceMatched: true,
          trusted: true,
        },
      },
    };
    const target = { context: "iframe-child" as const, frameId: "main" };

    for (const fact of [
      "sourceMatched",
      "originMatched",
      "nonceMatched",
      "trusted",
    ] as const) {
      const untrusted = {
        ...connection,
        connectionMeta: {
          ...connection.connectionMeta,
          facts: { ...connection.connectionMeta.facts, [fact]: false },
        },
      };
      expect(
        parent.matchesTarget?.(
          target,
          untrusted.contextMeta,
          untrusted.connectionMeta,
        ),
      ).toBe(false);
    }
  });

  it("requires every iframe trust fact when matching child-side parent connections", () => {
    const child = new IframeChildEndpoint({
      appId: "app",
      localWindow: new FakeWindow("https://child.test") as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
    });
    const connection = {
      contextMeta: {
        context: "iframe-parent" as const,
        appId: "app",
        instance: "default",
        origin: "https://parent.test",
      },
      connectionMeta: {
        transport: "iframe-postmessage" as const,
        appId: "app",
        channel: "nexus:iframe",
        localRole: "iframe-child" as const,
        remoteRole: "iframe-parent" as const,
        origin: "https://parent.test",
        expectedOrigin: "https://parent.test",
        facts: {
          sourceMatched: true,
          originMatched: true,
          nonceMatched: true,
          trusted: true,
        },
      },
    };
    const target = {
      context: "iframe-parent" as const,
      appId: "app",
      origin: "https://parent.test",
    };

    for (const fact of [
      "sourceMatched",
      "originMatched",
      "nonceMatched",
      "trusted",
    ] as const) {
      const untrusted = {
        ...connection,
        connectionMeta: {
          ...connection.connectionMeta,
          facts: { ...connection.connectionMeta.facts, [fact]: false },
        },
      };
      expect(
        child.matchesTarget(
          target,
          untrusted.contextMeta,
          untrusted.connectionMeta,
        ),
      ).toBe(false);
    }
  });

  it("matches wildcard origins against observed peers without weakening trust facts", () => {
    const parent = new IframeParentEndpoint({
      appId: "app",
      allowAnyOrigin: true,
      localWindow: new FakeWindow("https://parent.test") as unknown as Window,
      frames: [],
    });
    const child = new IframeChildEndpoint({
      appId: "app",
      allowAnyOrigin: true,
      localWindow: new FakeWindow("https://child.test") as unknown as Window,
      parentOrigin: "*",
      frameId: "main",
    });
    const childConnection = {
      contextMeta: {
        context: "iframe-child" as const,
        appId: "app",
        instance: "default",
        origin: "https://child.test",
        frameId: "claimed-frame",
      },
      connectionMeta: {
        transport: "iframe-postmessage" as const,
        appId: "app",
        channel: "nexus:iframe",
        frameId: "main",
        localRole: "iframe-parent" as const,
        remoteRole: "iframe-child" as const,
        origin: "https://child.test",
        expectedOrigin: "*",
        facts: {
          sourceMatched: true,
          originMatched: true,
          nonceMatched: true,
          trusted: true,
        },
      },
    };
    const parentConnection = {
      contextMeta: {
        context: "iframe-parent" as const,
        appId: "app",
        instance: "default",
        origin: "https://parent.test",
      },
      connectionMeta: {
        transport: "iframe-postmessage" as const,
        appId: "app",
        channel: "nexus:iframe",
        localRole: "iframe-child" as const,
        remoteRole: "iframe-parent" as const,
        origin: "https://parent.test",
        expectedOrigin: "*",
        facts: {
          sourceMatched: true,
          originMatched: true,
          nonceMatched: true,
          trusted: true,
        },
      },
    };

    expect(
      parent.matchesTarget?.(
        { context: "iframe-child", frameId: "main", origin: "*" },
        childConnection.contextMeta,
        childConnection.connectionMeta,
      ),
    ).toBe(true);
    expect(
      parent.matchesTarget?.(
        {
          context: "iframe-child",
          frameId: "main",
          origin: "https://child.test",
        },
        childConnection.contextMeta,
        childConnection.connectionMeta,
      ),
    ).toBe(true);
    expect(
      child.matchesTarget(
        { context: "iframe-parent", appId: "app", origin: "*" },
        parentConnection.contextMeta,
        parentConnection.connectionMeta,
      ),
    ).toBe(true);
    expect(
      child.matchesTarget(
        {
          context: "iframe-parent",
          appId: "app",
          origin: "https://parent.test",
        },
        parentConnection.contextMeta,
        parentConnection.connectionMeta,
      ),
    ).toBe(true);

    for (const fact of [
      "sourceMatched",
      "originMatched",
      "nonceMatched",
      "trusted",
    ] as const) {
      const untrusted = {
        ...childConnection,
        connectionMeta: {
          ...childConnection.connectionMeta,
          facts: { ...childConnection.connectionMeta.facts, [fact]: false },
        },
      };
      expect(
        parent.matchesTarget?.(
          { context: "iframe-child", frameId: "main", origin: "*" },
          untrusted.contextMeta,
          untrusted.connectionMeta,
        ),
      ).toBe(false);
    }
  });

  it("copies and deep-freezes iframe connection facts without freezing external objects", () => {
    const source = {};
    const input = {
      transport: "iframe-postmessage" as const,
      appId: "app",
      channel: "nexus:iframe",
      localRole: "iframe-parent" as const,
      remoteRole: "iframe-child" as const,
      origin: "https://child.test",
      expectedOrigin: "*",
      facts: {
        sourceMatched: true,
        originMatched: true,
        nonceMatched: true,
        trusted: true,
      },
    } as {
      transport: "iframe-postmessage";
      appId: string;
      channel: string;
      localRole: "iframe-parent";
      remoteRole: "iframe-child";
      origin: string;
      expectedOrigin: string;
      facts: {
        sourceMatched: boolean;
        originMatched: boolean;
        nonceMatched: boolean;
        trusted: boolean;
      };
    };
    const meta = createConnectionMeta(input);

    expect(meta).not.toBe(input);
    expect(meta.facts).not.toBe(input.facts);
    expect(Object.isFrozen(meta)).toBe(true);
    expect(Object.isFrozen(meta.facts)).toBe(true);
    input.facts.trusted = false;
    expect(meta.facts.trusted).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
  });
});

describe("iframe adapter message behavior", () => {
  it("forwards transfer lists to native target postMessage", () => {
    const source = {} as Window;
    const target = {
      postMessage: vi.fn(),
    } as unknown as Window;
    const message = { value: "packet" };
    const transfer = [new ArrayBuffer(1)] as Transferable[];

    postMessageFrom(source, target, message, "https://target.test", transfer);

    expect(target.postMessage).toHaveBeenCalledWith(
      message,
      "https://target.test",
      transfer,
    );
  });

  it("ignores wrong origin, source, channel, and nonce messages before accepting a connection", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    const attackerWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    attackerWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const endpoint = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
          nonce: "n",
        },
      ],
    });
    const onConnect = vi.fn();
    endpoint.listen(onConnect);
    const payload = {
      __nexusVirtualPort: true,
      version: 1,
      type: "connect",
      channelId: "c",
      from: "x",
      nonce: "vn",
    };
    childWindow.deliver(
      parentWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "other",
        nonce: "n",
        payload,
      },
      "https://parent.test",
    );
    attackerWindow.deliver(
      parentWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "nexus:iframe",
        nonce: "n",
        payload,
      },
      "https://parent.test",
    );
    childWindow.deliver(
      parentWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "nexus:iframe",
        nonce: "wrong",
        payload,
      },
      "https://parent.test",
    );
    childWindow.deliver(
      parentWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "nexus:iframe",
        nonce: "n",
        payload,
      },
      "https://parent.test",
    );
    await flush();
    await flush();
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("keeps multiple same-origin iframes isolated by source and frame id", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const firstWindow = new FakeWindow("https://child.test");
    const secondWindow = new FakeWindow("https://child.test");
    firstWindow.parent = parentWindow;
    secondWindow.parent = parentWindow;
    const firstFrame = new FakeIframe(firstWindow, "https://child.test/a");
    const secondFrame = new FakeIframe(secondWindow, "https://child.test/b");
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "a",
          iframe: firstFrame as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
        {
          frameId: "b",
          iframe: secondFrame as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });
    const firstChild = new IframeChildEndpoint({
      appId: "app",
      localWindow: firstWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "a",
    });
    const secondChild = new IframeChildEndpoint({
      appId: "app",
      localWindow: secondWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "b",
    });
    const firstConnect = vi.fn();
    const secondConnect = vi.fn();
    firstChild.listen(firstConnect);
    secondChild.listen(secondConnect);

    await parent.connect({
      context: "iframe-child",
      appId: "app",
      frameId: "b",
    });
    await flush();

    expect(firstConnect).not.toHaveBeenCalled();
    expect(secondConnect).toHaveBeenCalledTimes(1);
  });

  it("rejects parent connections to non-child context targets", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });

    await expect(
      parent.connect({
        context: "iframe-parent",
        appId: "app",
        origin: "https://parent.test",
      } as never),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
  });

  it("rejects parent connections without a frame id", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const firstWindow = new FakeWindow("https://first.test");
    const secondWindow = new FakeWindow("https://second.test");
    firstWindow.parent = parentWindow;
    secondWindow.parent = parentWindow;
    const firstFrame = new FakeIframe(firstWindow, "https://first.test/app");
    const secondFrame = new FakeIframe(secondWindow, "https://second.test/app");
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "first",
          iframe: firstFrame as unknown as HTMLIFrameElement,
          origin: "https://first.test",
        },
        {
          frameId: "second",
          iframe: secondFrame as unknown as HTMLIFrameElement,
          origin: "https://second.test",
        },
      ],
    });
    await expect(
      parent.connect({
        context: "iframe-child",
        appId: "app",
      } as never),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
  });

  it("rejects ambiguous parent-to-child frame matches", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const firstWindow = new FakeWindow("https://child.test");
    const secondWindow = new FakeWindow("https://child.test");
    firstWindow.parent = parentWindow;
    secondWindow.parent = parentWindow;
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "same",
          iframe: new FakeIframe(
            firstWindow,
            "https://child.test/first",
          ) as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
        {
          frameId: "same",
          iframe: new FakeIframe(
            secondWindow,
            "https://child.test/second",
          ) as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });

    await expect(
      parent.connect({ context: "iframe-child", frameId: "same" }),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_AMBIGUOUS" });
  });

  it("rejects parent connections with mismatched app id, instance, origin, or unknown frame id", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const parent = new IframeParentEndpoint({
      appId: "app",
      instance: "one",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });

    await expect(
      parent.connect({
        context: "iframe-child",
        appId: "other",
        frameId: "main",
      }),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
    await expect(
      parent.connect({
        context: "iframe-child",
        appId: "app",
        instance: "two",
      } as never),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
    await expect(
      parent.connect({
        context: "iframe-child",
        appId: "app",
        origin: "https://other.test",
        frameId: "main",
      }),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
    await expect(
      parent.connect({
        context: "iframe-child",
        appId: "app",
        frameId: "unknown",
      }),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
  });

  it("parent wildcard origin still enforces matching frame source", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    const attackerWindow = new FakeWindow("https://attacker.test");
    childWindow.parent = parentWindow;
    attackerWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const endpoint = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      allowAnyOrigin: true,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "*",
        },
      ],
    });
    const onConnect = vi.fn();
    endpoint.listen(onConnect);
    const payload = {
      __nexusVirtualPort: true,
      version: 1,
      type: "connect",
      channelId: "c",
      from: "x",
      nonce: "vn",
    };

    attackerWindow.deliver(
      parentWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "nexus:iframe",
        payload,
      },
      "https://parent.test",
    );
    await flush();

    expect(onConnect).not.toHaveBeenCalled();
  });

  it("parent inbound messages require the configured channel and nonce", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const endpoint = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      channel: "secure",
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
          nonce: "secret",
        },
      ],
    });
    const onConnect = vi.fn();
    endpoint.listen(onConnect);
    const payload = {
      __nexusVirtualPort: true,
      version: 1,
      type: "connect",
      channelId: "c",
      from: "x",
      nonce: "vn",
    };

    childWindow.deliver(
      parentWindow,
      { __nexusIframe: true, appId: "app", channel: "secure", payload },
      "https://parent.test",
    );
    childWindow.deliver(
      parentWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "nexus:iframe",
        nonce: "secret",
        payload,
      },
      "https://parent.test",
    );
    childWindow.deliver(
      parentWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "secure",
        nonce: "secret",
        payload,
      },
      "https://parent.test",
    );
    await flush();

    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("parent contentWindow null send failure returns connect failed", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const iframe = new FakeIframe(null, "https://child.test/app");
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });

    await expect(
      parent.connect({
        context: "iframe-child",
        frameId: "main",
      }),
    ).rejects.toMatchObject({
      code: "E_IFRAME_CONNECT_FAILED",
    });
  });

  it("rejects child connections to non-parent context targets", async () => {
    const childWindow = new FakeWindow("https://child.test");
    const child = new IframeChildEndpoint({
      appId: "app",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
    });

    await expect(
      child.connect({ context: "iframe-child", appId: "app" } as never),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
  });

  it("rejects child connections to mismatched parent targets", async () => {
    const childWindow = new FakeWindow("https://child.test");
    const child = new IframeChildEndpoint({
      appId: "app",
      instance: "one",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
    });

    await expect(
      child.connect({
        context: "iframe-parent",
        appId: "other",
        origin: "https://parent.test",
      } as never),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
    await expect(
      child.connect({
        context: "iframe-parent",
        appId: "app",
        instance: "two",
        origin: "https://parent.test",
      }),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
    await expect(
      child.connect({
        context: "iframe-parent",
        appId: "app",
        origin: "https://other.test",
      }),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
  });

  it("child ignores wrong origin, source, channel, nonce, and app id messages", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    const attackerWindow = new FakeWindow("https://parent.test");
    childWindow.parent = parentWindow;
    attackerWindow.parent = childWindow;
    const child = new IframeChildEndpoint({
      appId: "app",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
      channel: "secure",
      nonce: "secret",
    });
    const onConnect = vi.fn();
    child.listen(onConnect);
    const payload = {
      __nexusVirtualPort: true,
      version: 1,
      type: "connect",
      channelId: "c",
      from: "x",
      nonce: "vn",
    };

    parentWindow.deliver(
      childWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "secure",
        nonce: "secret",
        payload,
      },
      "https://other.test",
    );
    attackerWindow.deliver(
      childWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "secure",
        nonce: "secret",
        payload,
      },
      "https://child.test",
    );
    parentWindow.deliver(
      childWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "other",
        nonce: "secret",
        payload,
      },
      "https://child.test",
    );
    parentWindow.deliver(
      childWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "secure",
        nonce: "wrong",
        payload,
      },
      "https://child.test",
    );
    parentWindow.deliver(
      childWindow,
      {
        __nexusIframe: true,
        appId: "other",
        channel: "secure",
        nonce: "secret",
        payload,
      },
      "https://child.test",
    );
    await flush();

    expect(onConnect).not.toHaveBeenCalled();
  });

  it("child inbound messages require the configured channel and nonce", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const child = new IframeChildEndpoint({
      appId: "app",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
      channel: "secure",
      nonce: "secret",
    });
    const onConnect = vi.fn();
    child.listen(onConnect);
    const payload = {
      __nexusVirtualPort: true,
      version: 1,
      type: "connect",
      channelId: "c",
      from: "x",
      nonce: "vn",
    };

    parentWindow.deliver(
      childWindow,
      { __nexusIframe: true, appId: "app", channel: "secure", payload },
      "https://child.test",
    );
    parentWindow.deliver(
      childWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "nexus:iframe",
        nonce: "secret",
        payload,
      },
      "https://child.test",
    );
    parentWindow.deliver(
      childWindow,
      {
        __nexusIframe: true,
        appId: "app",
        channel: "secure",
        nonce: "secret",
        payload,
      },
      "https://child.test",
    );
    await flush();

    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("child close removes lifecycle listeners and is idempotent", () => {
    const childWindow = new FakeWindow("https://child.test");
    const child = new IframeChildEndpoint({
      appId: "app",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
    });

    expect(childWindow.listeners.get("pagehide")?.size ?? 0).toBe(1);
    expect(childWindow.listeners.get("beforeunload")?.size ?? 0).toBe(1);
    child.close();
    child.close();

    expect(childWindow.listeners.get("pagehide")?.size ?? 0).toBe(0);
    expect(childWindow.listeners.get("beforeunload")?.size ?? 0).toBe(0);
  });

  it("child parent unavailable send failure returns connect failed", async () => {
    const childWindow = new FakeWindow("https://child.test");
    const child = new IframeChildEndpoint({
      appId: "app",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
    });

    await expect(
      child.connect({
        context: "iframe-parent",
        appId: "app",
        origin: "https://parent.test",
      }),
    ).rejects.toMatchObject({
      code: "E_IFRAME_CONNECT_FAILED",
    });
  });

  it("child connect accepts wildcard parent origin only when allowAnyOrigin is true", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });
    parent.listen(() => undefined);
    expect(
      () =>
        new IframeChildEndpoint({
          appId: "app",
          localWindow: childWindow as unknown as Window,
          parentOrigin: "*",
          frameId: "main",
        }),
    ).toThrow(IframeAdapterError);
    const child = new IframeChildEndpoint({
      appId: "app",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "*",
      allowAnyOrigin: true,
      frameId: "main",
    });

    await expect(
      child.connect({
        context: "iframe-parent",
        appId: "app",
        origin: "https://parent.test",
      }),
    ).resolves.toBeDefined();
  });

  it("connects with the factory-generated wildcard parent default target", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });
    parent.listen(() => undefined);

    const childConfig = usingIframeChild({
      configure: false,
      appId: "app",
      frameId: "main",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "*",
      allowAnyOrigin: true,
    });
    const childEndpoint = childConfig.endpoint?.implementation;
    const generatedTarget = childConfig.endpoint?.defaultTarget;
    if (!childEndpoint?.connect || !generatedTarget) {
      throw new Error("Expected the child factory to create a default target");
    }

    await expect(childEndpoint.connect(generatedTarget)).resolves.toBeDefined();
  });

  it("closes an existing child router on pagehide and beforeunload", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });
    const child = new IframeChildEndpoint({
      appId: "app",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
    });
    parent.listen(() => undefined);

    const { port: pagehidePort } = await child.connect({
      context: "iframe-parent",
      appId: "app",
      origin: "https://parent.test",
    });
    const pagehideDisconnected = vi.fn();
    pagehidePort.onDisconnect(pagehideDisconnected);
    childWindow.dispatch("pagehide", {});
    await flush();
    expect(pagehideDisconnected).toHaveBeenCalled();

    const { port: beforeunloadPort } = await child.connect({
      context: "iframe-parent",
      appId: "app",
      origin: "https://parent.test",
    });
    const beforeunloadDisconnected = vi.fn();
    beforeunloadPort.onDisconnect(beforeunloadDisconnected);
    childWindow.dispatch("beforeunload", {});
    await flush();
    expect(beforeunloadDisconnected).toHaveBeenCalled();
  });

  it("closes an existing parent frame router when the iframe loads", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });
    const child = new IframeChildEndpoint({
      appId: "app",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
    });
    parent.listen(() => undefined);
    const { port } = await child.connect({
      context: "iframe-parent",
      appId: "app",
      origin: "https://parent.test",
    });
    const disconnected = vi.fn();
    port.onDisconnect(disconnected);
    iframe.load();
    await flush();
    expect(disconnected).toHaveBeenCalled();
  });

  it("lets a child reconnect after parent iframe load replaces the frame router", async () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });
    const child = new IframeChildEndpoint({
      appId: "app",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
    });
    const onConnect = vi.fn();
    parent.listen(onConnect);
    const firstConnection = await child.connect({
      context: "iframe-parent",
      appId: "app",
      origin: "https://parent.test",
    });
    const disconnected = vi.fn();
    firstConnection.port.onDisconnect(disconnected);
    iframe.load();
    await flush();

    const secondConnection = await child.connect({
      context: "iframe-parent",
      appId: "app",
      origin: "https://parent.test",
    });
    await flush();

    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(secondConnection.port).not.toBe(firstConnection.port);
    expect(onConnect).toHaveBeenCalledTimes(2);
  });

  it("removes parent iframe load listeners on close", () => {
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const parent = new IframeParentEndpoint({
      appId: "app",
      localWindow: parentWindow as unknown as Window,
      frames: [
        {
          frameId: "main",
          iframe: iframe as unknown as HTMLIFrameElement,
          origin: "https://child.test",
        },
      ],
    });

    expect(iframe.listeners.get("load")?.size ?? 0).toBe(1);
    parent.close();
    parent.close();

    expect(iframe.listeners.get("load")?.size ?? 0).toBe(0);
  });
});

describe("iframe adapter RPC integration", () => {
  it("acquires child and parent services on their first demand", async () => {
    interface EchoService {
      echo(value: string): string;
    }
    const EchoToken = new Token<EchoService>("test.echo");
    const ParentEchoToken = new Token<EchoService>("test.parent-echo");
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const parent = new Nexus<IframeAdapterModel>().configure({
      ...usingIframeParent({
        configure: false,
        appId: "app",
        window: parentWindow as unknown as Window,
        frames: [
          {
            frameId: "main",
            iframe: iframe as unknown as HTMLIFrameElement,
            origin: "https://child.test",
          },
        ],
      }),
      providers: [
        {
          token: ParentEchoToken,
          service: { echo: (value: string) => `parent:${value}` },
        },
      ],
    });
    const child = new Nexus<IframeAdapterModel>().configure({
      ...usingIframeChild({
        configure: false,
        appId: "app",
        frameId: "main",
        window: childWindow as unknown as Window,
        parentOrigin: "https://parent.test",
      }),
      providers: [
        {
          token: EchoToken,
          service: { echo: (value: string) => value },
        },
      ],
    });
    await Promise.all([parent.ready(), child.ready()]);
    const childServicePromise = parent.create(EchoToken, {
      target: {
        context: "iframe-child",
        appId: "app",
        frameId: "main",
      },
    });
    await flush();
    const childService = await childServicePromise;
    await expect(childService.echo("hello")).resolves.toBe("hello");

    const parentService = await child.create(ParentEchoToken);
    await expect(parentService.echo("hello")).resolves.toBe("parent:hello");
  });
});
