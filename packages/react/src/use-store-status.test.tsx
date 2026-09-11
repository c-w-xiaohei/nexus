import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import type { RemoteStoreStatus } from "@nexus-js/core/state";
import { useStoreStatus } from "./use-store-status";

function createStatusSource() {
  const state = createStore<RemoteStoreStatus>(() => ({
    type: "ready",
    storeInstanceId: "one",
    version: 0,
  }));
  const stop = vi.fn();
  return {
    getStatus: vi.fn(state.getState),
    subscribeStatus: vi.fn((listener: () => void) => {
      const unsubscribe = state.subscribe(listener);
      return () => {
        stop();
        unsubscribe();
      };
    }),
    destroy: vi.fn(),
    publish: (status: RemoteStoreStatus) => state.setState(status, true),
    stop,
  };
}

describe("useStoreStatus", () => {
  it("observes only the selection and uses new selectors without resubscribing", () => {
    const store = createStatusSource();
    let renders = 0;
    const { result, rerender, unmount } = renderHook(
      ({ version }) => {
        renders++;
        return useStoreStatus(store, (status) =>
          version && status.type === "ready" ? status.version : status.type,
        );
      },
      { initialProps: { version: false } },
    );
    const before = renders;
    act(() =>
      store.publish({ type: "ready", storeInstanceId: "one", version: 1 }),
    );
    expect(renders).toBe(before);
    expect(result.current).toBe("ready");
    rerender({ version: true });
    expect(result.current).toBe(1);
    act(() => store.publish({ type: "disconnected", lastKnownVersion: 1 }));
    expect(result.current).toBe("disconnected");
    expect(store.subscribeStatus).toHaveBeenCalledOnce();
    unmount();
    expect(store.stop).toHaveBeenCalledOnce();
    expect(store.destroy).not.toHaveBeenCalled();
  });

  it("switches nullable handles and exposes the full status only when requested", () => {
    const first = createStatusSource();
    const second = createStatusSource();
    const { result, rerender, unmount } = renderHook(
      ({ store }) => useStoreStatus(store),
      { initialProps: { store: null as typeof first | null } },
    );
    expect(result.current).toBeNull();
    rerender({ store: first });
    expect(result.current).toBe(first.getStatus());
    act(() =>
      first.publish({ type: "ready", storeInstanceId: "one", version: 2 }),
    );
    expect(result.current).toBe(first.getStatus());
    rerender({ store: second });
    expect(first.stop).toHaveBeenCalledOnce();
    act(() => first.publish({ type: "destroyed" }));
    expect(result.current).toBe(second.getStatus());
    rerender({ store: null });
    expect(result.current).toBeNull();
    expect(second.stop).toHaveBeenCalledOnce();
    unmount();
    expect(first.destroy).not.toHaveBeenCalled();
    expect(second.destroy).not.toHaveBeenCalled();
  });

  it("catches a transition between render and subscription", () => {
    const store = createStatusSource();
    const subscribe = store.subscribeStatus.getMockImplementation()!;
    store.subscribeStatus.mockImplementation((listener) => {
      store.publish({ type: "disconnected", lastKnownVersion: 0 });
      return subscribe(listener);
    });
    const { result, unmount } = renderHook(() =>
      useStoreStatus(store, (status) => status.type),
    );
    expect(result.current).toBe("disconnected");
    unmount();
  });

  it("does not read or subscribe during SSR and balances StrictMode subscriptions", () => {
    const store = createStatusSource();
    const View = () => (
      <output>
        {useStoreStatus(store, (status) => status.type) ?? "no-handle"}
      </output>
    );
    expect(renderToString(<View />)).toContain("no-handle");
    expect(store.getStatus).not.toHaveBeenCalled();
    expect(store.subscribeStatus).not.toHaveBeenCalled();
    const { unmount } = renderHook(() => useStoreStatus(store), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    unmount();
    expect(store.subscribeStatus.mock.calls.length).toBeGreaterThan(0);
    expect(store.stop.mock.calls.length).toBe(
      store.subscribeStatus.mock.calls.length,
    );
    expect(store.destroy).not.toHaveBeenCalled();
  });

  it("hydrates from null before observing the client handle", async () => {
    const store = createStatusSource();
    const View = () => (
      <output>
        {useStoreStatus(store, (status) => status.type) ?? "no-handle"}
      </output>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(<View />);
    document.body.append(container);
    const onRecoverableError = vi.fn();
    let root: Root | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, <View />, { onRecoverableError });
      });
      expect(container.textContent).toBe("ready");
      act(() => store.publish({ type: "disconnected", lastKnownVersion: 0 }));
      expect(container.textContent).toBe("disconnected");
      expect(onRecoverableError).not.toHaveBeenCalled();
    } finally {
      act(() => root?.unmount());
      container.remove();
    }
    expect(store.stop).toHaveBeenCalledOnce();
    expect(store.destroy).not.toHaveBeenCalled();
  });
});
