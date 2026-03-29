import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type {
  NexusStoreDefinition,
  RemoteStore,
  RemoteStoreStatus,
} from "@nexus-js/core/state";
import { NexusProvider } from "./provider";
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

  return {
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

  it("built package entrypoint is consumable", async () => {
    const builtEntry = "../dist/index.mjs";
    const built = await import(builtEntry);

    expect(typeof built.NexusProvider).toBe("function");
    expect(typeof built.useNexus).toBe("function");
    expect(typeof built.useRemoteStore).toBe("function");
    expect(typeof built.useStoreSelector).toBe("function");
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
      expect(result.current.store).toBeNull();
      expect(result.current.status.type).toBe("initializing");
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
