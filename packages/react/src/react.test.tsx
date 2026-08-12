import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  NexusStoreDefinition,
  RemoteStore,
  RemoteStoreStatus,
} from "@nexus-js/core/state";
import { NexusProvider } from "./provider";
import { createRemoteStoreScope } from "./create-remote-store-scope";
import { useNexus } from "./use-nexus";
import { useRemoteStore } from "./use-remote-store";
import { useStoreSelector } from "./use-store-selector";

interface CounterState {
  count: number;
}

interface CounterActions {
  [key: string]: (...args: any[]) => any;
  increment(by: number): Promise<number>;
}

interface MinimalNexus {
  create: (...args: unknown[]) => Promise<unknown>;
  safeCreate: (...args: unknown[]) => unknown;
}

interface FakeRemoteStore<TState extends object> extends RemoteStore<
  TState,
  Record<string, (...args: any[]) => any>
> {
  [key: symbol]: unknown;
  staleMarkerCalls: number;
  pushState(nextState: TState): void;
  setStatus(nextStatus: RemoteStoreStatus): void;
}

const connectSpy = vi.fn();

vi.mock("@nexus-js/core/state", async () => {
  const actual = await vi.importActual<object>("@nexus-js/core/state");
  return {
    ...actual,
    connectNexusStore: (...args: unknown[]) => connectSpy(...args),
  };
});

const definition = {
  token: { id: "state:counter:react" },
} as unknown as NexusStoreDefinition<CounterState, CounterActions>;

const createFakeRemoteStore = (
  initialState: CounterState,
  initialStatus: RemoteStoreStatus,
): FakeRemoteStore<CounterState> => {
  const markStaleSymbol = Symbol.for("nexus.state.remote-store.mark-stale");
  let state = initialState;
  let status = initialStatus;
  const listeners = new Set<(snapshot: CounterState) => void>();
  let staleMarkerCalls = 0;

  return {
    get staleMarkerCalls() {
      return staleMarkerCalls;
    },
    actions: {
      async increment(by: number) {
        state = { count: state.count + by };
        for (const listener of listeners) {
          listener(state);
        }
        return state.count;
      },
    },
    getState() {
      return state;
    },
    getStatus() {
      return status;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      status = { type: "destroyed" };
      listeners.clear();
    },
    pushState(nextState) {
      state = nextState;
      for (const listener of listeners) {
        listener(state);
      }
    },
    setStatus(nextStatus) {
      status = nextStatus;
    },
    [markStaleSymbol]() {
      staleMarkerCalls += 1;
      const lastKnownVersion =
        status.type === "ready"
          ? status.version
          : status.type === "disconnected" || status.type === "stale"
            ? status.lastKnownVersion
            : null;

      status = {
        type: "stale",
        lastKnownVersion,
        reason: "target-changed",
      };
    },
  };
};

const createWrapper = (nexus: MinimalNexus) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <NexusProvider nexus={nexus as never}>{children}</NexusProvider>;
  };

const createRemoteResult = (
  store: FakeRemoteStore<CounterState> | null,
  status: RemoteStoreStatus,
) => ({
  store,
  status,
  error: null,
  reconnect: () => {},
});

