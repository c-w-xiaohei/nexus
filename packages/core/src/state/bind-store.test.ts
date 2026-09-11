import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  createJSONStorage,
  devtools,
  persist,
  subscribeWithSelector,
} from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { z } from "zod";
import { Token } from "../api/token";
import { createStarNetwork } from "../utils/test-utils";
import {
  SERVICE_INVOKE_START,
  SERVICE_ON_DISCONNECT,
} from "../service/service-invocation-hooks";
import { RELEASE_PROXY_SYMBOL } from "../types/symbols";
import { bindNexusStore, createNexusStore } from "./bind-store";
import { createRemoteStore } from "./remote-store";
import { connectNexusStore } from "./connect-store";
import { Result } from "better-result";
import type { InitEnvelope, SyncEnvelope } from "./protocol";
import type { NexusStoreServiceContract } from "./contract";

type Data = { count: number };
type Actions = { increment(by: number): number };
const definition = {
  token: new Token<NexusStoreServiceContract<Data, Actions>>("state:buffered"),
};
const options = {
  snapshot: (state: Data) => ({ count: state.count }),
  expose: ["increment"] as const,
};
const cleanup: Array<() => void> = [];
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const store = createStore<Data & Actions>()((set, get) => ({
    count: 0,
    increment(by) {
      set((state) => ({ count: state.count + by }));
      return get().count;
    },
  }));
  const binding = bindNexusStore(definition, store, options);
  cleanup.push(() => binding.destroy());
  return { store, ...binding };
}
async function subscribe(
  service: NexusStoreServiceContract<Data, Actions>,
  callback: (event: SyncEnvelope<Data, Actions>) => unknown = () => undefined,
) {
  let init!: InitEnvelope<Data, Actions>;
  await service.subscribe(async (event) => {
    if (event.type === "init") init = event;
    await callback(event);
  });
  return init;
}
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
  vi.useRealTimers();
});

