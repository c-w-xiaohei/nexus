import { describe, expect, it, vi } from "vitest";
import { Nexus, Token } from "@nexus-js/core";
import {
  IframeAdapterError,
  IframeChildEndpoint,
  IframeMatchers,
  IframeParentEndpoint,
  usingIframeChild,
  usingIframeParent,
} from "./index";
import { postMessageFrom } from "./window";

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
  it("returns config with serializable metadata, descriptors, matchers, and capabilities", () => {
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
    expect(config.descriptors?.child).toEqual({
      context: "iframe-child",
      appId: "app",
      instance: "default",
      frameId: "main",
      origin: "https://child.test",
    });
    expect(JSON.stringify(config.descriptors)).toContain("main");
    expect(
      config.matchers?.child({
        context: "iframe-child",
        appId: "app",
        instance: "default",
        frameId: "main",
        origin: "https://child.test",
      }),
    ).toBe(true);
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

    expect(config.endpoint?.meta?.origin).toBe("https://parent.test");
  });

  it("builds child config with parent descriptor and binary capability override", () => {
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
    expect(config.descriptors?.parent).toEqual({
      context: "iframe-parent",
      appId: "app",
      instance: "default",
      origin: "https://parent.test",
    });
    expect(config.endpoint?.implementation).toBeInstanceOf(IframeChildEndpoint);
    expect(config.endpoint?.implementation?.capabilities).toMatchObject({
      binaryPackets: true,
      transferables: true,
    });
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

    expect(config.endpoint?.meta?.origin).toBe("https://child.test");
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

  it("matches iframe roles, app id, instance, origin, and frame id", () => {
    const child = {
      context: "iframe-child",
      appId: "app",
      instance: "one",
      origin: "https://child.test",
      frameId: "a",
    } as const;
    expect(
      IframeMatchers.parent("app")({
        context: "iframe-parent",
        appId: "app",
        origin: "https://parent.test",
      }),
    ).toBe(true);
    expect(IframeMatchers.child("app")(child)).toBe(true);
    expect(IframeMatchers.instance("one")(child)).toBe(true);
    expect(IframeMatchers.origin("https://child.test")(child)).toBe(true);
    expect(IframeMatchers.frame("a")(child)).toBe(true);
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

  it("rejects parent connections to non-child context descriptors", async () => {
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
      parent.connect({ context: "iframe-parent", appId: "app" }),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
  });

  it("parent connect with an empty descriptor uses the first configured frame", async () => {
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
    const firstChild = new IframeChildEndpoint({
      appId: "app",
      localWindow: firstWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "first",
    });
    const secondChild = new IframeChildEndpoint({
      appId: "app",
      localWindow: secondWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "second",
    });
    const firstConnect = vi.fn();
    const secondConnect = vi.fn();
    firstChild.listen(firstConnect);
    secondChild.listen(secondConnect);

    await parent.connect({});
    await flush();

    expect(firstConnect).toHaveBeenCalledTimes(1);
    expect(secondConnect).not.toHaveBeenCalled();
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
      parent.connect({ context: "iframe-child", appId: "other" }),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
    await expect(
      parent.connect({
        context: "iframe-child",
        appId: "app",
        instance: "two",
      }),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
    await expect(
      parent.connect({
        context: "iframe-child",
        appId: "app",
        origin: "https://other.test",
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

    await expect(parent.connect({})).rejects.toMatchObject({
      code: "E_IFRAME_CONNECT_FAILED",
    });
  });

  it("rejects child connections to non-parent context descriptors", async () => {
    const childWindow = new FakeWindow("https://child.test");
    const child = new IframeChildEndpoint({
      appId: "app",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
    });

    await expect(
      child.connect({ context: "iframe-child", appId: "app" }),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
  });

  it("rejects child connections to mismatched parent descriptors", async () => {
    const childWindow = new FakeWindow("https://child.test");
    const child = new IframeChildEndpoint({
      appId: "app",
      instance: "one",
      localWindow: childWindow as unknown as Window,
      parentOrigin: "https://parent.test",
      frameId: "main",
    });

    await expect(
      child.connect({ context: "iframe-parent", appId: "other" }),
    ).rejects.toMatchObject({ code: "E_IFRAME_TARGET_NOT_FOUND" });
    await expect(
      child.connect({
        context: "iframe-parent",
        appId: "app",
        instance: "two",
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

    await expect(child.connect({})).rejects.toMatchObject({
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
      child.connect({ origin: "https://parent.test" }),
    ).resolves.toBeDefined();
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

    const [pagehidePort] = await child.connect({});
    const pagehideDisconnected = vi.fn();
    pagehidePort.onDisconnect(pagehideDisconnected);
    childWindow.dispatch("pagehide", {});
    await flush();
    expect(pagehideDisconnected).toHaveBeenCalled();

    const [beforeunloadPort] = await child.connect({});
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
    const [port] = await child.connect({
      context: "iframe-parent",
      appId: "app",
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
    await child.connect({ context: "iframe-parent", appId: "app" });
    iframe.load();
    await flush();

    await child.connect({ context: "iframe-parent", appId: "app" });
    await flush();

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
  it("calls a child service through fake postMessage windows", async () => {
    interface EchoService {
      echo(value: string): string;
    }
    const EchoToken = new Token<EchoService>("test.echo");
    const parentWindow = new FakeWindow("https://parent.test");
    const childWindow = new FakeWindow("https://child.test");
    childWindow.parent = parentWindow;
    const iframe = new FakeIframe(childWindow, "https://child.test/app");
    const parent = new Nexus().configure(
      usingIframeParent({
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
    );
    new Nexus().configure({
      ...usingIframeChild({
        configure: false,
        appId: "app",
        frameId: "main",
        window: childWindow as unknown as Window,
        parentOrigin: "https://parent.test",
        connectTo: [{ descriptor: { context: "iframe-parent", appId: "app" } }],
      }),
      services: [
        {
          token: EchoToken,
          implementation: { echo: (value: string) => value },
        },
      ],
    });
    await flush();
    const servicePromise = parent.create(EchoToken, {
      target: {
        descriptor: { context: "iframe-child", appId: "app", frameId: "main" },
      },
    });
    await flush();
    const service = await servicePromise;
    await expect(service.echo("hello")).resolves.toBe("hello");
  });
});
