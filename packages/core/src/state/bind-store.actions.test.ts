import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createNexusStore } from "./bind-store";
import { createStoreToken } from "./contract";
import { NexusStoreActionError } from "./errors";
import type { NexusStoreServiceContract } from "./contract";
import type { SyncEnvelope } from "./protocol";

type CounterState = { count: number };
type CounterActions = {
  increment(by: number): number;
  explode(): void;
};

const token = () =>
  createStoreToken<CounterState & CounterActions>(
    `state:host-runtime:${Math.random()}`,
  );

const createCounter = () =>
  createNexusStore(
    token(),
    (set, get) => ({
      count: 0,
      increment(by: number) {
        set({ count: get().count + by });
        return get().count;
      },
      explode() {
        set({ count: 999 });
        throw new Error("boom");
      },
    }),
    { snapshot: ({ count }) => ({ count }), expose: ["increment", "explode"] },
  );

const subscribe = async (
  service: NexusStoreServiceContract<CounterState & CounterActions>,
  onSync: (
    event: SyncEnvelope<CounterState, CounterState & CounterActions>,
  ) => unknown = () => undefined,
) => {
  let init!: Extract<
    SyncEnvelope<CounterState, CounterState & CounterActions>,
    { type: "init" }
  >;
  await service.subscribe(async (event) => {
    if (event.type === "init") init = event;
    await onSync(event);
  });
  return init;
};

describe("native State provider runtime", () => {
  it("publishes snapshots through the callback init handshake", async () => {
    const { provider, destroy } = createCounter();
    const events: number[] = [];
    const init = await subscribe(provider.service, (event) => {
      if (event.type === "snapshot") events.push(event.state.count);
    });

    expect(init).toMatchObject({
      type: "init",
      version: 0,
      state: { count: 0 },
    });
    await expect(init.actions.increment(1)).resolves.toBe(1);
    await expect(init.actions.increment(2)).resolves.toBe(3);
    expect(events).toEqual([1, 3]);
    init.unsubscribe();
    destroy();
  });

  it("publishes failed-action writes and preserves remote action progress", async () => {
    const { provider, store, destroy } = createCounter();
    const init = await subscribe(provider.service);

    await expect(init.actions.explode()).rejects.toBeInstanceOf(
      NexusStoreActionError,
    );
    await expect(init.actions.increment(2)).resolves.toBe(1001);
    expect(store.getState()).toMatchObject({ count: 1001 });
    init.unsubscribe();
    destroy();
  });

  it("allows overlapping async actions to overwrite by completion order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    type Actions = {
      addAfter(by: number, wait: Promise<void>): Promise<number>;
    };
    const { store, destroy } = createNexusStore(
      createStoreToken<CounterState & Actions>("state:serial"),
      (set, get) => ({
        count: 0,
        async addAfter(by: number, wait: Promise<void>) {
          const base = get().count;
          await wait;
          set({ count: base + by });
          return get().count;
        },
      }),
      { snapshot: ({ count }) => ({ count }), expose: ["addAfter"] },
    );
    const first = store.getState().addAfter(1, gate);
    const second = store.getState().addAfter(2, Promise.resolve());
    release();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(store.getState().count).toBe(1);
    destroy();
  });

  it("keeps local listeners active after remote unsubscribe", async () => {
    const { provider, store, destroy } = createCounter();
    const stable = vi.fn();
    const throwing = vi.fn();
    store.subscribe(throwing);
    store.subscribe(stable);
    const init = await subscribe(provider.service);
    await init.actions.increment(1);
    expect(stable).toHaveBeenCalledOnce();
    init.unsubscribe();
    expect(store.getState().increment(1)).toBe(2);
    expect(stable).toHaveBeenCalledTimes(2);
    destroy();
  });

  it("allows invalid local state while rejecting its remote publication", async () => {
    const { store, destroy } = createNexusStore(
      createStoreToken<CounterState & Pick<CounterActions, "increment">>(
        "state:validate",
        { validation: { state: z.object({ count: z.number().max(1) }) } },
      ),
      (set, get) => ({
        count: 0,
        increment(by: number) {
          set({ count: get().count + by });
          return get().count;
        },
      }),
      { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
    );
    expect(store.getState().increment(2)).toBe(2);
    expect(store.getState()).toMatchObject({ count: 2 });
    destroy();
  });
});
