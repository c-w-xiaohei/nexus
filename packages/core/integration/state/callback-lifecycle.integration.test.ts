import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { RELEASE_PROXY_SYMBOL } from "../../src/types/symbols";
import { createStarNetwork } from "../../src/utils/test-utils";
import { createNexusStore } from "../../src/state/bind-store";
import { createStoreToken } from "../../src/state/contract";
import { connectNexusStore } from "../../src/state/connect-store";
import { createRemoteStore } from "../../src/state/remote-store";
import {
  SERVICE_INVOKE_START,
  SERVICE_INVOKE_END,
  SERVICE_ON_DISCONNECT,
  type ServiceInvocationHooks,
} from "../../src/service/service-invocation-hooks";
import { z } from "zod";
import type {
  NexusStoreServiceContract,
  StoreData,
} from "../../src/state/contract";
import type { InitEnvelope, SyncEnvelope } from "../../src/state/protocol";

type Data = { count: number; nested: { value: number } };
type Actions = { add(by: number): number; fail(): void };
const token = createStoreToken<Data & Actions>("state:clean");
const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

const createHost = () => {
  const host = createNexusStore(
    token,
    (set, get) => ({
      count: 0,
      nested: { value: 0 },
      add(by) {
        set({ count: get().count + by });
        return get().count;
      },
      fail() {
        set({ count: 99 });
        get().nested.value = 99;
        throw new Error("rollback");
      },
    }),
    {
      snapshot: ({ count, nested }) => ({ count, nested }),
      expose: ["add", "fail"],
      publishWindowMs: 0,
    },
  );
  disposals.push(() => host.destroy());
  return host;
};

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function subscribe<Store extends object>(
  service: NexusStoreServiceContract<Store>,
  onSync: (event: SyncEnvelope<StoreData<Store>, Store>) => unknown = () =>
    undefined,
): Promise<InitEnvelope<StoreData<Store>, Store>> {
  let initial!: InitEnvelope<StoreData<Store>, Store>;
  await service.subscribe(async (event) => {
    if (event.type === "init") initial = event;
    await onSync(event);
  });
  return initial;
}

