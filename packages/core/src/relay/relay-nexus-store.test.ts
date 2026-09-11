import { describe, expect, it, vi } from "vitest";
import { Token } from "@/api/token";
import { Result } from "better-result";
import {
  SERVICE_INVOKE_START,
  SERVICE_ON_DISCONNECT,
  type ServiceInvocationContext,
} from "@/service/service-invocation-hooks";
import { NexusStoreDisconnectedError } from "@/state/errors";
import type { SyncEnvelope } from "@/state/protocol";
import type {
  NexusStoreServiceContract,
  RemoteActions,
} from "@/state/contract";
import {
  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
  RELEASE_PROXY_SYMBOL,
} from "@/types/symbols";
import { relayNexusStore } from "./index";
import { createNexusStore } from "@/state/bind-store";
import { createRemoteStore } from "@/state/remote-store";

type State = { count: number };
type Actions = { increment(by: number): number };
type Event = SyncEnvelope<State, Actions>;

const definition = {
  token: new Token<NexusStoreServiceContract<State, Actions>>(
    "relay:test-store",
  ),
};

const context = (connectionId: string): ServiceInvocationContext => ({
  sourceConnectionId: connectionId,
  sourceIdentity: { context: connectionId },
  localIdentity: { context: "relay" },
  platform: { from: connectionId },
});