describe("react adapter", () => {
  const getConnectCallsFrom = (startIndex: number) =>
    connectSpy.mock.calls.length - startIndex;

  const clearConnectSpy = () => {
    connectSpy.mockReset();
  };

  it("resolves @nexus-js/core/state imports in react package", async () => {
    const stateModule = await vi.importActual<Record<string, unknown>>(
      "@nexus-js/core/state",
    );

    expect(typeof stateModule.connectNexusStore).toBe("function");
    expect(typeof stateModule.NexusStoreProtocolError).toBe("function");
  });

  it("source entrypoint re-exports the public React hooks", async () => {
    const entry = await import("./index");

    expect(typeof entry.NexusProvider).toBe("function");
    expect(typeof entry.createRemoteStoreScope).toBe("function");
    expect(typeof entry.useNexus).toBe("function");
    expect(typeof entry.useRemoteStore).toBe("function");
    expect(typeof entry.useStoreSelector).toBe("function");
  });

  it("remote store scope Provider connects once and shares result, actions, and status", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const remote = createFakeRemoteStore(
      { count: 5 },
      { type: "ready", storeInstanceId: "instance:scope", version: 5 },
    );
    connectSpy.mockResolvedValueOnce(remote);

    const CounterScope = createRemoteStoreScope(definition);
    const startCalls = connectSpy.mock.calls.length;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <NexusProvider nexus={nexus as never}>
        <CounterScope.Provider options={{ target: { descriptor: "bg" } }}>
          {children}
        </CounterScope.Provider>
      </NexusProvider>
    );

    const { result } = renderHook(
      () => {
        const firstRemote = CounterScope.useRemoteStore();
        const secondRemote = CounterScope.useRemoteStore();
        const firstActions = CounterScope.useActions();
        const secondActions = CounterScope.useActions();
        const status = CounterScope.useStatus();

        return {
          firstRemote,
          secondRemote,
          firstActions,
          secondActions,
          status,
        };
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.firstRemote.store).toBe(remote);
      expect(result.current.secondRemote.store).toBe(remote);
      expect(result.current.firstActions).toBe(remote.actions);
      expect(result.current.secondActions).toBe(remote.actions);
      expect(result.current.status.type).toBe("ready");
    });
    expect(getConnectCallsFrom(startCalls)).toBe(1);
  });

  it("remote store scope useSelector subscribes to the shared store", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const remote = createFakeRemoteStore(
      { count: 1 },
      { type: "ready", storeInstanceId: "instance:selector", version: 1 },
    );
    connectSpy.mockResolvedValueOnce(remote);

    const CounterScope = createRemoteStoreScope(definition);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <NexusProvider nexus={nexus as never}>
        <CounterScope.Provider options={{ target: { descriptor: "bg" } }}>
          {children}
        </CounterScope.Provider>
      </NexusProvider>
    );

    const { result } = renderHook(
      () => CounterScope.useSelector((state) => state.count, { fallback: -1 }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).toBe(1);
    });

    remote.pushState({ count: 2 });

    await waitFor(() => {
      expect(result.current).toBe(2);
    });
  });

  it("remote store scope useActions returns null before ready and actions after ready", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const remote = createFakeRemoteStore(
      { count: 0 },
      { type: "ready", storeInstanceId: "instance:actions", version: 0 },
    );
    connectSpy.mockResolvedValueOnce(remote);

    const CounterScope = createRemoteStoreScope(definition);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <NexusProvider nexus={nexus as never}>
        <CounterScope.Provider options={{ target: { descriptor: "bg" } }}>
          {children}
        </CounterScope.Provider>
      </NexusProvider>
    );

    const { result } = renderHook(() => CounterScope.useActions(), { wrapper });

    expect(result.current).toBeNull();

    await waitFor(() => {
      expect(result.current).toBe(remote.actions);
    });
  });

  it("remote store scope Provider reconnectKey reconnects the same target without forwarding the key", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const firstStore = createFakeRemoteStore(
      { count: 1 },
      {
        type: "ready",
        storeInstanceId: "instance:scope-reconnect:1",
        version: 1,
      },
    );
    const secondStore = createFakeRemoteStore(
      { count: 2 },
      {
        type: "ready",
        storeInstanceId: "instance:scope-reconnect:2",
        version: 2,
      },
    );
    connectSpy
      .mockResolvedValueOnce(firstStore)
      .mockResolvedValueOnce(secondStore);

    const CounterScope = createRemoteStoreScope(definition);
    let reconnectKey = 0;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <NexusProvider nexus={nexus as never}>
        <CounterScope.Provider
          options={{
            target: { descriptor: "same-target" },
            reconnectKey,
          }}
        >
          {children}
        </CounterScope.Provider>
      </NexusProvider>
    );

    const { result, rerender } = renderHook(
      () => CounterScope.useSelector((state) => state.count, { fallback: -1 }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).toBe(1);
    });

    expect(connectSpy).toHaveBeenCalledTimes(1);
    rerender();
    expect(connectSpy).toHaveBeenCalledTimes(1);

    reconnectKey = 1;
    rerender();

    await waitFor(() => {
      expect(result.current).toBe(2);
    });

    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(connectSpy.mock.calls[0]?.[2]).toEqual({
      target: { descriptor: "same-target" },
    });
    expect(connectSpy.mock.calls[1]?.[2]).toEqual({
      target: { descriptor: "same-target" },
    });
  });

  it("remote store scope hooks fail fast outside scope Provider", () => {
    const CounterScope = createRemoteStoreScope(definition);

    expect(() => renderHook(() => CounterScope.useRemoteStore())).toThrowError(
      /RemoteStoreScope\.Provider/i,
    );
    expect(() =>
      renderHook(() =>
        CounterScope.useSelector((state) => state.count, { fallback: -1 }),
      ),
    ).toThrowError(/RemoteStoreScope\.Provider/i);
    expect(() => renderHook(() => CounterScope.useActions())).toThrowError(
      /RemoteStoreScope\.Provider/i,
    );
    expect(() => renderHook(() => CounterScope.useStatus())).toThrowError(
      /RemoteStoreScope\.Provider/i,
    );
    expect(() => renderHook(() => CounterScope.useError())).toThrowError(
      /RemoteStoreScope\.Provider/i,
    );
  });

  it("remote store scope Provider requires NexusProvider through useRemoteStore", () => {
    const CounterScope = createRemoteStoreScope(definition);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <CounterScope.Provider>{children}</CounterScope.Provider>
    );

    expect(() =>
      renderHook(() => CounterScope.useStatus(), { wrapper }),
    ).toThrowError(/NexusProvider/i);
  });

  it("NexusProvider exposes nexus instance", () => {
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    const wrapper = createWrapper(nexus);
    const { result } = renderHook(() => useNexus(), { wrapper });

    expect(result.current).toBe(nexus);
  });

  it("useNexus fails fast outside provider", () => {
    expect(() => renderHook(() => useNexus())).toThrowError(/NexusProvider/i);
  });

  it("useRemoteStore returns store/status/error", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const remote = createFakeRemoteStore(
      { count: 0 },
      { type: "ready", storeInstanceId: "instance:1", version: 0 },
    );

    connectSpy.mockResolvedValueOnce(remote);

    const wrapper = createWrapper(nexus);
    const { result } = renderHook(
      () => useRemoteStore(definition, { target: { descriptor: "bg" } }),
      { wrapper },
    );

    expect(result.current.store).toBeNull();
    expect(result.current.status.type).toBe("initializing");
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.store).toBe(remote);
      expect(result.current.status.type).toBe("ready");
      expect(result.current.error).toBeNull();
    });
  });

  it("reconnect replaces a ready same-target store without marking it stale", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const firstStore = createFakeRemoteStore(
      { count: 1 },
      { type: "ready", storeInstanceId: "instance:manual:1", version: 1 },
    );
    const secondStore = createFakeRemoteStore(
      { count: 2 },
      { type: "ready", storeInstanceId: "instance:manual:2", version: 2 },
    );
    connectSpy
      .mockResolvedValueOnce(firstStore)
      .mockResolvedValueOnce(secondStore);

    const { result } = renderHook(
      () =>
        useRemoteStore(definition, { target: { descriptor: "same-target" } }),
      { wrapper: createWrapper(nexus) },
    );

    await waitFor(() => {
      expect(result.current.store).toBe(firstStore);
    });

    act(() => {
      result.current.reconnect();
    });

    await waitFor(() => {
      expect(result.current.store).toBe(secondStore);
    });

    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(connectSpy.mock.calls[1]?.[2]).toEqual({
      target: { descriptor: "same-target" },
    });
    expect(firstStore.staleMarkerCalls).toBe(0);
    expect(firstStore.getStatus().type).toBe("destroyed");
  });

  it("remote store scope reconnect rebuilds its shared Provider store", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const firstStore = createFakeRemoteStore(
      { count: 1 },
      { type: "ready", storeInstanceId: "instance:scope-manual:1", version: 1 },
    );
    const secondStore = createFakeRemoteStore(
      { count: 2 },
      { type: "ready", storeInstanceId: "instance:scope-manual:2", version: 2 },
    );
    connectSpy
      .mockResolvedValueOnce(firstStore)
      .mockResolvedValueOnce(secondStore);

    const CounterScope = createRemoteStoreScope(definition);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <NexusProvider nexus={nexus as never}>
        <CounterScope.Provider options={{ target: { descriptor: "bg" } }}>
          {children}
        </CounterScope.Provider>
      </NexusProvider>
    );
    const { result } = renderHook(() => CounterScope.useRemoteStore(), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.store).toBe(firstStore);
    });

    act(() => {
      result.current.reconnect();
    });

    await waitFor(() => {
      expect(result.current.store).toBe(secondStore);
    });
    expect(firstStore.getStatus().type).toBe("destroyed");
  });

  it("reconnect recovers from an initial connect failure and clears the error", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const replacement = createFakeRemoteStore(
      { count: 2 },
      { type: "ready", storeInstanceId: "instance:recovered", version: 2 },
    );
    connectSpy
      .mockRejectedValueOnce(new Error("initial-connect-failed"))
      .mockResolvedValueOnce(replacement);

    const { result } = renderHook(
      () => useRemoteStore(definition, { target: { descriptor: "bg" } }),
      { wrapper: createWrapper(nexus) },
    );

    await waitFor(() => {
      expect(result.current.error?.message).toBe("initial-connect-failed");
    });

    act(() => {
      result.current.reconnect();
    });

    await waitFor(() => {
      expect(result.current.store).toBe(replacement);
      expect(result.current.error).toBeNull();
    });
  });

  it("reconnect discards a pending acquisition and coalesces batched requests", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    let resolveFirst!: (store: FakeRemoteStore<CounterState>) => void;
    const firstConnect = new Promise<FakeRemoteStore<CounterState>>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    const replacement = createFakeRemoteStore(
      { count: 2 },
      { type: "ready", storeInstanceId: "instance:pending:2", version: 2 },
    );
    connectSpy
      .mockReturnValueOnce(firstConnect)
      .mockResolvedValueOnce(replacement);

    const { result } = renderHook(
      () => useRemoteStore(definition, { target: { descriptor: "bg" } }),
      { wrapper: createWrapper(nexus) },
    );

    act(() => {
      result.current.reconnect();
      result.current.reconnect();
    });

    await waitFor(() => {
      expect(result.current.store).toBe(replacement);
    });
    expect(connectSpy).toHaveBeenCalledTimes(2);

    const lateStore = createFakeRemoteStore(
      { count: 1 },
      { type: "ready", storeInstanceId: "instance:pending:1", version: 1 },
    );
    resolveFirst(lateStore);

    await waitFor(() => {
      expect(lateStore.getStatus().type).toBe("destroyed");
      expect(result.current.store).toBe(replacement);
    });
  });

  it("reconnect is stable and inactive after unmount", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const remote = createFakeRemoteStore(
      { count: 1 },
      { type: "ready", storeInstanceId: "instance:unmounted", version: 1 },
    );
    connectSpy.mockResolvedValueOnce(remote);

    const { result, rerender, unmount } = renderHook(
      () => useRemoteStore(definition, { target: { descriptor: "bg" } }),
      { wrapper: createWrapper(nexus) },
    );

    await waitFor(() => {
      expect(result.current.store).toBe(remote);
    });
    const reconnect = result.current.reconnect;
    rerender();
    expect(result.current.reconnect).toBe(reconnect);

    unmount();
    act(() => {
      reconnect();
    });
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("useStoreSelector is hook-safe and fallback-aware", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const remote = createFakeRemoteStore(
      { count: 0 },
      { type: "initializing" },
    );

    connectSpy.mockResolvedValueOnce(remote);

    const wrapper = createWrapper(nexus);
    const { result } = renderHook(
      () => {
        const value = useRemoteStore(definition, {
          target: { descriptor: "bg" },
        });
        const selected = useStoreSelector(value, (state) => state.count, {
          fallback: -1,
        });
        return { value, selected };
      },
      { wrapper },
    );

    expect(result.current.selected).toBe(-1);

    remote.setStatus({
      type: "ready",
      storeInstanceId: "instance:1",
      version: 0,
    });
    remote.pushState({ count: 1 });

    await waitFor(() => {
      expect(result.current.selected).toBe(1);
    });

    remote.setStatus({
      type: "disconnected",
      lastKnownVersion: 1,
    });
    remote.pushState({ count: 2 });

    await waitFor(() => {
      expect(result.current.selected).toBe(2);
    });
  });

  it("target change marks active store stale before replacement", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    const oldStore = createFakeRemoteStore(
      { count: 4 },
      { type: "ready", storeInstanceId: "instance:old", version: 4 },
    );

    let resolveNext!: (store: FakeRemoteStore<CounterState>) => void;
    const nextConnect = new Promise<FakeRemoteStore<CounterState>>(
      (resolve) => {
        resolveNext = resolve;
      },
    );

    connectSpy.mockResolvedValueOnce(oldStore).mockReturnValueOnce(nextConnect);

    const wrapper = createWrapper(nexus);
    const { result, rerender } = renderHook(
      ({ target }) => useRemoteStore(definition, { target }),
      {
        initialProps: { target: { descriptor: "old" } },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.store).toBe(oldStore);
      expect(result.current.status.type).toBe("ready");
    });

    rerender({ target: { descriptor: "new" } });

    await waitFor(() => {
      expect(result.current.store).toBeNull();
      expect(result.current.status.type).toBe("initializing");
      expect(oldStore.getStatus().type).toBe("stale");
    });

    const nextStore = createFakeRemoteStore(
      { count: 10 },
      { type: "ready", storeInstanceId: "instance:new", version: 10 },
    );
    resolveNext(nextStore);

    await waitFor(() => {
      expect(result.current.store).toBe(nextStore);
      expect(result.current.status.type).toBe("ready");
      expect(oldStore.getStatus().type).toBe("destroyed");
    });
  });

  it("target change renders selector fallback before the handoff effect runs", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const firstStore = createFakeRemoteStore(
      { count: 1 },
      { type: "ready", storeInstanceId: "instance:first-render:a", version: 1 },
    );
    let resolveB!: (store: FakeRemoteStore<CounterState>) => void;
    const connectB = new Promise<FakeRemoteStore<CounterState>>((resolve) => {
      resolveB = resolve;
    });
    connectSpy.mockResolvedValueOnce(firstStore).mockReturnValueOnce(connectB);
    const renders: Array<{ target: string; selected: number; status: string }> =
      [];

    const { result, rerender } = renderHook(
      ({ target }) => {
        const remote = useRemoteStore(definition, { target });
        const selected = useStoreSelector(remote, (state) => state.count, {
          fallback: -1,
        });
        renders.push({
          target: target.descriptor,
          selected,
          status: remote.status.type,
        });
        return { remote, selected };
      },
      {
        initialProps: { target: { descriptor: "a" } },
        wrapper: createWrapper(nexus),
      },
    );

    await waitFor(() => {
      expect(result.current.selected).toBe(1);
    });

    rerender({ target: { descriptor: "b" } });

    expect(renders.find((render) => render.target === "b")).toEqual({
      target: "b",
      selected: -1,
      status: "stale",
    });

    const replacement = createFakeRemoteStore(
      { count: 2 },
      { type: "ready", storeInstanceId: "instance:first-render:b", version: 2 },
    );
    resolveB(replacement);

    await waitFor(() => {
      expect(result.current.selected).toBe(2);
    });
  });

  it("target change replaces store and ignores stale late resolve", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    let resolveOld!: (store: FakeRemoteStore<CounterState>) => void;
    const oldConnect = new Promise<FakeRemoteStore<CounterState>>((resolve) => {
      resolveOld = resolve;
    });

    const nextStore = createFakeRemoteStore(
      { count: 10 },
      { type: "ready", storeInstanceId: "instance:2", version: 10 },
    );

    connectSpy.mockReturnValueOnce(oldConnect).mockResolvedValueOnce(nextStore);

    const wrapper = createWrapper(nexus);
    const { result, rerender } = renderHook(
      ({ target }) => useRemoteStore(definition, { target }),
      {
        initialProps: { target: { descriptor: "old" } },
        wrapper,
      },
    );

    rerender({ target: { descriptor: "new" } });

    await waitFor(() => {
      expect(result.current.store).toBe(nextStore);
      expect(result.current.status.type).toBe("ready");
    });

    const oldStore = createFakeRemoteStore(
      { count: 99 },
      { type: "ready", storeInstanceId: "instance:old", version: 99 },
    );
    resolveOld(oldStore);

    await waitFor(() => {
      expect(result.current.store).toBe(nextStore);
      expect(result.current.status.type).toBe("ready");
    });

    oldStore.pushState({ count: 123 });

    await waitFor(() => {
      expect(result.current.store).toBe(nextStore);
      expect(result.current.store?.getState().count).toBe(10);
    });
  });

  it("cross-target reconnect keeps the old selector value stale until the latest replacement is ready", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const firstStore = createFakeRemoteStore(
      { count: 1 },
      { type: "ready", storeInstanceId: "instance:cross-target:a", version: 1 },
    );
    let resolveB!: (store: FakeRemoteStore<CounterState>) => void;
    const connectB = new Promise<FakeRemoteStore<CounterState>>((resolve) => {
      resolveB = resolve;
    });
    let resolveLatest!: (store: FakeRemoteStore<CounterState>) => void;
    const connectLatest = new Promise<FakeRemoteStore<CounterState>>(
      (resolve) => {
        resolveLatest = resolve;
      },
    );
    connectSpy
      .mockResolvedValueOnce(firstStore)
      .mockReturnValueOnce(connectB)
      .mockReturnValueOnce(connectLatest);

    const { result, rerender } = renderHook(
      ({ target }) => {
        const remote = useRemoteStore(definition, { target });
        const selected = useStoreSelector(remote, (state) => state.count, {
          fallback: -1,
        });
        return { remote, selected };
      },
      {
        initialProps: { target: { descriptor: "a" } },
        wrapper: createWrapper(nexus),
      },
    );

    await waitFor(() => {
      expect(result.current.selected).toBe(1);
    });

    rerender({ target: { descriptor: "b" } });

    await waitFor(() => {
      expect(result.current.remote.status.type).toBe("initializing");
      expect(result.current.selected).toBe(-1);
    });

    act(() => {
      result.current.remote.reconnect();
    });

    await waitFor(() => {
      expect(connectSpy).toHaveBeenCalledTimes(3);
      expect(result.current.selected).toBe(-1);
    });

    const lateB = createFakeRemoteStore(
      { count: 2 },
      { type: "ready", storeInstanceId: "instance:cross-target:b", version: 2 },
    );
    resolveB(lateB);

    await waitFor(() => {
      expect(lateB.getStatus().type).toBe("destroyed");
      expect(result.current.selected).toBe(-1);
    });

    const latestStore = createFakeRemoteStore(
      { count: 3 },
      {
        type: "ready",
        storeInstanceId: "instance:cross-target:latest",
        version: 3,
      },
    );
    resolveLatest(latestStore);

    await waitFor(() => {
      expect(result.current.remote.store).toBe(latestStore);
      expect(result.current.selected).toBe(3);
    });
  });

  it("failed latest cross-target reconnect destroys the stale handle without restoring its selector value", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const firstStore = createFakeRemoteStore(
      { count: 1 },
      {
        type: "ready",
        storeInstanceId: "instance:failed-cross-target:a",
        version: 1,
      },
    );
    const destroyFirstStore = vi.spyOn(firstStore, "destroy");
    let resolveB!: (store: FakeRemoteStore<CounterState>) => void;
    const connectB = new Promise<FakeRemoteStore<CounterState>>((resolve) => {
      resolveB = resolve;
    });
    connectSpy
      .mockResolvedValueOnce(firstStore)
      .mockReturnValueOnce(connectB)
      .mockRejectedValueOnce(new Error("latest-connect-failed"));

    const { result, rerender } = renderHook(
      ({ target }) => {
        const remote = useRemoteStore(definition, { target });
        const selected = useStoreSelector(remote, (state) => state.count, {
          fallback: -1,
        });
        return { remote, selected };
      },
      {
        initialProps: { target: { descriptor: "a" } },
        wrapper: createWrapper(nexus),
      },
    );

    await waitFor(() => {
      expect(result.current.selected).toBe(1);
    });

    rerender({ target: { descriptor: "b" } });

    await waitFor(() => {
      expect(result.current.selected).toBe(-1);
    });

    act(() => {
      result.current.remote.reconnect();
    });

    await waitFor(() => {
      expect(result.current.remote.status.type).toBe("disconnected");
      expect(result.current.remote.error?.message).toBe(
        "latest-connect-failed",
      );
      expect(result.current.selected).toBe(-1);
      expect(destroyFirstStore).toHaveBeenCalledTimes(1);
      expect(firstStore.getStatus().type).toBe("destroyed");
    });

    const lateB = createFakeRemoteStore(
      { count: 2 },
      {
        type: "ready",
        storeInstanceId: "instance:failed-cross-target:b",
        version: 2,
      },
    );
    resolveB(lateB);

    await waitFor(() => {
      expect(lateB.getStatus().type).toBe("destroyed");
    });
  });

  it("target change after same-target reconnect failure invalidates the cached selector value", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const firstStore = createFakeRemoteStore(
      { count: 1 },
      {
        type: "ready",
        storeInstanceId: "instance:failed-same-target:a",
        version: 1,
      },
    );
    let resolveB!: (store: FakeRemoteStore<CounterState>) => void;
    const connectB = new Promise<FakeRemoteStore<CounterState>>((resolve) => {
      resolveB = resolve;
    });
    connectSpy
      .mockResolvedValueOnce(firstStore)
      .mockRejectedValueOnce(new Error("same-target-connect-failed"))
      .mockReturnValueOnce(connectB);
    const renders: Array<{ target: string; selected: number; status: string }> =
      [];

    const { result, rerender } = renderHook(
      ({ target }) => {
        const remote = useRemoteStore(definition, { target });
        const selected = useStoreSelector(remote, (state) => state.count, {
          fallback: -1,
        });
        renders.push({
          target: target.descriptor,
          selected,
          status: remote.status.type,
        });
        return { remote, selected };
      },
      {
        initialProps: { target: { descriptor: "a" } },
        wrapper: createWrapper(nexus),
      },
    );

    await waitFor(() => {
      expect(result.current.selected).toBe(1);
    });

    act(() => {
      result.current.remote.reconnect();
    });

    await waitFor(() => {
      expect(result.current.remote.status.type).toBe("disconnected");
      expect(result.current.remote.error?.message).toBe(
        "same-target-connect-failed",
      );
      expect(result.current.selected).toBe(1);
    });

    rerender({ target: { descriptor: "b" } });

    expect(renders.find((render) => render.target === "b")).toEqual({
      target: "b",
      selected: -1,
      status: "stale",
    });

    await waitFor(() => {
      expect(result.current.remote.status.type).toBe("initializing");
      expect(result.current.selected).toBe(-1);
    });

    const replacement = createFakeRemoteStore(
      { count: 2 },
      {
        type: "ready",
        storeInstanceId: "instance:failed-same-target:b",
        version: 2,
      },
    );
    resolveB(replacement);

    await waitFor(() => {
      expect(result.current.remote.store).toBe(replacement);
      expect(result.current.selected).toBe(2);
    });
  });

  it("option changes beyond target trigger reconnect", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    const firstStore = createFakeRemoteStore(
      { count: 1 },
      { type: "ready", storeInstanceId: "instance:1", version: 1 },
    );
    const secondStore = createFakeRemoteStore(
      { count: 2 },
      { type: "ready", storeInstanceId: "instance:2", version: 2 },
    );

    connectSpy
      .mockResolvedValueOnce(firstStore)
      .mockResolvedValueOnce(secondStore);

    const startCalls = connectSpy.mock.calls.length;

    const wrapper = createWrapper(nexus);
    const { result, rerender } = renderHook(
      ({ timeout }) =>
        useRemoteStore(definition, {
          target: { descriptor: "same-target" },
          timeout,
        }),
      {
        initialProps: { timeout: 100 },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.store).toBe(firstStore);
      expect(result.current.status.type).toBe("ready");
    });

    rerender({ timeout: 200 });

    await waitFor(() => {
      expect(result.current.store).toBe(secondStore);
      expect(result.current.status.type).toBe("ready");
    });

    expect(getConnectCallsFrom(startCalls)).toBe(2);
  });

  it("reconnectKey reconnects the same target without forwarding the key", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;
    const firstStore = createFakeRemoteStore(
      { count: 1 },
      { type: "ready", storeInstanceId: "instance:reconnect:1", version: 1 },
    );
    const secondStore = createFakeRemoteStore(
      { count: 2 },
      { type: "ready", storeInstanceId: "instance:reconnect:2", version: 2 },
    );
    connectSpy
      .mockResolvedValueOnce(firstStore)
      .mockResolvedValueOnce(secondStore);

    const wrapper = createWrapper(nexus);
    const { result, rerender } = renderHook(
      ({ reconnectKey }) =>
        useRemoteStore(definition, {
          target: { descriptor: "same-target" },
          reconnectKey,
        }),
      {
        initialProps: { reconnectKey: 0 },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.store).toBe(firstStore);
      expect(result.current.status.type).toBe("ready");
    });

    expect(connectSpy).toHaveBeenCalledTimes(1);
    rerender({ reconnectKey: 0 });
    expect(connectSpy).toHaveBeenCalledTimes(1);

    rerender({ reconnectKey: 1 });

    await waitFor(() => {
      expect(result.current.store).toBe(secondStore);
      expect(result.current.status.type).toBe("ready");
    });

    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(connectSpy.mock.calls[1]?.[2]).toEqual({
      target: { descriptor: "same-target" },
    });
    expect(firstStore.staleMarkerCalls).toBe(0);
    expect(firstStore.getStatus().type).toBe("destroyed");
  });

  it("initial connect failure reports disconnected status instead of initializing", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    connectSpy.mockRejectedValueOnce(new Error("initial-connect-failed"));

    const wrapper = createWrapper(nexus);
    const { result } = renderHook(
      () => useRemoteStore(definition, { target: { descriptor: "bg" } }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.store).toBeNull();
      expect(result.current.status.type).toBe("disconnected");
      expect(result.current.error?.message).toBe("initial-connect-failed");
      if (result.current.status.type === "disconnected") {
        expect(result.current.status.lastKnownVersion).toBeNull();
        expect(result.current.status.cause).toBeInstanceOf(Error);
      }
    });
  });

  it("normalizes non-Error connect rejection to Error", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    connectSpy.mockRejectedValueOnce("plain-failure");

    const wrapper = createWrapper(nexus);
    const { result } = renderHook(
      () => useRemoteStore(definition, { target: { descriptor: "bg" } }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.status.type).toBe("disconnected");
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("plain-failure");
      if (result.current.status.type === "disconnected") {
        expect(result.current.status.cause).toBeInstanceOf(Error);
      }
    });
  });

  it("destroys active store on hook unmount after successful connect", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    const remote = createFakeRemoteStore(
      { count: 3 },
      { type: "ready", storeInstanceId: "instance:umount", version: 3 },
    );
    const destroySpy = vi.spyOn(remote, "destroy");
    connectSpy.mockResolvedValueOnce(remote);

    const wrapper = createWrapper(nexus);
    const { result, unmount } = renderHook(
      () => useRemoteStore(definition, { target: { descriptor: "bg" } }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.status.type).toBe("ready");
      expect(result.current.store).toBe(remote);
    });

    unmount();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(remote.getStatus().type).toBe("destroyed");
  });

  it("uses store-bound stale marker during target handoff", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    const markerStore = createFakeRemoteStore(
      { count: 1 },
      { type: "ready", storeInstanceId: "instance:marker-old", version: 1 },
    );

    const markerSymbol = Symbol.for("nexus.state.remote-store.mark-stale");
    markerStore[markerSymbol] = vi.fn(markerStore[markerSymbol] as () => void);

    const nextStore = createFakeRemoteStore(
      { count: 2 },
      { type: "ready", storeInstanceId: "instance:marker-new", version: 2 },
    );

    connectSpy
      .mockResolvedValueOnce(markerStore)
      .mockResolvedValueOnce(nextStore);

    const wrapper = createWrapper(nexus);
    const { result, rerender } = renderHook(
      ({ target }) => useRemoteStore(definition, { target }),
      {
        initialProps: { target: { descriptor: "old" } },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.status.type).toBe("ready");
      expect(result.current.store).toBe(markerStore);
    });

    rerender({ target: { descriptor: "new" } });

    await waitFor(() => {
      expect(result.current.status.type).toBe("ready");
      expect(result.current.store).toBe(nextStore);
    });

    expect(markerStore[markerSymbol]).toHaveBeenCalledTimes(1);
  });

  it("failed reconnect reports disconnected and keeps last selected value", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    const firstStore = createFakeRemoteStore(
      { count: 7 },
      { type: "ready", storeInstanceId: "instance:ok", version: 7 },
    );

    connectSpy
      .mockResolvedValueOnce(firstStore)
      .mockRejectedValueOnce(new Error("reconnect-failed"));

    const wrapper = createWrapper(nexus);
    const { result, rerender } = renderHook(
      ({ timeout }) => {
        const remote = useRemoteStore(definition, {
          target: { descriptor: "bg" },
          timeout,
        });
        const selected = useStoreSelector(remote, (state) => state.count, {
          fallback: -1,
        });
        return { remote, selected };
      },
      {
        initialProps: { timeout: 100 },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.remote.status.type).toBe("ready");
      expect(result.current.selected).toBe(7);
    });

    rerender({ timeout: 200 });

    await waitFor(() => {
      expect(result.current.remote.store).toBeNull();
      expect(result.current.remote.status.type).toBe("disconnected");
      expect(result.current.remote.error?.message).toBe("reconnect-failed");
      expect(result.current.selected).toBe(7);
      if (result.current.remote.status.type === "disconnected") {
        expect(result.current.remote.status.lastKnownVersion).toBe(7);
        expect(result.current.remote.status.cause).toBeInstanceOf(Error);
      }
    });
  });

  it("matcher target identity is stable by function reference", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    const sameMatcher = (identity: { context?: string }) =>
      identity.context === "bg";
    const firstStore = createFakeRemoteStore(
      { count: 1 },
      { type: "ready", storeInstanceId: "instance:matcher-1", version: 1 },
    );
    const secondStore = createFakeRemoteStore(
      { count: 2 },
      { type: "ready", storeInstanceId: "instance:matcher-2", version: 2 },
    );

    connectSpy
      .mockResolvedValueOnce(firstStore)
      .mockResolvedValueOnce(secondStore);

    const startCalls = connectSpy.mock.calls.length;
    const wrapper = createWrapper(nexus);
    const { rerender } = renderHook(
      ({ matcher }) =>
        useRemoteStore(definition, {
          target: { matcher },
        }),
      {
        initialProps: { matcher: sameMatcher },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(getConnectCallsFrom(startCalls)).toBe(1);
    });

    rerender({ matcher: sameMatcher });

    await waitFor(() => {
      expect(getConnectCallsFrom(startCalls)).toBe(1);
    });

    const structurallySameMatcher = (identity: { context?: string }) =>
      identity.context === "bg";
    rerender({ matcher: structurallySameMatcher });

    await waitFor(() => {
      expect(getConnectCallsFrom(startCalls)).toBe(2);
    });
  });

  it("updates lifecycle status without requiring snapshot events", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    const remote = createFakeRemoteStore(
      { count: 0 },
      { type: "ready", storeInstanceId: "instance:life", version: 0 },
    );

    connectSpy.mockResolvedValueOnce(remote);

    const wrapper = createWrapper(nexus);
    const { result } = renderHook(
      () => useRemoteStore(definition, { target: { descriptor: "bg" } }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.status.type).toBe("ready");
    });

    remote.setStatus({
      type: "disconnected",
      lastKnownVersion: 0,
    });

    await waitFor(() => {
      expect(result.current.status.type).toBe("disconnected");
    });
  });

  it("target change after disconnected state marks adapter stale immediately", async () => {
    clearConnectSpy();
    const nexus = {
      create: vi.fn(),
      safeCreate: vi.fn(),
    } satisfies MinimalNexus;

    const firstStore = createFakeRemoteStore(
      { count: 7 },
      { type: "ready", storeInstanceId: "instance:handoff-old", version: 7 },
    );
    const secondStore = createFakeRemoteStore(
      { count: 9 },
      { type: "ready", storeInstanceId: "instance:handoff-new", version: 9 },
    );

    connectSpy
      .mockResolvedValueOnce(firstStore)
      .mockResolvedValueOnce(secondStore);

    const wrapper = createWrapper(nexus);
    const { result, rerender } = renderHook(
      ({ remote }) =>
        useStoreSelector(remote, (state) => state.count, {
          fallback: -1,
        }),
      {
        initialProps: {
          remote: createRemoteResult(null, { type: "initializing" }),
        },
        wrapper,
      },
    );

    const { result: remoteResult, rerender: rerenderRemote } = renderHook(
      ({ target }) => useRemoteStore(definition, { target }),
      {
        initialProps: { target: { descriptor: "old" } },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(remoteResult.current.store).toBe(firstStore);
      expect(remoteResult.current.status.type).toBe("ready");
    });

    rerender({ remote: remoteResult.current as any });
    expect(result.current).toBe(7);

    firstStore.setStatus({ type: "disconnected", lastKnownVersion: 7 });
    rerender({ remote: remoteResult.current as any });

    await waitFor(() => {
      expect(result.current).toBe(7);
    });

    rerenderRemote({ target: { descriptor: "new" } });
    rerender({ remote: remoteResult.current as any });

    await waitFor(() => {
      expect(result.current).toBe(-1);
      expect(remoteResult.current.status.type).toBe("initializing");
      expect(firstStore.getStatus().type).toBe("stale");
    });

    await waitFor(() => {
      expect(remoteResult.current.store).toBe(secondStore);
      expect(remoteResult.current.status.type).toBe("ready");
    });
  });

  it("useStoreSelector keeps last mirrored value after ready across reconnect initializing", () => {
    const store = createFakeRemoteStore(
      { count: 7 },
      { type: "ready", storeInstanceId: "instance:keep", version: 7 },
    );

    const { result, rerender } = renderHook(
      ({ remote }) =>
        useStoreSelector(remote, (state) => state.count, {
          fallback: -1,
        }),
      {
        initialProps: {
          remote: createRemoteResult(null, { type: "initializing" }),
        },
      },
    );

    expect(result.current).toBe(-1);

    rerender({
      remote: createRemoteResult(store, {
        type: "ready",
        storeInstanceId: "instance:keep",
        version: 7,
      }),
    });
    expect(result.current).toBe(7);

    rerender({
      remote: createRemoteResult(null, {
        type: "disconnected",
        lastKnownVersion: 7,
      }),
    });
    expect(result.current).toBe(7);

    rerender({
      remote: createRemoteResult(null, { type: "initializing" }),
    });
    expect(result.current).toBe(7);
  });

  it("useStoreSelector falls back after cross-target stale transition", () => {
    const staleStore = createFakeRemoteStore(
      { count: 7 },
      { type: "stale", lastKnownVersion: 7, reason: "target-changed" },
    );
    const readyStore = createFakeRemoteStore(
      { count: 7 },
      { type: "ready", storeInstanceId: "instance:old", version: 7 },
    );

    const { result, rerender } = renderHook(
      ({ remote }) =>
        useStoreSelector(remote, (state) => state.count, {
          fallback: -1,
        }),
      {
        initialProps: {
          remote: createRemoteResult(readyStore, {
            type: "ready",
            storeInstanceId: "instance:old",
            version: 7,
          }),
        },
      },
    );

    expect(result.current).toBe(7);

    rerender({
      remote: createRemoteResult(null, { type: "initializing" }),
    });
    expect(result.current).toBe(7);

    rerender({
      remote: createRemoteResult(staleStore, {
        type: "stale",
        lastKnownVersion: 7,
        reason: "target-changed",
      }),
    });

    rerender({
      remote: createRemoteResult(null, { type: "initializing" }),
    });
    expect(result.current).toBe(-1);
  });
});
