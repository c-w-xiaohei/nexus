import { describe, expect, it, vi } from "vitest";
import { Token } from "../../src/api/token";
import { createStarNetwork } from "../../src/utils/test-utils";
import type { TestAdapterModel } from "../../src/utils/test-utils";
import { connectNexusStore, createNexusStore } from "../../src/state";
import type { NexusStoreServiceContract } from "../../src/state/contract";

type State = { count: number };
type Actions = { increment(by: number): number };
type Model = TestAdapterModel<
  { context: "background" | "popup-a" | "popup-b" },
  { from: string }
>;

const makeStore = (id: string) => {
  const token = new Token<NexusStoreServiceContract<State, Actions>, Model>(id);
  const definition = { token };
  const registration = createNexusStore(
    definition,
    (set, get) => ({
      count: 0,
      increment(by: number) {
        set({ count: get().count + by });
        return get().count;
      },
    }),
    {
      snapshot: (state) => ({ count: state.count }),
      expose: ["increment"],
    },
  );
  return { definition, registration };
};

describe("Nexus State lifecycle and cleanup", () => {
  it("synchronizes a native store and reports transport disconnect", async () => {
    const { definition, registration } = makeStore("state:lifecycle:single");
    const network = await createStarNetwork<
      { context: "background" | "popup-a" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        providers: { [definition.token.id]: registration.provider.service },
      },
      leaves: [
        {
          meta: { context: "popup-a" },
          cmConfig: { connectTo: [{ context: "background" }] },
        },
      ],
    });
    const popup = network.get("popup-a")!.nexus;
    const remote = await connectNexusStore(popup as any, definition, {
      target: { context: "background" },
    });
    await expect(remote.actions.increment(1)).resolves.toBe(1);
    expect(remote.getState()).toEqual({ count: 1 });

    const connection = Array.from(
      (popup as any).connectionManager.connections.values(),
    )[0] as {
      close(): void;
    };
    connection.close();
    await vi.waitFor(() =>
      expect(remote.getStatus().type).toBe("disconnected"),
    );
    await expect(remote.actions.increment(1)).rejects.toBeDefined();
  });

  it("fans out committed snapshots and removes only the disconnected client", async () => {
    const { definition, registration } = makeStore("state:lifecycle:fanout");
    const network = await createStarNetwork<
      { context: "background" | "popup-a" | "popup-b" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        providers: { [definition.token.id]: registration.provider.service },
      },
      leaves: [
        {
          meta: { context: "popup-a" },
          cmConfig: { connectTo: [{ context: "background" }] },
        },
        {
          meta: { context: "popup-b" },
          cmConfig: { connectTo: [{ context: "background" }] },
        },
      ],
    });
    const remoteA = await connectNexusStore(
      network.get("popup-a")!.nexus,
      definition,
      {
        target: { context: "background" },
      },
    );
    const remoteB = await connectNexusStore(
      network.get("popup-b")!.nexus,
      definition,
      {
        target: { context: "background" },
      },
    );
    const seenA: number[] = [];
    const seenB: number[] = [];
    remoteA.subscribe((state) => seenA.push(state.count));
    remoteB.subscribe((state) => seenB.push(state.count));
    await remoteA.actions.increment(1);
    await vi.waitFor(() => {
      expect(seenA).toEqual([1]);
      expect(seenB).toEqual([1]);
    });
    const connection = Array.from(
      (
        network.get("popup-a")!.nexus as any
      ).connectionManager.connections.values(),
    )[0] as { close(): void };
    connection.close();
    await vi.waitFor(() =>
      expect(remoteA.getStatus().type).toBe("disconnected"),
    );
    await expect(remoteB.actions.increment(2)).resolves.toBe(3);
    expect(seenA).toEqual([1]);
    expect(seenB).toEqual([1, 3]);
  });
});