const makeUpstream = (
  options: {
    onDisconnect?: (callback: () => void) => void;
    onStale?: (callback: () => void) => void;
    initialCount?: number;
  } = {},
) => {
  let count = options.initialCount ?? 0;
  let version = 0;
  const subscribers = new Set<(event: Event) => void | Promise<void>>();
  const actions: RemoteActions<Actions> = {
    increment: async (by) => {
      count += by;
      version += 1;
      const event: Event = {
        type: "snapshot",
        storeInstanceId: "upstream",
        version,
        state: { count },
      };
      await Promise.all([...subscribers].map((listener) => listener(event)));
      return count;
    },
  };
  const service = {
    async subscribe(listener: (event: Event) => void | Promise<void>) {
      subscribers.add(listener);
      await listener({
        type: "init",
        storeInstanceId: "upstream",
        version,
        state: { count },
        actions,
        unsubscribe: () => {
          subscribers.delete(listener);
        },
      });
    },
    [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: options.onDisconnect,
    [NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL]: options.onStale,
  } as unknown as NexusStoreServiceContract<State, Actions> & {
    [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]?: (
      callback: () => void,
    ) => void;
    [NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL]?: (
      callback: () => void,
    ) => void;
  };
  return { service, actions };
};

const createRelay = (
  upstream: ReturnType<typeof makeUpstream>,
  policy?: { canSubscribe?: () => boolean; canDispatch?: () => boolean },
) =>
  relayNexusStore(definition, {
    forwardThrough: {
      create: vi.fn(async () => upstream.service),
    } as any,
    forwardTarget: { context: "background" },
    policy,
  });

const initOf = (events: Event[]) => {
  const init = events.find((event) => event.type === "init");
  if (!init || init.type !== "init") throw new Error("Missing init");
  return init;
};

const subscribeRelay = (
  service: NexusStoreServiceContract<State, Actions>,
  listener: (event: Event) => unknown,
  caller: ServiceInvocationContext,
) => {
  (service as any)[SERVICE_INVOKE_START](caller);
  return Reflect.apply(service.subscribe, service, [listener, caller]);
};

describe("relayNexusStore", () => {
  it("rejects an old invocation after its connection ID is reused", async () => {
    const upstream = makeUpstream();
    const relay = createRelay(upstream);
    const old = context("reused");
    const start = (relay.service as any)[SERVICE_INVOKE_START];
    start(old);
    (relay.service as any)[SERVICE_ON_DISCONNECT]("reused");
    const current = context("reused");
    start(current);
    await expect(
      Reflect.apply(relay.service.subscribe, relay.service, [vi.fn(), old]),
    ).rejects.toMatchObject({ code: "E_STORE_DISCONNECTED" });
    const events: Event[] = [];
    await Reflect.apply(relay.service.subscribe, relay.service, [
      (event: Event) => {
        events.push(event);
      },
      current,
    ]);
    await expect(initOf(events).actions.increment(1)).resolves.toBe(1);
    initOf(events).unsubscribe();
  });

  it("does not forward an action after its asynchronous policy outlives the owner", async () => {
    let allow!: (value: boolean) => void;
    const policy = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const upstream = makeUpstream();
    const invoke = vi.spyOn(upstream.actions, "increment");
    const relay = relayNexusStore(definition, {
      forwardThrough: { create: async () => upstream.service } as any,
      forwardTarget: { context: "background" },
      policy: { canDispatch: () => policy },
    });
    const events: Event[] = [];
    await subscribeRelay(
      relay.service,
      (event) => events.push(event),
      context("one"),
    );
    const pending = Result.tryPromise({
      try: () => initOf(events).actions.increment(1),
      catch: (error) => error,
    });
    (relay.service as any)[SERVICE_ON_DISCONNECT]("one");
    allow(true);
    const result = await pending;
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toMatchObject({ code: "E_STORE_DISCONNECTED" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not subscribe upstream after acquisition outlives the downstream owner", async () => {
    let acquired!: (
      service: ReturnType<typeof makeUpstream>["service"],
    ) => void;
    let started!: () => void;
    const acquiring = new Promise<void>((resolve) => {
      started = resolve;
    });
    const acquisition = new Promise<ReturnType<typeof makeUpstream>["service"]>(
      (resolve) => {
        acquired = resolve;
      },
    );
    const upstream = makeUpstream();
    const subscribe = vi.spyOn(upstream.service, "subscribe");
    const relay = relayNexusStore(definition, {
      forwardThrough: {
        create: () => {
          started();
          return acquisition;
        },
      } as any,
      forwardTarget: { context: "background" },
    });
    const pending = Result.tryPromise({
      try: () => subscribeRelay(relay.service, vi.fn(), context("one")),
      catch: (error) => error,
    });
    await acquiring;
    (relay.service as any)[SERVICE_ON_DISCONNECT]("one");
    acquired(upstream.service);
    const result = await pending;
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toMatchObject({ code: "E_STORE_DISCONNECTED" });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("removes a failed init listener while keeping a sibling subscription usable", async () => {
    const { provider, destroy } = createNexusStore(
      definition,
      (set, get) => ({
        count: 0,
        increment(by) {
          set({ count: get().count + by });
          return get().count;
        },
      }),
      {
        snapshot: (state) => ({ count: state.count }),
        expose: ["increment"],
      },
    );
    const relay = relayNexusStore(definition, {
      forwardThrough: { create: async () => provider.service } as any,
      forwardTarget: { context: "background" },
    });
    const failed = Object.assign(
      vi.fn(async () => {
        throw new Error("init delivery failed");
      }),
      { [RELEASE_PROXY_SYMBOL]: vi.fn() },
    );
    await expect(
      subscribeRelay(relay.service, failed, context("failed")),
    ).rejects.toMatchObject({ code: "E_RELAY_UPSTREAM_FAILURE" });
    const events: Event[] = [];
    await subscribeRelay(
      relay.service,
      (event) => events.push(event),
      context("sibling"),
    );
    await expect(initOf(events).actions.increment(1)).resolves.toBe(1);
    expect(failed).toHaveBeenCalledOnce();
    expect(failed[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
    initOf(events).unsubscribe();
    destroy();
  });

  it("deduplicates snapshots, isolates downstream state, and rejects version regression", async () => {
    let receive!: (event: Event) => void | Promise<void>;
    const upstream = makeUpstream();
    const service = {
      async subscribe(callback: typeof receive) {
        receive = callback;
        await upstream.service.subscribe(callback);
      },
    };
    const relay = relayNexusStore(definition, {
      forwardThrough: { create: async () => service } as any,
      forwardTarget: { context: "background" },
    });
    const events: Event[] = [];
    await subscribeRelay(
      relay.service,
      (event) => {
        events.push(event);
        if (event.type === "snapshot") event.state.count = 99;
      },
      context("one"),
    );
    const snapshot: Event = {
      type: "snapshot",
      storeInstanceId: "upstream",
      version: 2,
      state: { count: 2 },
    };
    await receive(snapshot);
    await receive(snapshot);
    expect(snapshot.state.count).toBe(2);
    expect(events.filter((event) => event.type === "snapshot")).toHaveLength(1);
    await expect(receive({ ...snapshot, version: 1 })).resolves.toBeUndefined();
    expect(events.filter((event) => event.type === "terminal")).toHaveLength(0);
  });

  it("preserves early snapshots and overlapping upstream baselines", async () => {
    const callbacks: Array<(event: Event) => void | Promise<void>> = [];
    const upstream = {
      async subscribe(callback: (event: Event) => void | Promise<void>) {
        callbacks.push(callback);
      },
    };
    const relay = relayNexusStore(definition, {
      forwardThrough: { create: async () => upstream } as any,
      forwardTarget: { context: "background" },
    });
    // Hold both subscribe replies until their independently delivered init callbacks.
    let completeFirst!: () => void;
    let completeSecond!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      completeFirst = resolve;
    });
    const secondReady = new Promise<void>((resolve) => {
      completeSecond = resolve;
    });
    upstream.subscribe = async (callback) => {
      callbacks.push(callback);
      await (callbacks.length === 1 ? firstReady : secondReady);
    };
    const first: Event[] = [];
    const second: Event[] = [];
    const mirror = createRemoteStore<State, Actions>();
    const firstPending = subscribeRelay(
      relay.service,
      (event) => {
        first.push(event);
        mirror.onSync(event);
      },
      context("first"),
    );
    const secondPending = subscribeRelay(
      relay.service,
      (event) => second.push(event),
      context("second"),
    );
    const pending = Result.tryPromise({
      try: () => Promise.all([firstPending, secondPending]),
      catch: (error) => error,
    });
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    const init = (version: number): Event => ({
      type: "init",
      storeInstanceId: "one",
      version,
      state: { count: version },
      actions: { increment: async (by) => by },
      unsubscribe: vi.fn(),
    });
    try {
      await callbacks[0]({
        type: "snapshot",
        storeInstanceId: "one",
        version: 6,
        state: { count: 6 },
      });
      await callbacks[1](init(6));
      await callbacks[0](init(5));
      expect(mirror.store.getState()).toEqual({ count: 6 });
      expect(initOf(first).version).toBeGreaterThanOrEqual(0);
      expect(mirror.store.getStatus()).toMatchObject({
        type: "ready",
        version: initOf(second).version,
      });
    } finally {
      completeFirst();
      completeSecond();
      await pending;
      mirror.store.destroy();
      for (const events of [first, second])
        events.find((event) => event.type === "init")?.unsubscribe();
    }
  });

  it("closes the downstream and releases capabilities on a malformed live event", async () => {
    let receive!: (event: unknown) => void | Promise<void>;
    const unsubscribe = Object.assign(vi.fn(), {
      [RELEASE_PROXY_SYMBOL]: vi.fn(),
    });
    const increment = Object.assign(
      vi.fn(async (by: number) => by),
      { [RELEASE_PROXY_SYMBOL]: vi.fn() },
    );
    const stopObserver = vi.fn();
    const upstream = {
      async subscribe(callback: typeof receive) {
        receive = callback;
        await callback({
          type: "init",
          storeInstanceId: "one",
          version: 0,
          state: { count: 0 },
          actions: { increment },
          unsubscribe,
        });
      },
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: () => stopObserver,
    };
    const relay = relayNexusStore(definition, {
      forwardThrough: { create: async () => upstream } as any,
      forwardTarget: { context: "background" },
    });
    const events: Event[] = [];
    await subscribeRelay(
      relay.service,
      (event) => events.push(event),
      context("one"),
    );
    await expect(
      receive({
        get type() {
          throw new Error("invalid getter");
        },
      }),
    ).rejects.toMatchObject({ code: "E_STORE_PROTOCOL" });
    expect(events.at(-1)).toMatchObject({ type: "terminal" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(unsubscribe[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
    expect(increment[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
    expect(stopObserver).toHaveBeenCalledOnce();
    await expect(initOf(events).actions.increment(1)).rejects.toMatchObject({
      code: "E_STORE_DISCONNECTED",
    });
    expect(increment).not.toHaveBeenCalled();
  });

  it("rechecks owner liveness after asynchronous subscription authorization", async () => {
    let allow!: (allowed: boolean) => void;
    const policy = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const create = vi.fn();
    const relay = relayNexusStore(definition, {
      forwardThrough: { create } as any,
      forwardTarget: { context: "background" },
      policy: { canSubscribe: () => policy },
    });
    const pending = subscribeRelay(relay.service, vi.fn(), context("gone"));
    const rejected = Result.tryPromise({
      try: () => pending,
      catch: (error) => error,
    });
    (relay.service as any)[SERVICE_ON_DISCONNECT]("gone");
    allow(true);
    const result = await rejected;
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toMatchObject({ code: "E_STORE_DISCONNECTED" });
    expect(create).not.toHaveBeenCalled();
  });

  it("reclaims late upstream capabilities and lifecycle observers after downstream disconnect", async () => {
    let deliver!: () => Promise<void>;
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const stopObserver = vi.fn();
    const unsubscribe = Object.assign(vi.fn(), {
      [RELEASE_PROXY_SYMBOL]: vi.fn(),
    });
    const increment = Object.assign(vi.fn(), {
      [RELEASE_PROXY_SYMBOL]: vi.fn(),
    });
    const upstream = {
      subscribe: async (onSync: (event: Event) => Promise<void>) => {
        await new Promise<void>((resolve, reject) => {
          deliver = async () => {
            try {
              await onSync({
                type: "init",
                storeInstanceId: "one",
                version: 0,
                state: { count: 0 },
                actions: { increment },
                unsubscribe,
              });
              resolve();
            } catch (error) {
              reject(error);
            }
          };
          ready();
        });
      },
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: () => stopObserver,
    };
    const relay = relayNexusStore(definition, {
      forwardThrough: { create: async () => upstream } as any,
      forwardTarget: { context: "background" },
    });
    const downstream = vi.fn();
    const pending = subscribeRelay(relay.service, downstream, context("gone"));
    const rejected = Result.tryPromise({
      try: () => pending,
      catch: (error) => error,
    });
    await registered;
    (relay.service as any)[SERVICE_ON_DISCONNECT]("gone");
    await deliver();
    const result = await rejected;
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toMatchObject({ code: "E_RELAY_UPSTREAM_FAILURE" });
    expect(downstream).not.toHaveBeenCalled();
    expect(stopObserver).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(unsubscribe[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
    expect(increment[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
  });

  it("rejects a revoked action without calling upstream and permits later allowed calls", async () => {
    let allowed = false;
    const upstream = makeUpstream();
    const relay = createRelay(upstream, { canDispatch: () => allowed });
    const events: Event[] = [];
    await subscribeRelay(
      relay.service,
      (event) => events.push(event),
      context("one"),
    );
    const init = initOf(events);
    await expect(init.actions.increment(1)).rejects.toMatchObject({
      code: "E_RELAY_POLICY_DENIED",
    });
    expect(events.filter((event) => event.type === "snapshot")).toHaveLength(0);
    allowed = true;
    await expect(init.actions.increment(1)).resolves.toBe(1);
    init.unsubscribe();
  });

  it("does not make one caller wait for a slow sibling's callback", async () => {
    const { provider, destroy } = createNexusStore(
      definition,
      (set, get) => ({
        count: 0,
        increment(by) {
          set({ count: get().count + by });
          return get().count;
        },
      }),
      {
        snapshot: (state) => ({ count: state.count }),
        expose: ["increment"],
      },
    );
    const relay = relayNexusStore(definition, {
      forwardThrough: { create: async () => provider.service } as any,
      forwardTarget: { context: "background" },
    });
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: Event[] = [];
    const slowEvents: Event[] = [];
    await subscribeRelay(
      relay.service,
      (event) => {
        slowEvents.push(event);
        if (event.type === "snapshot") return slow;
      },
      context("slow"),
    );
    await subscribeRelay(
      relay.service,
      (event) => {
        events.push(event);
      },
      context("fast"),
    );
    try {
      const completed = initOf(events).actions.increment(1);
      await expect(completed).resolves.toBe(1);
      expect(events.at(-1)).toMatchObject({
        type: "snapshot",
        state: { count: 1 },
      });
    } finally {
      release();
      initOf(events).unsubscribe();
      initOf(slowEvents).unsubscribe();
      destroy();
    }
  });

  it("forwards init actions and waits for the calling subscriber's snapshot", async () => {
    const upstream = makeUpstream();
    const relay = createRelay(upstream);
    const events: Event[] = [];
    await subscribeRelay(
      relay.service,
      (event) => events.push(event),
      context("alpha"),
    );
    const init = initOf(events);
    events.length = 0;

    await expect(init.actions.increment(1)).resolves.toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "snapshot", state: { count: 1 } }),
    );
    init.unsubscribe();
  });

  it("fans out snapshots and removes only the disconnected owner", async () => {
    const upstream = makeUpstream();
    const relay = createRelay(upstream);
    const alpha: Event[] = [];
    const beta: Event[] = [];
    await subscribeRelay(
      relay.service,
      (event) => alpha.push(event),
      context("alpha"),
    );
    await subscribeRelay(
      relay.service,
      (event) => beta.push(event),
      context("beta"),
    );

    (relay.service as any)[SERVICE_ON_DISCONNECT]("alpha");
    await upstream.actions.increment(1);

    expect(alpha.filter((event) => event.type === "snapshot")).toHaveLength(0);
    expect(beta).toContainEqual(
      expect.objectContaining({ type: "snapshot", state: { count: 1 } }),
    );
  });

  it("checks subscription and action policy using the trusted context", async () => {
    const deniedSubscribe = createRelay(makeUpstream(), {
      canSubscribe: () => false,
    });
    await expect(
      subscribeRelay(deniedSubscribe.service, vi.fn(), context("denied")),
    ).rejects.toMatchObject({ code: "E_RELAY_POLICY_DENIED" });

    const deniedDispatch = createRelay(makeUpstream(), {
      canDispatch: () => false,
    });
    const events: Event[] = [];
    await subscribeRelay(
      deniedDispatch.service,
      (event) => events.push(event),
      context("alpha"),
    );
    const init = initOf(events);
    await expect(init.actions.increment(1)).rejects.toMatchObject({
      code: "E_RELAY_POLICY_DENIED",
    });
  });

  it.each([
    ["disconnect", "source-disconnected"],
    ["stale", "target-changed"],
  ] as const)(
    "terminalizes subscribers on upstream %s",
    async (kind, reason) => {
      let notify!: () => void;
      const upstream = makeUpstream(
        kind === "disconnect"
          ? { onDisconnect: (callback) => (notify = callback) }
          : { onStale: (callback) => (notify = callback) },
      );
      const relay = createRelay(upstream);
      const events: Event[] = [];
      await subscribeRelay(
        relay.service,
        (event) => events.push(event),
        context("alpha"),
      );
      notify();

      expect(events).toContainEqual(
        expect.objectContaining({ type: "terminal", reason }),
      );
      const init = initOf(events);
      await expect(init.actions.increment(1)).rejects.toBeInstanceOf(
        NexusStoreDisconnectedError,
      );
    },
  );

  it("terminalizes subscribers when upstream store identity changes", async () => {
    let listener!: (event: Event) => void | Promise<void>;
    const upstream = makeUpstream();
    const relay = relayNexusStore(definition, {
      forwardThrough: {
        create: vi.fn(async () => ({
          async subscribe(callback: typeof listener) {
            listener = callback;
            await callback({
              type: "init",
              storeInstanceId: "one",
              version: 0,
              state: { count: 0 },
              actions: upstream.actions,
              unsubscribe: () => undefined,
            } as Event);
          },
        })),
      } as any,
      forwardTarget: { context: "background" },
    });
    const events: Event[] = [];
    await subscribeRelay(
      relay.service,
      (event) => events.push(event),
      context("alpha"),
    );
    await expect(
      listener({
        type: "snapshot",
        storeInstanceId: "two",
        version: 1,
        state: { count: 1 },
      }),
    ).rejects.toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "terminal", reason: "target-replaced" }),
    );
  });
});
