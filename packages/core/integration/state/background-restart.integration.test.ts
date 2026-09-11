import { describe, expect, it, vi } from "vitest";
import { Nexus } from "../../src";
import type { IPort } from "../../src/transport";
import { createMockPortPair } from "../../src/utils/test-utils";
import type { TestAdapterModel } from "../../src/utils/test-utils";
import { connectNexusStore, createStoreToken } from "../../src/state";
import type { SyncEnvelope } from "../../src/state/protocol";
import type { NexusStoreServiceContract } from "../../src/state/contract";

type State = { count: number };
type Actions = { increment(by: number): number };
type Model = TestAdapterModel<
  { context: "background" | "popup" },
  { from: string }
>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const createService = (
  storeInstanceId: string,
  gate?: Promise<void>,
  started?: () => void,
) => {
  let count = 0;
  let version = 0;
  const listeners = new Set<
    (event: SyncEnvelope<State, State & Actions>) => unknown
  >();
  const emit = async () => {
    const event = {
      type: "snapshot" as const,
      storeInstanceId,
      version,
      state: { count },
    };
    await Promise.all([...listeners].map((listener) => listener(event)));
  };
  const actions = {
    async increment(by: number) {
      started?.();
      await gate;
      count += by;
      version += 1;
      await emit();
      return count;
    },
  };
  return {
    async subscribe(
      listener: (event: SyncEnvelope<State, State & Actions>) => unknown,
    ) {
      listeners.add(listener);
      await listener({
        type: "init",
        storeInstanceId,
        version,
        state: { count },
        actions,
        unsubscribe: () => {
          listeners.delete(listener);
        },
      });
    },
  } as NexusStoreServiceContract<State & Actions>;
};

const createHost = async (service: object) => {
  const nexus = new Nexus<Model>();
  let accept!: (port: IPort) => void;
  nexus.configure({
    endpoint: {
      meta: { context: "background" },
      implementation: {
        listen: (onConnect) => {
          accept = (port) => onConnect(port, { from: "popup" });
        },
        connect: async () => {
          throw new Error("background does not dial");
        },
      },
    },
    providers: [{ token: definition, service }],
  });
  await vi.waitFor(() => expect((nexus as any).connectionManager).toBeTruthy());
  return { nexus, accept };
};

const createPopup = async (getHost: () => { accept(port: IPort): void }) => {
  const popup = new Nexus<Model>();
  popup.configure({
    endpoint: {
      meta: { context: "popup" },
      implementation: {
        connect: async () => {
          const [popupPort, backgroundPort] = createMockPortPair();
          getHost().accept(backgroundPort);
          return { port: popupPort, connectionMeta: { from: "background" } };
        },
        listen: vi.fn(),
      },
      matchesTarget: (
        target: Model["connectionTarget"],
        meta: Model["contextMeta"],
      ) => target.context === meta.context,
      connectTo: [{ context: "background" }],
    },
  });
  await vi.waitFor(() => expect((popup as any).connectionManager).toBeTruthy());
  return popup;
};

const definition = createStoreToken<State & Actions, Model>("state:restart");

describe("Nexus State background restart lifecycle", () => {
  it("disconnects an old handle and connects a replacement session", async () => {
    let host = await createHost(createService("v1"));
    const popup = await createPopup(() => host);
    const old = await connectNexusStore(popup, definition, {
      target: { context: "background" },
    });
    await expect(old.actions.increment(1)).resolves.toBe(1);

    for (const connection of (
      host.nexus as any
    ).connectionManager.connections.values())
      connection.close();
    host = await createHost(createService("v2"));
    await vi.waitFor(() => expect(old.getStatus().type).toBe("disconnected"));
    await expect(old.actions.increment(1)).rejects.toBeDefined();

    const replacement = await connectNexusStore(popup, definition, {
      target: { context: "background" },
    });
    await expect(replacement.actions.increment(2)).resolves.toBe(2);
  });

  it("quarantines an old in-flight snapshot after its connection closes", async () => {
    const release = deferred<void>();
    const started = deferred<void>();
    const oldHost = await createHost(
      createService("v1", release.promise, () => started.resolve()),
    );
    const popup = await createPopup(() => oldHost);
    const old = await connectNexusStore(popup, definition, {
      target: { context: "background" },
    });
    const pending = old.actions.increment(1);
    await started.promise;
    for (const connection of (
      oldHost.nexus as any
    ).connectionManager.connections.values())
      connection.close();
    await vi.waitFor(() => expect(old.getStatus().type).toBe("disconnected"));
    release.resolve();
    await expect(pending).rejects.toBeDefined();
    expect(old.getState()).toEqual({ count: 0 });
  });
});
