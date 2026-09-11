import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StateCreator } from "zustand/vanilla";
import { Token } from "../api/token";
import { createL3Endpoints } from "../utils/test-utils";
import { createNexusStore } from "./bind-store";
import { NexusStoreProtocolError } from "./errors";
import type { ActionFunction, NexusStoreServiceContract } from "./contract";
import type { SyncEnvelope } from "./protocol";

type State = { count: number };
type Actions = { increment(by: number): number };

const createDefinition = (id: string) => ({
  token: new Token<NexusStoreServiceContract<State, Actions>>(`state:${id}`),
});

const createCreator = (): StateCreator<State & Actions> => (set, get) => ({
  count: 0,
  increment(by: number) {
    set({ count: get().count + by });
    return get().count;
  },
});

const subscribe = async <A extends Record<string, ActionFunction>>(
  service: NexusStoreServiceContract<State, A>,
  onSync: (event: SyncEnvelope<State, A>) => unknown = () => undefined,
) => {
  let init!: Extract<SyncEnvelope<State, A>, { type: "init" }>;
  await service.subscribe(async (event) => {
    if (event.type === "init") init = event;
    await onSync(event);
  });
  return init;
};

describe("createNexusStore", () => {
  it("creates an ordinary provider and native local handle", async () => {
    const definition = createDefinition("provider");
    const { provider, store, destroy } = createNexusStore(
      definition,
      createCreator(),
      { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
    );

    expect(provider.token).toBe(definition.token);
    expect(store.getState()).toMatchObject({ count: 0 });
    const init = await subscribe(provider.service);
    expect(init.state).toEqual({ count: 0 });

    expect(store.getState().increment(3)).toBe(3);
    expect(store.getState()).toMatchObject({ count: 3 });
    init.unsubscribe();
    destroy();
  });

  it("preserves raw Zustand references and isolates outgoing snapshots", async () => {
    const definition = createDefinition("isolation");
    const { provider, store, destroy } = createNexusStore(
      definition,
      createCreator(),
      { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
    );
    const initial = store.getState();
    expect(store.getState()).toBe(initial);
    const init = await subscribe(provider.service);
    init.state.count = 99;

    store.setState({ count: 2 });

    expect(store.getState()).toMatchObject({ count: 2 });
    expect(init.state).toMatchObject({ count: 99 });
    init.unsubscribe();
    destroy();
  });

  it("publishes separate snapshots for sequentially awaited actions", async () => {
    const definition = createDefinition("publishing");
    const { provider, destroy } = createNexusStore(
      definition,
      createCreator(),
      { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
    );
    const snapshots: number[] = [];
    const init = await subscribe(provider.service, (event) => {
      if (event.type === "snapshot") snapshots.push(event.state.count);
    });

    await init.actions.increment(1);
    await init.actions.increment(2);
    expect(snapshots).toEqual([1, 3]);
    init.unsubscribe();
    destroy();
  });

  it("keeps failed-action writes and other listeners alive", async () => {
    const definition = {
      token: new Token<
        NexusStoreServiceContract<State, Actions & { fail(): never }>
      >("state:failed-write"),
    };
    const { provider, store, destroy } = createNexusStore(
      definition,
      (set, get) => ({
        count: 0,
        increment(by: number) {
          set({ count: get().count + by });
          return get().count;
        },
        fail() {
          set({ count: 99 });
          throw new Error("rollback");
        },
      }),
      {
        snapshot: ({ count }) => ({ count }),
        expose: ["increment", "fail"],
      },
    );
    const init = await subscribe(provider.service);
    const listener = vi.fn();
    store.subscribe(listener);

    await expect(init.actions.fail()).rejects.toMatchObject({
      code: "E_STORE_ACTION",
    });
    expect(store.getState()).toMatchObject({ count: 99 });
    await expect(init.actions.increment(2)).resolves.toBe(101);
    expect(store.getState()).toMatchObject({ count: 101 });
    expect(listener).toHaveBeenCalledTimes(2);
    init.unsubscribe();
    destroy();
  });

  it("validates committed state before publishing it", async () => {
    const definition = {
      token: new Token<NexusStoreServiceContract<State, Actions>>(
        "state:validation",
      ),
      validation: { state: z.object({ count: z.number().max(1) }) },
    };
    const { store, destroy } = createNexusStore(definition, createCreator(), {
      snapshot: ({ count }) => ({ count }),
      expose: ["increment"],
    });

    expect(store.getState().increment(2)).toBe(2);
    expect(store.getState()).toMatchObject({ count: 2 });
    const { provider, destroy: validationDestroy } = createNexusStore(
      definition,
      createCreator(),
      { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
    );
    const init = await subscribe(provider.service);
    await expect(init.actions.increment(2)).rejects.toBeInstanceOf(
      NexusStoreProtocolError,
    );
    init.unsubscribe();
    validationDestroy();
    destroy();
  });

  it("cleans connection-owned subscriptions through the disconnect hook", async () => {
    const definition = createDefinition("disconnect");
    const { provider, destroy } = createNexusStore(
      definition,
      createCreator(),
      { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
    );
    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        providers: { [definition.token.id]: provider.service },
      },
      { meta: { id: "client" }, connectTo: [{ context: "host" }] },
    );
    const service = setup.clientEngine.createServiceProxy<
      NexusStoreServiceContract<State, Actions>
    >(definition.token.id, {
      strategy: "one",
      timeout: 5000,
      target: { connectionId: (setup.clientConnection as any).connectionId },
    });
    const callback = vi.fn();
    await service.subscribe(callback);
    (setup.clientConnection as { close(): void }).close();
    await vi.waitFor(() => {
      expect((setup.hostCm as any).connections.size).toBe(0);
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ type: "init" }),
    );
    destroy();
  });

  it("keeps the local store usable after binding destruction", async () => {
    const { store, destroy } = createNexusStore(
      createDefinition("destroy"),
      createCreator(),
      { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
    );
    expect(store.getState().increment(1)).toBe(1);
    destroy();
    expect(store.getState().increment(1)).toBe(2);
  });
});
