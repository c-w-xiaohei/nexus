import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import {
  Nexus,
  NexusDisconnectedError,
  NexusUsageError,
  type ProxyStatus,
} from "@nexus-js/core";
import { useProxyStatus } from "./use-proxy-status";

const current: ProxyStatus = Object.freeze({
  type: "active",
  selection: "current",
});
const stale: ProxyStatus = Object.freeze({
  type: "active",
  selection: "stale",
});
const disconnected: ProxyStatus = Object.freeze({
  type: "disconnected",
  error: new NexusDisconnectedError("disconnected"),
});

const mockLifecycle = (initial = current) => {
  let status: ProxyStatus = initial;
  let unsubscriptions = 0;
  const listeners = new Set<(next: ProxyStatus) => void>();
  const get = vi
    .spyOn(Nexus, "getProxyStatus")
    .mockImplementation(() => status);
  const subscribe = vi
    .spyOn(Nexus, "subscribeProxyStatus")
    .mockImplementation((_proxy, listener) => {
      listeners.add(listener);
      listener(status);
      return () => {
        unsubscriptions += 1;
        listeners.delete(listener);
      };
    });

  return {
    get,
    subscribe,
    get unsubscriptions() {
      return unsubscriptions;
    },
    transition(next: ProxyStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
    restore() {
      get.mockRestore();
      subscribe.mockRestore();
    },
  };
};

describe("useProxyStatus", () => {
  it("is exported from the React package entrypoint", async () => {
    const entry = await import("./index");

    expect((entry as Record<string, unknown>).useProxyStatus).toBeTypeOf(
      "function",
    );
  });

  it("reads the synchronous current snapshot and future transitions", () => {
    const lifecycle = mockLifecycle();
    const proxy = {};
    const { result } = renderHook(() => useProxyStatus(proxy));

    expect(result.current).toBe(current);
    act(() => lifecycle.transition(stale));
    expect(result.current).toBe(stale);
    lifecycle.restore();
  });

  it("does not miss a transition that follows synchronous subscription", () => {
    const lifecycle = mockLifecycle();
    const proxy = {};
    lifecycle.subscribe.mockImplementation((_proxy, listener) => {
      listener(current);
      lifecycle.transition(stale);
      return () => undefined;
    });

    const { result } = renderHook(() => useProxyStatus(proxy));

    expect(result.current).toBe(stale);
    lifecycle.restore();
  });

  it("only publishes selector changes according to Object.is", () => {
    const lifecycle = mockLifecycle();
    const proxy = {};
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useProxyStatus(proxy, (status) => status.type);
    });

    act(() => lifecycle.transition(stale));
    expect(result.current).toBe("active");
    expect(renders).toBe(1);
    lifecycle.restore();
  });

  it("uses a new selector closure without resubscribing to Core", () => {
    const lifecycle = mockLifecycle();
    const proxy = {};
    const first = () => "first";
    const second = () => "second";
    const { result, rerender } = renderHook(
      ({ selector }) => useProxyStatus(proxy, selector),
      { initialProps: { selector: first } },
    );

    expect(result.current).toBe("first");
    rerender({ selector: second });
    expect(result.current).toBe("second");
    expect(lifecycle.subscribe).toHaveBeenCalledOnce();
    lifecycle.restore();
  });

  it("cleans up A before subscribing to B and ignores retained A callbacks", () => {
    const first = {};
    const second = {};
    const events: string[] = [];
    const callbacks = new Map<object, () => void>();
    const statuses = new Map<object, ProxyStatus>([
      [first, current],
      [second, stale],
    ]);
    const get = vi
      .spyOn(Nexus, "getProxyStatus")
      .mockImplementation((proxy) => statuses.get(proxy)!);
    const subscribe = vi
      .spyOn(Nexus, "subscribeProxyStatus")
      .mockImplementation((proxy, listener) => {
        events.push(`subscribe:${proxy === first ? "A" : "B"}`);
        callbacks.set(proxy, () => listener(statuses.get(proxy)!));
        listener(statuses.get(proxy)!);
        return () => events.push(`cleanup:${proxy === first ? "A" : "B"}`);
      });
    const { result, rerender } = renderHook(
      ({ proxy }) => useProxyStatus(proxy),
      { initialProps: { proxy: first } },
    );

    rerender({ proxy: second });
    expect(events).toEqual(["subscribe:A", "cleanup:A", "subscribe:B"]);
    act(() => statuses.set(first, disconnected));
    act(() => callbacks.get(first)!());
    expect(result.current).toBe(stale);
    expect(get).toHaveBeenLastCalledWith(second);
    expect(subscribe).toHaveBeenCalledTimes(2);
    get.mockRestore();
    subscribe.mockRestore();
  });

  it("balances subscriptions in StrictMode and returns null for absent proxies", () => {
    const lifecycle = mockLifecycle();
    const proxy = {};
    const { result, unmount } = renderHook(() => useProxyStatus(proxy), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    expect(result.current).toBe(current);
    expect(lifecycle.subscribe).toHaveBeenCalledTimes(2);
    unmount();
    expect(lifecycle.unsubscriptions).toBe(2);
    const { result: absent } = renderHook(() => useProxyStatus(null));
    expect(absent.current).toBeNull();
    lifecycle.restore();
  });

  it("uses null during SSR and hydration before observing the client snapshot", () => {
    const lifecycle = mockLifecycle();
    const proxy = {};
    function Status() {
      const status = useProxyStatus(proxy);
      return <span>{status?.type ?? "none"}</span>;
    }
    const markup = renderToString(<Status />);
    expect(markup).toContain("none");
    expect(lifecycle.get).not.toHaveBeenCalled();
    expect(lifecycle.subscribe).not.toHaveBeenCalled();

    const container = document.createElement("div");
    container.innerHTML = markup;
    let root!: ReturnType<typeof hydrateRoot>;
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    act(() => {
      root = hydrateRoot(container, <Status />);
    });
    expect(error).not.toHaveBeenCalled();
    expect(lifecycle.subscribe).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("active");
    act(() => root.unmount());
    error.mockRestore();

    lifecycle.restore();
  });

  it("passes falsy non-nullish values to Core and preserves its error", () => {
    const lifecycle = mockLifecycle();
    const error = new NexusUsageError("invalid", "E_USAGE_INVALID");
    lifecycle.get.mockImplementation(() => {
      throw error;
    });
    for (const value of [false, 0, "", Number.NaN]) {
      expect(() => renderHook(() => useProxyStatus(value as never))).toThrow(
        error,
      );
      expect(lifecycle.get).toHaveBeenLastCalledWith(value);
    }
    lifecycle.restore();
  });

  it("requires Core lifecycle statics for a client proxy", () => {
    const proxy = {};
    const core = Nexus as unknown as Record<string, unknown>;
    const get = core.getProxyStatus;
    const subscribe = core.subscribeProxyStatus;

    try {
      core.getProxyStatus = undefined;
      expect(() => renderHook(() => useProxyStatus(proxy))).toThrow(
        "useProxyStatus requires Core >=1.1.0",
      );

      core.getProxyStatus = get;
      core.subscribeProxyStatus = undefined;
      expect(() => renderHook(() => useProxyStatus(proxy))).toThrow(
        "useProxyStatus requires Core >=1.1.0",
      );
    } finally {
      core.getProxyStatus = get;
      core.subscribeProxyStatus = subscribe;
    }
  });

  it("fails hydration deterministically when Core lifecycle statics are missing", () => {
    const proxy = {};
    const core = Nexus as unknown as Record<string, unknown>;
    const get = core.getProxyStatus;
    const subscribe = core.subscribeProxyStatus;
    function Status() {
      const status = useProxyStatus(proxy);
      return <span>{status?.type ?? "none"}</span>;
    }
    const container = document.createElement("div");
    container.innerHTML = renderToString(<Status />);

    try {
      core.getProxyStatus = undefined;
      core.subscribeProxyStatus = undefined;
      expect(() => {
        act(() => hydrateRoot(container, <Status />));
      }).toThrow("useProxyStatus requires Core >=1.1.0");
    } finally {
      core.getProxyStatus = get;
      core.subscribeProxyStatus = subscribe;
    }
  });

  it("does not require lifecycle statics for nullish or server snapshots", () => {
    const proxy = {};
    const core = Nexus as unknown as Record<string, unknown>;
    const get = core.getProxyStatus;
    const subscribe = core.subscribeProxyStatus;

    try {
      core.getProxyStatus = undefined;
      core.subscribeProxyStatus = undefined;
      expect(renderHook(() => useProxyStatus(null)).result.current).toBeNull();

      function Status() {
        const status = useProxyStatus(proxy);
        return <span>{status?.type ?? "none"}</span>;
      }
      expect(renderToString(<Status />)).toContain("none");
    } finally {
      core.getProxyStatus = get;
      core.subscribeProxyStatus = subscribe;
    }
  });
});