describe("buffered Zustand binding", () => {
  it.each([{ publishWindowMs: -1 }, { maxPendingSnapshots: 0 }])(
    "rejects invalid publication settings before observing the source: %j",
    (limits) => {
      const store = createStore<Data & Actions>(() => ({
        count: 0,
        increment: (by) => by,
      }));
      const observe = vi.spyOn(store, "subscribe");
      expect(() =>
        bindNexusStore(definition, store, { ...options, ...limits }),
      ).toThrowError(expect.objectContaining({ code: "E_STORE_PROTOCOL" }));
      expect(observe).not.toHaveBeenCalled();
    },
  );

  it("starts an active action before yielding and rejects later calls after unsubscribe", async () => {
    const { provider, store } = setup();
    const init = await subscribe(provider.service);
    const first = init.actions.increment(1);
    expect(store.getState().count).toBe(1);
    init.unsubscribe();
    await expect(first).rejects.toMatchObject({ code: "E_STORE_DISCONNECTED" });
    await expect(init.actions.increment(1)).rejects.toMatchObject({
      code: "E_STORE_DISCONNECTED",
    });
    expect(store.getState().count).toBe(1);
  });

  it("keeps updates made during init in their own batch while the init callback awaits an action", async () => {
    vi.useFakeTimers();
    const { provider, store } = setup();
    const events: string[] = [];
    let actionResult: number | undefined;
    const initialized = provider.service.subscribe(async (event) => {
      events.push(event.type);
      if (event.type === "init")
        actionResult = await event.actions.increment(1);
    });
    expect(store.getState().count).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    await initialized;
    expect(actionResult).toBe(1);
    expect(events).toEqual(["init", "snapshot"]);
  });

  it("rechecks shared callback ownership after terminal delivery reenters subscribe", async () => {
    vi.useFakeTimers();
    const { provider, store } = setup();
    let fail = true;
    let replacement: Promise<void> | undefined;
    const events: string[] = [];
    const release = vi.fn();
    const callback = Object.assign(
      (event: SyncEnvelope<Data, Actions>) => {
        events.push(event.type);
        if (event.type === "snapshot" && fail)
          throw new Error("delivery failed");
        if (event.type === "terminal" && fail) {
          fail = false;
          replacement = provider.service.subscribe(callback);
        }
      },
      { [RELEASE_PROXY_SYMBOL]: release },
    );
    await provider.service.subscribe(callback);
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(200);
    await replacement;
    expect(events).toEqual(["init", "snapshot", "terminal", "init"]);
    expect(release).not.toHaveBeenCalled();
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(events.at(-1)).toBe("snapshot");
  });

  it("does not release a shared callback again when an older terminal acknowledgement arrives", async () => {
    vi.useFakeTimers();
    const { provider, store } = setup();
    const terminalAck = deferred();
    const release = vi.fn();
    const inits: InitEnvelope<Data, Actions>[] = [];
    let rejectNextSnapshot = true;
    const callback = Object.assign(
      (event: SyncEnvelope<Data, Actions>) => {
        if (event.type === "init") inits.push(event);
        if (event.type === "snapshot" && rejectNextSnapshot) {
          rejectNextSnapshot = false;
          throw new Error("delivery failed");
        }
        if (event.type === "terminal") return terminalAck.promise;
      },
      { [RELEASE_PROXY_SYMBOL]: release },
    );
    await provider.service.subscribe(callback);
    await provider.service.subscribe(callback);
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(release).not.toHaveBeenCalled();
    const action = inits[1].actions.increment(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(await action).toBe(2);
    inits[1].unsubscribe();
    expect(release).toHaveBeenCalledOnce();
    terminalAck.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases a rejected baseline callback without releasing an existing shared subscription", async () => {
    vi.useFakeTimers();
    const store = createStore<Data & Actions>((set, get) => ({
      count: 0,
      increment(by) {
        set({ count: get().count + by });
        return get().count;
      },
    }));
    let invalid = false;
    const binding = bindNexusStore(definition, store, {
      ...options,
      snapshot(state) {
        if (invalid) throw new Error("projection failed");
        return { count: state.count };
      },
    });
    cleanup.push(binding.destroy);
    const shared = Object.assign(vi.fn(), { [RELEASE_PROXY_SYMBOL]: vi.fn() });
    await binding.provider.service.subscribe(shared);
    invalid = true;
    await expect(
      binding.provider.service.subscribe(shared),
    ).rejects.toMatchObject({ code: "E_STORE_PROTOCOL" });
    expect(shared[RELEASE_PROXY_SYMBOL]).not.toHaveBeenCalled();
    const rejected = Object.assign(vi.fn(), {
      [RELEASE_PROXY_SYMBOL]: vi.fn(),
    });
    await expect(
      binding.provider.service.subscribe(rejected),
    ).rejects.toMatchObject({ code: "E_STORE_PROTOCOL" });
    expect(rejected[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
    invalid = false;
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(shared).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "snapshot", state: { count: 1 } }),
    );
  });

  it("preserves Immer and devtools setState overloads while publishing their updates", async () => {
    vi.useFakeTimers();
    const store = createStore<Data & Actions>()(
      devtools(
        immer((set, get) => ({
          count: 0,
          increment(by) {
            set((state) => {
              state.count += by;
            });
            return get().count;
          },
        })),
        { enabled: false },
      ),
    );
    const binding = bindNexusStore(definition, store, options);
    cleanup.push(binding.destroy);
    const events: number[] = [];
    await subscribe(binding.provider.service, (event) => {
      if (event.type === "snapshot") events.push(event.state.count);
    });
    expect(store.getState().increment(2)).toBe(2);
    store.setState(
      (state) => {
        state.count += 3;
      },
      false,
      "counter/increment",
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toEqual([5]);
    expectTypeOf(store.getState().increment).returns.toEqualTypeOf<number>();
  });

  it("does not capture unpublished changes without subscribers and captures once per batch", async () => {
    vi.useFakeTimers();
    const store = createStore<Data & Actions>((set, get) => ({
      count: 0,
      increment(by) {
        set({ count: get().count + by });
        return get().count;
      },
    }));
    const snapshot = vi.fn(options.snapshot);
    const binding = bindNexusStore(definition, store, { ...options, snapshot });
    cleanup.push(binding.destroy);
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(snapshot).not.toHaveBeenCalled();
    await subscribe(binding.provider.service);
    await subscribe(binding.provider.service);
    snapshot.mockClear();
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(100);
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(snapshot).toHaveBeenCalledOnce();
  });

  it("rejects a projection that writes into its source instead of mislabeling a snapshot", async () => {
    const store = createStore<Data & Actions>((set, get) => ({
      count: 0,
      increment(by) {
        set({ count: get().count + by });
        return get().count;
      },
    }));
    const binding = bindNexusStore(definition, store, {
      ...options,
      snapshot(state) {
        store.setState({ count: state.count + 1 });
        return { count: state.count };
      },
    });
    cleanup.push(binding.destroy);
    await expect(
      binding.provider.service.subscribe(vi.fn()),
    ).rejects.toMatchObject({ code: "E_STORE_PROTOCOL" });
  });

  it("retains an action's first batch instead of chasing continuous updates", async () => {
    vi.useFakeTimers();
    const { provider, store } = setup();
    const firstAck = deferred();
    const laterAck = deferred();
    const seen: number[] = [];
    const init = await subscribe(provider.service, (event) => {
      if (event.type !== "snapshot") return;
      seen.push(event.state.count);
      return event.state.count === 1 ? firstAck.promise : laterAck.promise;
    });
    const first = init.actions.increment(1);
    await vi.advanceTimersByTimeAsync(200);
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(200);
    firstAck.resolve();
    expect(await first).toBe(1);
    expect(seen).toEqual([1, 2]);
    laterAck.resolve();
  });

  it("finishes mirror status notifications after reentrant destruction without reviving it", () => {
    const mirror = createRemoteStore<Data, Actions>();
    const changes: string[] = [];
    mirror.onSync({
      type: "init",
      storeInstanceId: "one",
      version: 0,
      state: { count: 0 },
      actions: { increment: async (by: number) => by },
      unsubscribe() {},
    });
    mirror.store.subscribeStatus(() => {
      if (mirror.store.getStatus().type === "ready") mirror.store.destroy();
    });
    mirror.store.subscribe(() => changes.push("state"));
    mirror.store.subscribeStatus(() =>
      changes.push(mirror.store.getStatus().type),
    );
    expect(() =>
      mirror.onSync({
        type: "snapshot",
        storeInstanceId: "one",
        version: 1,
        state: { count: 1 },
      }),
    ).toThrow();
    expect(changes).toEqual(["destroyed"]);
    expect(mirror.store.getStatus().type).toBe("destroyed");
  });

  it("reclaims late init capabilities after the acquiring client timed out", async () => {
    const { provider, store } = setup();
    const started = deferred();
    const resume = deferred();
    const stopped = deferred();
    const callback = vi.fn();
    const service = {
      async subscribe(
        onSync: Parameters<typeof provider.service.subscribe>[0],
      ) {
        started.resolve();
        await resume.promise;
        await provider.service.subscribe((event) => {
          callback(event.type);
          return onSync(
            event.type === "init"
              ? {
                  ...event,
                  unsubscribe() {
                    event.unsubscribe();
                    stopped.resolve();
                  },
                }
              : event,
          );
        });
      },
    };
    const pending = Result.tryPromise({
      try: () =>
        connectNexusStore(
          { create: async <T extends object>() => service as T },
          definition,
          { timeout: 10 },
        ),
      catch: (error) => error,
    });
    await started.promise;
    const failed = await pending;
    expect(failed.isErr()).toBe(true);
    if (failed.isErr())
      expect(failed.error).toMatchObject({ code: "E_STORE_CONNECT" });
    resume.resolve();
    await stopped.promise;
    callback.mockClear();
    store.getState().increment(1);
    expect(callback).not.toHaveBeenCalled();
  });

  it("preserves mutator types through the convenience creator and checks exposed keys", () => {
    const storage = createJSONStorage(() => ({
      getItem: () => null,
      setItem() {},
      removeItem() {},
    }));
    const host = createNexusStore(
      definition,
      subscribeWithSelector(
        persist(
          (set, get) => ({
            count: 0,
            increment(by: number) {
              set({ count: get().count + by });
              return get().count;
            },
          }),
          { name: "counter", storage },
        ),
      ),
      options,
    );
    cleanup.push(host.destroy);
    host.store.subscribe(
      (state) => state.count,
      () => {},
    );
    expectTypeOf(host.store.persist.hasHydrated).toEqualTypeOf<() => boolean>();
    expectTypeOf(
      host.store.getState().increment,
    ).returns.toEqualTypeOf<number>();
    if (false) {
      bindNexusStore(definition, host.store, {
        snapshot: options.snapshot,
        // @ts-expect-error A contract action cannot silently be omitted.
        expose: [],
      });
      bindNexusStore(definition, host.store, {
        snapshot: options.snapshot,
        // @ts-expect-error Unknown capabilities are not part of the contract.
        expose: ["localOnly"],
      });
      bindNexusStore(definition, host.store, {
        ...options,
        // @ts-expect-error Publication limits accept numbers, not coerced strings.
        publishWindowMs: "200",
      });
      bindNexusStore(definition, host.store, {
        ...options,
        // @ts-expect-error The pending budget has the same numeric input contract.
        maxPendingSnapshots: "32",
      });
    }
  });

  it("coalesces real Core clients and only exposes the selected data and actions", async () => {
    const store = createStore(() => ({
      count: 0,
      secret: "private",
      increment(by: number) {
        store.setState((state) => ({ count: state.count + by }));
        return store.getState().count;
      },
      localOnly() {
        return "private";
      },
    }));
    const binding = bindNexusStore(definition, store, {
      ...options,
      publishWindowMs: 25,
    });
    cleanup.push(binding.destroy);
    const network = await createStarNetwork<
      { context: string },
      { from: string }
    >({
      center: {
        meta: { context: "host" },
        providers: { [definition.token.id]: binding.provider.service },
      },
      leaves: ["a", "b"].map((context) => ({
        meta: { context },
        cmConfig: { connectTo: [{ context: "host" }] },
      })),
    });
    const a = await connectNexusStore(network.get("a")!.nexus, definition, {
      target: { context: "host" },
    });
    const b = await connectNexusStore(network.get("b")!.nexus, definition, {
      target: { context: "host" },
    });
    cleanup.push(
      () => a.destroy(),
      () => b.destroy(),
    );
    expect(a.getState()).toEqual({ count: 0 });
    const seen = vi.fn();
    a.subscribe(seen);
    expect(
      await Promise.all([a.actions.increment(1), b.actions.increment(2)]),
    ).toEqual([1, 3]);
    expect(a.getState()).toEqual({ count: 3 });
    expect(b.getState()).toEqual({ count: 3 });
    expect(seen).toHaveBeenCalledOnce();
  });

  it("terminates an overloaded subscriber without stalling its sibling", async () => {
    vi.useFakeTimers();
    const store = createStore<Data & Actions>((set, get) => ({
      count: 0,
      increment(by) {
        set((state) => ({ count: state.count + by }));
        return get().count;
      },
    }));
    const binding = bindNexusStore(definition, store, {
      ...options,
      maxPendingSnapshots: 1,
    });
    cleanup.push(binding.destroy);
    const held = deferred();
    const terminal = vi.fn();
    const slow = await subscribe(binding.provider.service, (event) => {
      if (event.type === "snapshot") return held.promise;
      if (event.type === "terminal") terminal(event);
    });
    const fast = await subscribe(binding.provider.service);
    const first = slow.actions.increment(1).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    const next = fast.actions.increment(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(await next).toBe(2);
    expect(await first).toMatchObject({ code: "E_STORE_DISCONNECTED" });
    expect(terminal).toHaveBeenCalledOnce();
    held.resolve();
  });

  it("preserves snapshot validation errors when a subscriber also has a full delivery budget", async () => {
    vi.useFakeTimers();
    const { store } = setup();
    const binding = bindNexusStore(
      {
        ...definition,
        validation: { state: z.object({ count: z.number().max(1) }) },
      },
      store,
      { ...options, maxPendingSnapshots: 1 },
    );
    cleanup.push(binding.destroy);
    const ack = deferred();
    const snapshots = vi.fn();
    const terminal = vi.fn();
    const init = await subscribe(binding.provider.service, (event) => {
      if (event.type === "terminal") terminal(event.error);
      if (event.type === "snapshot") {
        snapshots(event.state.count);
        return ack.promise;
      }
    });
    const first = Result.tryPromise({
      try: () => init.actions.increment(1),
      catch: (error) => error,
    });
    await vi.advanceTimersByTimeAsync(200);
    const second = Result.tryPromise({
      try: () => init.actions.increment(1),
      catch: (error) => error,
    });
    await vi.advanceTimersByTimeAsync(200);
    const results = await Promise.all([first, second]);
    for (const result of results) {
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({ code: "E_STORE_PROTOCOL" });
        expect(result.error).toBe(terminal.mock.calls[0][0]);
      }
    }
    expect(terminal).toHaveBeenCalledOnce();
    expect(snapshots).toHaveBeenCalledExactlyOnceWith(1);
    ack.resolve();
  });

  it("skips a detached batch entry when an earlier callback unsubscribes it", async () => {
    vi.useFakeTimers();
    const { provider } = setup();
    let stopSibling!: () => void;
    await subscribe(provider.service, (event) => {
      if (event.type === "snapshot") stopSibling();
    });
    const snapshots = vi.fn();
    const sibling = await subscribe(provider.service, (event) => {
      if (event.type === "snapshot") snapshots(event);
    });
    stopSibling = sibling.unsubscribe;
    const result = Result.tryPromise({
      try: () => sibling.actions.increment(1),
      catch: (error) => error,
    });
    await vi.advanceTimersByTimeAsync(200);
    const failed = await result;
    expect(failed.isErr()).toBe(true);
    if (failed.isErr())
      expect(failed.error).toMatchObject({ code: "E_STORE_DISCONNECTED" });
    expect(snapshots).not.toHaveBeenCalled();
  });

  it("does not publish for no-op actions and retrieves replaced actions at invocation", async () => {
    vi.useFakeTimers();
    const { provider, store } = setup();
    const snapshots = vi.fn();
    const init = await subscribe(provider.service, (event) => {
      if (event.type === "snapshot") snapshots(event);
    });
    store.setState({ increment: (by) => by * 2 });
    await vi.advanceTimersByTimeAsync(200);
    snapshots.mockClear();
    expect(await init.actions.increment(3)).toBe(6);
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshots).not.toHaveBeenCalled();
  });

  it("keeps reentrant writes in the next batch and isolates snapshot capture failures", async () => {
    vi.useFakeTimers();
    const { store, provider } = setup();
    const seen: number[] = [];
    await subscribe(provider.service, (event) => {
      if (event.type !== "snapshot") return;
      seen.push(event.state.count);
      if (event.state.count === 1) store.getState().increment(1);
    });
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(seen).toEqual([1]);
    await vi.advanceTimersByTimeAsync(200);
    expect(seen).toEqual([1, 2]);
    const binding = bindNexusStore(
      {
        ...definition,
        validation: { state: z.object({ count: z.number().max(2) }) },
      },
      store,
      options,
    );
    cleanup.push(binding.destroy);
    const remote = createRemoteStore<Data, Actions>();
    cleanup.push(() => remote.store.destroy());
    await binding.provider.service.subscribe(remote.onSync);
    const failed = remote.store.actions
      .increment(1)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    expect(await failed).toMatchObject({ code: "E_STORE_PROTOCOL" });
    expect(store.getState().count).toBe(3);
    expect(remote.store.getStatus().type).toBe("disconnected");
  });

  it("rejects trusted subscriptions delayed past their owner's disconnect", async () => {
    const { provider } = setup();
    const service = provider.service as typeof provider.service & {
      [SERVICE_INVOKE_START](context: { sourceConnectionId: string }): object;
      [SERVICE_ON_DISCONNECT](id: string): void;
    };
    const context = service[SERVICE_INVOKE_START]({
      sourceConnectionId: "gone",
    });
    service[SERVICE_ON_DISCONNECT]("gone");
    const callback = Object.assign(vi.fn(), {
      [RELEASE_PROXY_SYMBOL]: vi.fn(),
    });
    await expect(
      Reflect.apply(service.subscribe, service, [callback, context]),
    ).rejects.toMatchObject({ code: "E_STORE_DISCONNECTED" });
    expect(callback).not.toHaveBeenCalled();
    expect(callback[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
  });

  it("stops a listener after a failed init acknowledgement", async () => {
    vi.useFakeTimers();
    const { provider, store } = setup();
    const callback = Object.assign(
      vi.fn(async () => {
        throw new Error("init rejected");
      }),
      { [RELEASE_PROXY_SYMBOL]: vi.fn() },
    );
    await expect(provider.service.subscribe(callback)).rejects.toMatchObject({
      code: "E_STORE_DISCONNECTED",
    });
    await vi.advanceTimersByTimeAsync(0);
    callback.mockClear();
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(callback).not.toHaveBeenCalled();
    expect(callback[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
  });

  it("preserves the original store and synchronous actions", () => {
    const { store, destroy } = setup();
    const initial = store.getState();
    expect(store.getState()).toBe(initial);
    expect(store.getState().increment(1)).toBe(1);
    destroy();
    expect(store.getState().increment(1)).toBe(2);
    expect(store.getInitialState()).toBe(initial);
  });

  it("coalesces separate tasks without postponing the first 200ms deadline", async () => {
    vi.useFakeTimers();
    const { store, provider } = setup();
    const snapshots: number[] = [];
    const init = await subscribe(provider.service, (event) => {
      if (event.type === "snapshot") snapshots.push(event.state.count);
    });
    const completed = vi.fn();
    const first = init.actions.increment(1).then(completed);
    await vi.advanceTimersByTimeAsync(150);
    const second = init.actions.increment(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().count).toBe(3);
    await vi.advanceTimersByTimeAsync(49);
    expect(snapshots).toEqual([]);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(snapshots).toEqual([3]);
    expect(completed).toHaveBeenCalledWith(1);
  });

  it("does not serialize async actions or roll back completed Zustand sets", async () => {
    const started = deferred();
    const release = deferred();
    const contract = {
      token: new Token<
        NexusStoreServiceContract<
          Data,
          { slow(): Promise<void>; fast(): void; fail(): void }
        >
      >("state:interleaving"),
    };
    const { store, destroy } = createNexusStore(
      contract,
      (set) => ({
        count: 0,
        async slow() {
          set({ count: 1 });
          started.resolve();
          await release.promise;
          set({ count: 3 });
        },
        fast() {
          set({ count: 2 });
        },
        fail() {
          set({ count: 4 });
          throw new Error("failed");
        },
      }),
      {
        snapshot: ({ count }) => ({ count }),
        expose: ["slow", "fast", "fail"],
      },
    );
    cleanup.push(destroy);
    const slow = store.getState().slow();
    await started.promise;
    expect(store.getState().count).toBe(1);
    store.getState().fast();
    expect(store.getState().count).toBe(2);
    release.resolve();
    await slow;
    expect(() => store.getState().fail()).toThrow("failed");
    expect(store.getState().count).toBe(4);
  });

  it("captures each caller's batch while slow siblings and newer batches proceed", async () => {
    vi.useFakeTimers();
    const { provider } = setup();
    const ack = deferred();
    const completed = vi.fn();
    const slow = await subscribe(provider.service, (event) =>
      event.type === "snapshot" ? ack.promise : undefined,
    );
    const fast = await subscribe(provider.service);
    const first = slow.actions.increment(1).then(completed);
    await vi.advanceTimersByTimeAsync(200);
    const second = fast.actions.increment(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(await second).toBe(2);
    expect(completed).not.toHaveBeenCalled();
    ack.resolve();
    await first;
    expect(completed).toHaveBeenCalledWith(1);
  });

  it("allows callback action reentry across publication windows", async () => {
    vi.useFakeTimers();
    const { store, provider } = setup();
    const init = await subscribe(provider.service, (event) => {
      if (event.type === "snapshot" && event.state.count === 1)
        return init.actions.increment(1);
    });
    const call = init.actions.increment(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(await call).toBe(1);
    expect(store.getState().count).toBe(2);
  });

  it("initializes immediately during a window and does not regress the mirror", async () => {
    vi.useFakeTimers();
    const { store, provider } = setup();
    await subscribe(provider.service);
    store.getState().increment(1);
    const remote = createRemoteStore<Data, Actions>();
    cleanup.push(() => remote.store.destroy());
    await provider.service.subscribe(remote.onSync);
    expect(remote.store.getState()).toEqual({ count: 1 });
    const snapshot = remote.store.getState();
    await vi.advanceTimersByTimeAsync(200);
    expect(remote.store.getState()).toBe(snapshot);
    remote.onSync({
      type: "snapshot",
      storeInstanceId: (remote.store.getStatus() as { storeInstanceId: string })
        .storeInstanceId,
      version: 0,
      state: { count: 0 },
    });
    expect(remote.store.getState()).toBe(snapshot);
  });

  it("rejects waiting calls on destroy without destroying the source store", async () => {
    vi.useFakeTimers();
    const { store, provider, destroy } = setup();
    const init = await subscribe(provider.service);
    const rejected = init.actions.increment(1).catch((error: unknown) => error);
    await Promise.resolve();
    destroy();
    expect(await rejected).toMatchObject({ code: "E_STORE_DISCONNECTED" });
    expect(store.getState().increment(1)).toBe(2);
    await vi.advanceTimersByTimeAsync(400);
  });

  it("rejects pending and in-flight batches on unsubscribe without waiting for their callbacks", async () => {
    vi.useFakeTimers();
    const { provider, store } = setup();
    const acknowledgements = [deferred(), deferred()];
    let snapshots = 0;
    const init = await subscribe(provider.service, (event) => {
      if (event.type === "snapshot")
        return acknowledgements[snapshots++].promise;
    });
    const first = Result.tryPromise({
      try: () => init.actions.increment(1),
      catch: (error) => error,
    });
    await vi.advanceTimersByTimeAsync(200);
    const second = Result.tryPromise({
      try: () => init.actions.increment(1),
      catch: (error) => error,
    });
    await vi.advanceTimersByTimeAsync(200);
    const pending = Result.tryPromise({
      try: () => init.actions.increment(1),
      catch: (error) => error,
    });
    init.unsubscribe();
    for (const result of await Promise.all([first, second, pending])) {
      expect(result.isErr()).toBe(true);
      if (result.isErr())
        expect(result.error).toMatchObject({ code: "E_STORE_DISCONNECTED" });
    }
    acknowledgements.forEach((ack) => ack.resolve());
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(snapshots).toBe(2);
  });

  it("rejects a held init immediately on destroy and ignores its late acknowledgement", async () => {
    vi.useFakeTimers();
    const { provider, destroy } = setup();
    const ack = deferred();
    const release = vi.fn();
    const callback = Object.assign(
      (event: SyncEnvelope<Data, Actions>) => {
        if (event.type === "init") return ack.promise;
      },
      { [RELEASE_PROXY_SYMBOL]: release },
    );
    const initialized = Result.tryPromise({
      try: () => provider.service.subscribe(callback),
      catch: (error) => error,
    });
    destroy();
    const result = await initialized;
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toMatchObject({ code: "E_STORE_DISCONNECTED" });
    ack.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves middleware APIs and publishes hydration like any other update", async () => {
    vi.useFakeTimers();
    const loaded = deferred<string | null>();
    const storage = {
      getItem: () => loaded.promise,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const store = createStore<Data & Actions>()(
      subscribeWithSelector(
        persist(
          (set, get) => ({
            count: 0,
            increment(by) {
              set({ count: get().count + by });
              return get().count;
            },
          }),
          {
            name: "counter",
            storage: createJSONStorage(() => storage),
            skipHydration: true,
          },
        ),
      ),
    );
    const binding = bindNexusStore(definition, store, options);
    cleanup.push(binding.destroy);
    const selected = vi.fn();
    store.subscribe((state) => state.count, selected);
    const events: number[] = [];
    await subscribe(binding.provider.service, (event) => {
      if (event.type === "snapshot") events.push(event.state.count);
    });
    const hydration = store.persist.rehydrate();
    loaded.resolve(JSON.stringify({ state: { count: 10 }, version: 0 }));
    await hydration;
    expect(store.persist.hasHydrated()).toBe(true);
    expect(selected).toHaveBeenCalledWith(10, 0);
    await vi.advanceTimersByTimeAsync(200);
    expect(events).toEqual([10]);
    expectTypeOf(store.persist.hasHydrated()).toEqualTypeOf<boolean>();
  });

  it("validates snapshots without applying state transforms or mutating the source", async () => {
    const store = createStore<Data & Actions>(() => ({
      count: 1,
      increment: (by) => by,
    }));
    const validation = {
      state: z
        .object({ count: z.number() })
        .transform(({ count }) => ({ count: count + 1 })),
    };
    const binding = bindNexusStore(
      { ...definition, validation },
      store,
      options,
    );
    cleanup.push(binding.destroy);
    const remote = createRemoteStore<Data, Actions>(validation);
    cleanup.push(() => remote.store.destroy());
    await binding.provider.service.subscribe(remote.onSync);
    expect(store.getState().count).toBe(1);
    expect(remote.store.getState().count).toBe(1);
  });

  it("stops only the last owner of a shared callback and isolates snapshot mutations", async () => {
    vi.useFakeTimers();
    const { store, provider } = setup();
    const release = vi.fn();
    const inits: InitEnvelope<Data, Actions>[] = [];
    const callback = Object.assign(
      (event: SyncEnvelope<Data, Actions>) => {
        if (event.type === "init") inits.push(event);
        else if (event.type === "snapshot") event.state.count = 99;
      },
      { [RELEASE_PROXY_SYMBOL]: release },
    );
    await provider.service.subscribe(callback);
    await provider.service.subscribe(callback);
    const seen = vi.fn();
    await subscribe(provider.service, seen);
    inits[0].unsubscribe();
    expect(release).not.toHaveBeenCalled();
    store.getState().increment(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(store.getState().count).toBe(1);
    expect(seen).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "snapshot", state: { count: 1 } }),
    );
    inits[1].unsubscribe();
    expect(release).toHaveBeenCalledOnce();
  });
});
