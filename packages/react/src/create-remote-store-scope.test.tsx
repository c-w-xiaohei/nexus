import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { useSyncExternalStore, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { useShallow } from "zustand/react/shallow";
import type { StoreApi } from "zustand/vanilla";
import { createStoreToken, type RemoteStore } from "@nexus-js/core/state";
import type { AdapterModel } from "@nexus-js/core";
import {
  createRemoteStoreScopeWithNexus,
  type RemoteStoreHook,
} from "./create-remote-store-scope";

interface State {
  count: number;
  label?: string;
}

type Store = StoreApi<State>;

const token = createStoreToken<State>("state:scope-selection");

const toRemoteStore = (store: Store): RemoteStore<State> => ({
  actions: {},
  getState: store.getState,
  getInitialState: store.getInitialState,
  subscribe: store.subscribe,
  getStatus: () => ({
    type: "ready",
    storeInstanceId: "test",
    version: 0,
  }),
  subscribeStatus: () => () => {},
  destroy: vi.fn(),
  [Symbol.dispose]: vi.fn(),
});

const createRemote = (store: Store | null) => ({
  store: store ? toRemoteStore(store) : null,
  pending: false,
  error: null,
  reconnect: vi.fn(),
});

const createOwner = (initial: ReturnType<typeof createRemote>) => {
  let remote = initial;
  const listeners = new Set<() => void>();
  const setRemote = (next: typeof remote) => {
    remote = next;
    for (const listener of listeners) listener();
  };
  const useOwner = (() =>
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => remote,
      () => remote,
    )) as unknown as RemoteStoreHook<AdapterModel>;
  return { setRemote, useOwner };
};

const wrapperFor =
  (Scope: ReturnType<typeof createRemoteStoreScopeWithNexus>) =>
  ({ children }: { children: ReactNode }) => (
    <Scope.Provider>{children}</Scope.Provider>
  );

describe("remote store scope selection", () => {
  it("switches between fallback and stores without retaining old subscriptions", () => {
    const first = createStore(() => ({ count: 1 }));
    const second = createStore(() => ({ count: 2 }));
    const stopFirst = vi.fn();
    const subscribeFirst = first.subscribe;
    first.subscribe = (listener) => {
      const stop = subscribeFirst(listener);
      return () => {
        stopFirst();
        stop();
      };
    };
    const owner = createOwner(createRemote(null));
    const Scope = createRemoteStoreScopeWithNexus(token, owner.useOwner);
    const { result } = renderHook(
      () => Scope.useSelector((state) => state.count, { fallback: -1 }),
      { wrapper: wrapperFor(Scope) },
    );
    expect(result.current).toBe(-1);
    act(() => owner.setRemote(createRemote(first)));
    expect(result.current).toBe(1);
    act(() => first.setState({ count: 3 }));
    expect(result.current).toBe(3);
    act(() => owner.setRemote(createRemote(second)));
    expect(stopFirst).toHaveBeenCalledOnce();
    act(() => first.setState({ count: 4 }));
    expect(result.current).toBe(2);
    act(() => owner.setRemote(createRemote(null)));
    expect(result.current).toBe(-1);
  });

  it("preserves fallback identity and supports Zustand's shallow selector", () => {
    const fallback = { count: -1 };
    const store = createStore(() => ({ count: 1, label: "one" }));
    const owner = createOwner(createRemote(null));
    const Scope = createRemoteStoreScopeWithNexus(token, owner.useOwner);
    const { result } = renderHook(
      () =>
        Scope.useSelector(
          useShallow((state) => ({ count: state.count })),
          { fallback },
        ),
      { wrapper: wrapperFor(Scope) },
    );
    expect(result.current).toBe(fallback);
    act(() => owner.setRemote(createRemote(store)));
    const selected = result.current;
    act(() => store.setState({ label: "changed" }));
    expect(result.current).toBe(selected);
    act(() => store.setState({ count: 2 }));
    expect(result.current).toEqual({ count: 2 });
  });

  it("reads only initial state during SSR and does not subscribe", () => {
    const store = createStore(() => ({ count: 1 }));
    store.setState({ count: 2 });
    const read = vi.spyOn(store, "getState");
    const subscribe = vi.spyOn(store, "subscribe");
    const owner = createOwner(createRemote(store));
    const Scope = createRemoteStoreScopeWithNexus(token, owner.useOwner);
    const Selection = () => (
      <output>
        {Scope.useSelector((state) => state.count, { fallback: -1 })}
      </output>
    );
    const View = () => (
      <Scope.Provider>
        <Selection />
      </Scope.Provider>
    );
    expect(renderToString(<View />)).toContain("1");
    expect(read).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