describe("State callback lifecycle across host and mirror", () => {
  it("publishes an unchanged snapshot for an action with no state delta", async () => {
    const { provider } = createHost();
    const snapshot = vi.fn();
    const init = await subscribe(provider.service, (event) => {
      if (event.type === "snapshot") snapshot(event);
    });
    await expect(init.actions.add(0)).resolves.toBe(0);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        state: { count: 0, nested: { value: 0 } },
      }),
    );
    init.unsubscribe();
  });

  it("validates action results without applying schema transforms", async () => {
    const { provider, store, destroy } = createNexusStore(
      createStoreToken<{ count: number } & { add(by: number): string }>(
        "state:result-validation",
        {
          validation: {
            actionResults: {
              add: z
                .string()
                .min(2)
                .transform((value) => value.toUpperCase()),
            },
          },
        },
      ),
      (set, get) => ({
        count: 0,
        add(by) {
          set({ count: get().count + by });
          return by === 1 ? "x" : "ok";
        },
      }),
      { snapshot: ({ count }) => ({ count }), expose: ["add"] },
    );
    disposals.push(destroy);
    expect(store.getState().add(1)).toBe("x");
    expect(store.getState().count).toBe(1);
    const init = await subscribe(provider.service);
    await expect(init.actions.add(1)).rejects.toMatchObject({
      code: "E_STORE_PROTOCOL",
    });
    await expect(init.actions.add(2)).resolves.toBe("ok");
    expect(store.getState().count).toBe(4);
    init.unsubscribe();
  });

  it("lets an early terminal win over init and reclaims late capabilities", () => {
    const remote = createRemoteStore<Data & Actions>();
    const unsubscribe = Object.assign(vi.fn(), {
      [RELEASE_PROXY_SYMBOL]: vi.fn(),
    });
    const add = Object.assign(vi.fn(), { [RELEASE_PROXY_SYMBOL]: vi.fn() });
    const snapshot = vi.fn();
    remote.store.subscribe(snapshot);
    remote.onSync({
      type: "terminal",
      storeInstanceId: "one",
      lastKnownVersion: 3,
      reason: "provider-shutdown",
    });
    expect(() =>
      remote.onSync({
        type: "init",
        storeInstanceId: "one",
        version: 0,
        state: { count: 0, nested: { value: 0 } },
        actions: { add },
        unsubscribe,
      }),
    ).toThrowError(expect.objectContaining({ code: "E_STORE_DISCONNECTED" }));
    expect(remote.store.getStatus()).toMatchObject({
      type: "disconnected",
      lastKnownVersion: 3,
    });
    expect(snapshot).not.toHaveBeenCalled();
    remote.store.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(unsubscribe[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
    expect(add[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
  });

  it("terminalizes malformed event getters and releases the active subscription", () => {
    const client = createRemoteStore<Data & Actions>();
    const unsubscribe = vi.fn();
    client.onSync({
      type: "init",
      storeInstanceId: "one",
      version: 0,
      state: { count: 0, nested: { value: 0 } },
      actions: {},
      unsubscribe,
    });
    expect(() =>
      client.onSync({
        get type() {
          throw new Error("invalid getter");
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "E_STORE_PROTOCOL" }));
    expect(client.store.getStatus().type).toBe("disconnected");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects init delivery and removes the host listener when baseline validation fails", async () => {
    const { provider, store } = createHost();
    const callback = vi.fn();
    const client = createRemoteStore<Data & Actions>({
      state: z.object({
        count: z.number().min(1),
        nested: z.object({ value: z.number() }),
      }),
    });
    await expect(
      provider.service.subscribe((event) => {
        callback(event);
        client.onSync(event);
      }),
    ).rejects.toMatchObject({ code: "E_STORE_DISCONNECTED" });
    callback.mockClear();
    expect(store.getState().add(1)).toBe(1);
    expect(callback).not.toHaveBeenCalled();
    expect(client.store.getStatus().type).toBe("disconnected");
    client.store.destroy();
  });

  it("rejects a pending action on host destroy while retaining local writes", async () => {
    const started = deferred();
    const complete = deferred();
    const { store, destroy } = createNexusStore(
      createStoreToken<{ count: number } & { delayed(): Promise<void> }>(
        "state:destroy-draft",
      ),
      (set) => ({
        count: 0,
        async delayed() {
          set({ count: 1 });
          started.resolve();
          await complete.promise;
        },
      }),
      { snapshot: ({ count }) => ({ count }), expose: ["delayed"] },
    );
    const pending = store.getState().delayed();
    const rejected = pending.catch((error) => error);
    await started.promise;
    destroy();
    complete.resolve();
    expect(await rejected).toBeUndefined();
    expect(store.getState().count).toBe(1);
  });

  it("keeps status and snapshot notifications consistent when a listener destroys the mirror", () => {
    const client = createRemoteStore<Data & Actions>();
    const unsubscribe = vi.fn();
    client.onSync({
      type: "init",
      storeInstanceId: "one",
      version: 0,
      state: { count: 0, nested: { value: 0 } },
      actions: {},
      unsubscribe,
    });
    const observed: string[] = [];
    client.store.subscribe(() => {
      observed.push("snapshot");
      client.store.destroy();
    });
    client.store.subscribe(() => observed.push("obsolete-snapshot"));
    client.store.subscribeStatus(() =>
      observed.push(client.store.getStatus().type),
    );
    expect(() =>
      client.onSync({
        type: "snapshot",
        storeInstanceId: "one",
        version: 1,
        state: { count: 1, nested: { value: 0 } },
      }),
    ).toThrow();
    expect(observed).toEqual(["snapshot", "destroyed"]);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("settles an in-flight action when its subscription closes before delivery completes", async () => {
    const { provider, store } = createHost();
    const notified = deferred();
    const subscription = await subscribe(provider.service, (event) => {
      if (event.type === "snapshot") {
        notified.resolve();
        return new Promise<void>(() => undefined);
      }
    });
    const pending = subscription.actions.add(1);
    const rejected = pending.catch((error) => error);
    await notified.promise;
    subscription.unsubscribe();
    expect(await rejected).toMatchObject({ code: "E_STORE_DISCONNECTED" });
    expect(store.getState().count).toBe(1);
  });
  it("releases a shared callback only when its last subscription is stopped", async () => {
    const { provider, store } = createHost();
    const release = vi.fn();
    const inits: InitEnvelope<Data, Actions>[] = [];
    const callback = Object.assign(
      vi.fn((event: SyncEnvelope<Data, Actions>) => {
        if (event.type === "init") inits.push(event);
      }),
      { [RELEASE_PROXY_SYMBOL]: release },
    );
    await provider.service.subscribe(callback);
    await provider.service.subscribe(callback);
    const [first, second] = inits;
    first.unsubscribe();
    expect(release).not.toHaveBeenCalled();
    callback.mockClear();
    expect(store.getState().add(1)).toBe(1);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    second.unsubscribe();
    const service = provider.service as typeof provider.service &
      ServiceInvocationHooks;
    service[SERVICE_ON_DISCONNECT]?.("none");
    expect(release).toHaveBeenCalledOnce();
  });

  it("lets a callback await another action without blocking its acknowledgement", async () => {
    const { provider, store } = createHost();
    let subscribed: InitEnvelope<Data, Actions>;
    subscribed = await subscribe(provider.service, (event) => {
      if (event.type === "snapshot" && event.version === 1)
        return subscribed.actions.add(1);
    });
    await expect(subscribed.actions.add(1)).resolves.toBe(1);
    expect(store.getState().count).toBe(2);
    subscribed.unsubscribe();
  });

  it("reclaims a late init through core after the client handshake times out", async () => {
    const { provider, store } = createHost();
    const subscribed = deferred();
    const reply = deferred();
    const stopped = deferred();
    const callback = vi.fn();
    const wrapped = {
      ...provider.service,
      async subscribe(
        listener: Parameters<typeof provider.service.subscribe>[0],
      ) {
        subscribed.resolve();
        await reply.promise;
        await provider.service.subscribe((event) => {
          if (event.type === "init")
            return listener({
              ...event,
              unsubscribe: () => {
                event.unsubscribe();
                stopped.resolve();
              },
            });
          callback(event);
          return listener(event);
        });
      },
    };
    const network = await createStarNetwork<
      { context: string },
      { from: string }
    >({
      center: { meta: { context: "host" }, providers: { [token.id]: wrapped } },
      leaves: [
        {
          meta: { context: "client" },
          cmConfig: { connectTo: [{ context: "host" }] },
        },
      ],
    });
    const failed = connectNexusStore(network.get("client")!.nexus, token, {
      target: { context: "host" },
      timeout: 100,
    }).catch((error) => error);
    await subscribed.promise;
    expect(await failed).toMatchObject({ code: "E_STORE_CONNECT" });
    reply.resolve();
    await stopped.promise;
    expect(store.getState().add(1)).toBe(1);
    expect(callback).not.toHaveBeenCalled();
  });

  it("waits for each action's delivery without blocking other subscriptions or commits", async () => {
    const { provider, store } = createHost();
    const first = deferred();
    const second = deferred();
    const slow = await subscribe(provider.service, (event) => {
      if (event.type === "snapshot")
        return event.version === 1 ? first.promise : second.promise;
    });
    const fast = await subscribe(provider.service);
    const completed: string[] = [];
    const pending = slow.actions.add(1).then(() => completed.push("first"));
    await fast.actions.add(1);
    expect(store.getState().count).toBe(2);
    expect(completed).toEqual([]);
    first.resolve();
    second.resolve();
    await pending;
    expect(completed).toEqual(["first"]);
    second.resolve();
    slow.unsubscribe();
    fast.unsubscribe();
  });

  it("publishes each immediate local write, including composed actions", async () => {
    type State = { count: number; obsolete?: boolean };
    type Methods = {
      delayed(): Promise<number>;
      add(): number;
      replace(): void;
      compose(): void;
    };
    const gate = deferred();
    const started = deferred();
    const { store, destroy } = createNexusStore(
      createStoreToken<State & Methods>("state:drafts"),
      (set, get) => ({
        count: 0,
        obsolete: true,
        async delayed() {
          set({ count: 1 });
          started.resolve();
          await gate.promise;
          return get().count;
        },
        add() {
          set({ count: get().count + 1 });
          return get().count;
        },
        compose() {
          get().add();
          get().add();
        },
        replace() {
          const { add, delayed, replace, compose } = get();
          set({ count: 0, add, delayed, replace, compose }, true);
        },
      }),
      {
        snapshot: ({ count }) => ({ count }),
        expose: ["delayed", "add", "replace", "compose"],
      },
    );
    disposals.push(destroy);
    const observed = vi.fn();
    store.subscribe(observed);
    const delayed = store.getState().delayed();
    await started.promise;
    const next = store.getState().add();
    expect(store.getState().count).toBe(2);
    expect(observed).toHaveBeenCalled();
    gate.resolve();
    await expect(delayed).resolves.toBe(2);
    expect(next).toBe(2);
    store.getState().compose();
    expect(store.getState().count).toBe(4);
    expect(observed).toHaveBeenCalledTimes(4);
    store.getState().replace();
    expect(store.getState().count).toBe(0);
  });

  it("keeps raw local data while validating outgoing snapshots", async () => {
    type State = { count: number; map: Map<string, bigint> };
    const contract = createStoreToken<State & { add(by: number): void }>(
      "state:rich",
      {
        validation: {
          state: z.object({
            count: z.number().max(2),
            map: z.map(z.string(), z.bigint()),
          }),
        },
      },
    );
    const { store, destroy } = createNexusStore(
      contract,
      (set, get) => ({
        count: 0,
        map: new Map([["one", 1n]]),
        add(by) {
          set({ count: get().count + by });
        },
      }),
      { snapshot: ({ count, map }) => ({ count, map }), expose: ["add"] },
    );
    disposals.push(destroy);
    store.getState().map.set("two", 2n);
    expect(() => store.getState().add(3)).not.toThrow();
    expect(store.getState().count).toBe(3);
    expect(store.getInitialState().count).toBe(0);
  });

  it("applies early updates after baseline, deduplicates versions, and freezes a stale handle", () => {
    const remote = createRemoteStore<Data & Actions>();
    const unsubscribe = vi.fn();
    const snapshot = (version: number, storeInstanceId = "one") => ({
      type: "snapshot",
      version,
      storeInstanceId,
      state: { count: version, nested: { value: 0 } },
    });
    remote.onSync(snapshot(1));
    remote.onSync({ ...snapshot(0), type: "init", actions: {}, unsubscribe });
    const observe = vi.fn();
    remote.store.subscribe(observe);
    remote.onSync(snapshot(1));
    expect(observe).not.toHaveBeenCalled();
    remote.onSync(snapshot(2));
    expect(observe).toHaveBeenCalledOnce();
    expect(() => remote.onSync(snapshot(3, "two"))).toThrowError();
    expect(remote.store.getState().count).toBe(2);
    expect(remote.store.getStatus().type).toBe("stale");
    expect(unsubscribe).toHaveBeenCalledOnce();
    remote.store.destroy();
  });

  it("does not leak subscriptions created after their invocation connection closed", async () => {
    const { provider } = createHost();
    const service = provider.service as typeof provider.service &
      ServiceInvocationHooks;
    const context = {
      sourceConnectionId: "one",
      sourceIdentity: undefined,
      localIdentity: undefined,
      platform: undefined,
    };
    service[SERVICE_INVOKE_START]?.(context);
    service[SERVICE_INVOKE_END]?.(context);
    service[SERVICE_ON_DISCONNECT]?.("one");
    await expect(
      Reflect.apply(service.subscribe, service, [vi.fn(), context]),
    ).rejects.toMatchObject({ code: "E_STORE_DISCONNECTED" });
  });

  it("publishes committed state and stops delivery when unsubscribed", async () => {
    const { provider, store } = createHost();
    const callback = vi.fn(async () => undefined);
    const subscription = await subscribe(provider.service, callback);
    expect(subscription).toMatchObject({ state: { count: 0 }, version: 0 });
    expectTypeOf(store.getState().add).toEqualTypeOf<(by: number) => number>();
    callback.mockClear();
    await expect(subscription.actions.add(2)).resolves.toBe(2);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        state: { count: 2, nested: { value: 0 } },
      }),
    );
    subscription.unsubscribe();
    expect(store.getState().add(1)).toBe(3);
    expect(callback).toHaveBeenCalledOnce();
    await expect(subscription.actions.add(1)).rejects.toMatchObject({
      code: "E_STORE_DISCONNECTED",
    });
  });

  it("keeps local writes from a failed action", async () => {
    const { store } = createHost();
    store.getState().nested.value = 10;
    expect(store.getState().add(1)).toBe(1);
    expect(() => store.getState().fail()).toThrow("rollback");
    expect(store.getState().count).toBe(99);
    expect(store.getState().nested.value).toBe(99);
  });

  it("runs over core callbacks and completes after this subscriber sees the commit", async () => {
    const { provider } = createHost();
    const network = await createStarNetwork<
      { context: string },
      { from: string }
    >({
      center: {
        meta: { context: "host" },
        providers: { [token.id]: provider.service },
      },
      leaves: [
        {
          meta: { context: "client" },
          cmConfig: { connectTo: [{ context: "host" }] },
        },
      ],
    });
    const remote = await connectNexusStore(
      network.get("client")!.nexus,
      token,
      { target: { context: "host" } },
    );
    disposals.push(() => remote.destroy());
    const order: string[] = [];
    remote.subscribe(() => order.push("snapshot"));
    await remote.actions.add(2).then(() => order.push("action"));
    expect(order).toEqual(["snapshot", "action"]);
    expect(remote.getState().count).toBe(2);
  });

  it("releases returned core resources on destroy and ignores later callbacks", async () => {
    const callbackRef = vi.fn();
    const unsubscribe = Object.assign(vi.fn(), {
      [RELEASE_PROXY_SYMBOL]: vi.fn(),
    });
    const actions = {
      add: Object.assign(
        vi.fn(async () => 1),
        { [RELEASE_PROXY_SYMBOL]: vi.fn() },
      ),
      fail: vi.fn(),
    };
    const service = {
      subscribe: vi.fn(async (callback: (event: unknown) => void) => {
        callbackRef.mockImplementation(callback);
        callback({
          type: "init",
          storeInstanceId: "one",
          version: 0,
          state: { count: 0, nested: { value: 0 } },
          unsubscribe,
          actions,
        });
      }),
    } as unknown as NexusStoreServiceContract<Data & Actions>;
    const remote = await connectNexusStore(
      { create: async () => service } as any,
      token,
    );
    remote.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(unsubscribe[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
    expect(actions.add[RELEASE_PROXY_SYMBOL]).toHaveBeenCalledOnce();
    callbackRef({
      type: "snapshot",
      storeInstanceId: "one",
      version: 1,
      state: { count: 1, nested: { value: 0 } },
    });
    expect(remote.getState().count).toBe(0);
  });

  it("reclaims a late subscribe response after handshake timeout", async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    const unsubscribe = Object.assign(vi.fn(), {
      [RELEASE_PROXY_SYMBOL]: release,
    });
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const service = {
      subscribe: async (callback: (event: unknown) => void) => {
        await pending;
        callback({
          type: "init",
          storeInstanceId: "one",
          version: 0,
          state: { count: 0, nested: { value: 0 } },
          unsubscribe,
          actions: {},
        });
      },
    } as unknown as NexusStoreServiceContract<Data & Actions>;
    try {
      const connected = connectNexusStore(
        { create: async () => service } as any,
        token,
        { timeout: 10 },
      );
      const rejected = connected.catch((error) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await rejected).toMatchObject({ code: "E_STORE_CONNECT" });
      resolve();
      await vi.runAllTimersAsync();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
