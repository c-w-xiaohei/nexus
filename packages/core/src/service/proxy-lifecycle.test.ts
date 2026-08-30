import { describe, expect, it, vi } from "vitest";
import { NexusDisconnectedError, NexusUsageError } from "@/errors";
import {
  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
} from "@/types/symbols";
import {
  getProxyStatus,
  inspectProxy,
  installProxyLifecycle,
  subscribeProxyStatus,
} from "./proxy-lifecycle";

const installLifecycle = (
  proxy: object,
): {
  stale(): void;
  disconnect(): void;
  staleUnsubscribed(): boolean;
  disconnectUnsubscribed(): boolean;
} => {
  let onStale: (() => void) | undefined;
  let onDisconnect: (() => void) | undefined;
  let staleUnsubscribed = false;
  let disconnectUnsubscribed = false;
  Object.assign(proxy, {
    [NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL]: (
      listener: () => void,
    ) => {
      onStale = listener;
      return () => {
        staleUnsubscribed = true;
      };
    },
    [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: (listener: () => void) => {
      onDisconnect = listener;
      return () => {
        disconnectUnsubscribed = true;
      };
    },
  });
  installProxyLifecycle(proxy, "orders", "one");
  return {
    stale: () => onStale?.(),
    disconnect: () => onDisconnect?.(),
    staleUnsubscribed: () => staleUnsubscribed,
    disconnectUnsubscribed: () => disconnectUnsubscribed,
  };
};

describe("proxy lifecycle", () => {
  it("caches status snapshots and tears down subscriptions on disconnect", () => {
    const proxy = {};
    const lifecycle = installLifecycle(proxy);

    const current = getProxyStatus(proxy);
    expect(getProxyStatus(proxy)).toBe(current);
    expect(current).toEqual({ type: "active", selection: "current" });

    lifecycle.stale();
    const stale = getProxyStatus(proxy);
    expect(stale).toEqual({ type: "active", selection: "stale" });
    expect(getProxyStatus(proxy)).toBe(stale);

    lifecycle.disconnect();
    const disconnected = getProxyStatus(proxy);
    expect(disconnected).toMatchObject({
      type: "disconnected",
      error: expect.any(NexusDisconnectedError),
    });
    expect(getProxyStatus(proxy)).toBe(disconnected);
    expect(lifecycle.staleUnsubscribed()).toBe(true);
    expect(lifecycle.disconnectUnsubscribed()).toBe(true);
    lifecycle.stale();
    expect(getProxyStatus(proxy).type).toBe("disconnected");
  });

  it("delivers the current snapshot synchronously without missing a nested transition", () => {
    const proxy = {};
    const lifecycle = installLifecycle(proxy);
    const statuses: ReturnType<typeof getProxyStatus>[] = [];

    subscribeProxyStatus(proxy, (status) => {
      statuses.push(status);
      if (status.type === "active" && status.selection === "current") {
        lifecycle.stale();
      }
    });

    expect(statuses).toEqual([
      { type: "active", selection: "current" },
      { type: "active", selection: "stale" },
    ]);
    expect(statuses[1]).toBe(getProxyStatus(proxy));
    expect(statuses[0]).not.toBe(statuses[1]);
  });

  it("freezes status snapshots and debug projections without cross-root corruption", () => {
    const first = {};
    const second = {};
    const firstLifecycle = installLifecycle(first);
    installLifecycle(second);

    const current = getProxyStatus(first);
    const currentDebug = inspectProxy(first);
    expect(currentDebug.status).toBe(current);
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(currentDebug)).toBe(true);
    expect(() => {
      (current as { selection: "current" | "stale" }).selection = "stale";
    }).toThrow(TypeError);
    expect(() => {
      (currentDebug as { tokenId: string }).tokenId = "corrupted";
    }).toThrow(TypeError);
    expect(getProxyStatus(second)).toBe(current);
    expect(inspectProxy(first)).toBe(currentDebug);

    firstLifecycle.stale();
    const stale = getProxyStatus(first);
    const staleDebug = inspectProxy(first);
    expect(staleDebug.status).toBe(stale);
    expect(Object.isFrozen(stale)).toBe(true);
    expect(Object.isFrozen(staleDebug)).toBe(true);
    expect(() => {
      (stale as { selection: "current" | "stale" }).selection = "current";
    }).toThrow(TypeError);
    expect(() => {
      (staleDebug as { status: typeof current }).status = current;
    }).toThrow(TypeError);
    expect(getProxyStatus(first)).toEqual({
      type: "active",
      selection: "stale",
    });
    expect(getProxyStatus(second)).toBe(current);

    firstLifecycle.disconnect();
    const disconnected = getProxyStatus(first);
    const disconnectedDebug = inspectProxy(first);
    expect(disconnectedDebug.status).toBe(disconnected);
    expect(Object.isFrozen(disconnected)).toBe(true);
    expect(Object.isFrozen(disconnected.error)).toBe(true);
    expect(Object.isFrozen(disconnectedDebug)).toBe(true);
    expect(() => {
      (disconnected as { type: "active" | "disconnected" }).type = "active";
    }).toThrow(TypeError);
    expect(() => {
      (disconnectedDebug as { status: typeof current }).status = current;
    }).toThrow(TypeError);
    expect(() => {
      disconnected.error.message = "corrupted";
    }).toThrow(TypeError);
    expect(getProxyStatus(first)).toBe(disconnected);
    expect(getProxyStatus(second)).toBe(current);
  });

  it("notifies listeners while respecting removal and nested transitions", () => {
    const proxy = {};
    const lifecycle = installLifecycle(proxy);
    const calls: string[] = [];
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let stopRemoved = (): void => undefined;
    let stopFirst = (): void => undefined;
    stopFirst = subscribeProxyStatus(proxy, (status) => {
      if (status.type === "active" && status.selection === "current") return;
      calls.push("first");
      stopFirst();
      stopRemoved();
      subscribeProxyStatus(proxy, () => calls.push("nested"));
      lifecycle.disconnect();
    });
    subscribeProxyStatus(proxy, (status) => {
      if (status.type === "active" && status.selection === "current") return;
      calls.push("throw");
      throw new Error("observer");
    });
    stopRemoved = subscribeProxyStatus(proxy, (status) => {
      if (status.type === "disconnected" || status.selection !== "current") {
        calls.push("removed");
      }
    });
    subscribeProxyStatus(proxy, (status) => {
      if (status.type === "disconnected" || status.selection !== "current") {
        calls.push("last");
      }
    });

    lifecycle.stale();
    expect(calls).toEqual(["first", "nested", "throw", "last", "nested"]);
    expect(logger).toHaveBeenCalledOnce();

    lifecycle.disconnect();
    expect(calls).toEqual(["first", "nested", "throw", "last", "nested"]);
    const late = vi.fn();
    const stopLate = subscribeProxyStatus(proxy, late);
    expect(stopLate).toBeTypeOf("function");
    expect(late).toHaveBeenCalledWith(getProxyStatus(proxy));
    stopLate();
    stopLate();
    expect(late).toHaveBeenCalledOnce();
    logger.mockRestore();
  });

  it("does not deliver an in-progress transition to a replacement subscription", () => {
    const proxy = {};
    const lifecycle = installLifecycle(proxy);
    const listener = vi.fn();
    let stopListener = (): void => undefined;
    let stopFirst = (): void => undefined;

    stopFirst = subscribeProxyStatus(proxy, (status) => {
      if (status.type === "active" && status.selection === "current") return;
      stopFirst();
      stopListener();
      stopListener = subscribeProxyStatus(proxy, listener);
    });
    stopListener = subscribeProxyStatus(proxy, listener);
    listener.mockClear();

    lifecycle.stale();
    expect(listener).toHaveBeenCalledOnce();

    lifecycle.disconnect();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects inherited, forged, getter-backed, and descendant values", () => {
    const root = {};
    installLifecycle(root);
    const inherited = Object.create(root);
    const forged = {
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: () => undefined,
    };
    const getter = vi.fn(() => {
      throw new Error("must not run");
    });
    const getterBacked = {};
    Object.defineProperty(
      getterBacked,
      NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
      { get: getter },
    );

    expect(getProxyStatus(root)).toEqual({
      type: "active",
      selection: "current",
    });

    for (const value of [
      inherited,
      forged,
      getterBacked,
      {},
      () => undefined,
      null,
    ]) {
      expect(() => getProxyStatus(value as object)).toThrow(NexusUsageError);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects an object copied from a real root disconnect capability", () => {
    const root = {};
    installLifecycle(root);
    const copied = {};
    Object.defineProperty(
      copied,
      NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
      Object.getOwnPropertyDescriptor(
        root,
        NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
      )!,
    );

    expect(() => getProxyStatus(copied)).toThrow(NexusUsageError);
  });

  it("rejects roots installed by a duplicate module copy", async () => {
    const first = await import("./proxy-lifecycle");
    const root = {};
    let onStale!: () => void;
    Object.assign(root, {
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: () => () => undefined,
      [NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL]: (
        listener: () => void,
      ) => {
        onStale = listener;
        return () => undefined;
      },
    });
    first.installProxyLifecycle(root, "orders", "one");
    onStale();

    await vi.resetModules();
    const second = await import("./proxy-lifecycle");

    expect(first.getProxyStatus(root)).toEqual({
      type: "active",
      selection: "stale",
    });
    expect(() => second.getProxyStatus(root)).toThrow(
      expect.objectContaining({ code: "E_USAGE_INVALID" }),
    );
  });
});
