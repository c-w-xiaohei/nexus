import { describe, expect, it, vi } from "vitest";
import { Token } from "../../src/api/token";
import { createStarNetwork } from "../../src/utils/test-utils";
import type { TestAdapterModel } from "../../src/utils/test-utils";
import { connectNexusStore } from "../../src/state";
import type { NexusStoreServiceContract } from "../../src/state/contract";

type State = { count: number };
type Actions = { increment(by: number): number };
type Meta = {
  context: "background" | "content-script";
  active?: boolean;
  issueId?: string;
};
type Model = TestAdapterModel<Meta, { from: string }>;

const createDefinition = (id: string) => ({
  definition: {
    token: new Token<NexusStoreServiceContract<State, Actions>, Model>(id),
  },
  creator: (set: any, get: any) => ({
    count: 0,
    increment(by: number) {
      set({ count: get().count + by });
      return get().count;
    },
  }),
});

describe("Nexus State targeting and handoff", () => {
  it("marks a where-selected handle stale when the selected identity changes", async () => {
    const { definition, creator } = createDefinition("state:targeting");
    const first = (await import("../../src/state")).createNexusStore(
      definition,
      creator,
      {
        snapshot: (state: State) => ({ count: state.count }),
        expose: ["increment"],
      },
    );
    const second = (await import("../../src/state")).createNexusStore(
      definition,
      creator,
      {
        snapshot: (state: State) => ({ count: state.count }),
        expose: ["increment"],
      },
    );
    const network = await createStarNetwork<Meta, { from: string }>({
      center: { meta: { context: "background" } },
      leaves: [
        {
          meta: { context: "content-script", issueId: "one", active: true },
          providers: { [definition.token.id]: first.provider.service },
          cmConfig: { connectTo: [{ context: "background" }] },
        },
        {
          meta: { context: "content-script", issueId: "two", active: false },
          providers: { [definition.token.id]: second.provider.service },
          cmConfig: { connectTo: [{ context: "background" }] },
        },
      ],
    });
    const background = network.get("background")!.nexus;
    const one = network.get("content-script:one")?.nexus;
    const two = network.get("content-script:two")?.nexus;
    const remote = await connectNexusStore(background, definition, {
      target: { context: "content-script" },
      where: (meta) => meta.active === true,
    });
    await expect(remote.actions.increment(1)).resolves.toBe(1);
    if (!one || !two) throw new Error("Expected content-script nodes");
    await one.updateIdentity({ active: false });
    await two.updateIdentity({ active: true });
    await vi.waitFor(() => expect(remote.getStatus().type).toBe("stale"));
    await expect(remote.actions.increment(1)).rejects.toBeDefined();
  });

  it("keeps an exact target usable through unrelated identity changes", async () => {
    const { definition, creator } = createDefinition("state:fixed-target");
    const registration = (await import("../../src/state")).createNexusStore(
      definition,
      creator,
      {
        snapshot: (state: State) => ({ count: state.count }),
        expose: ["increment"],
      },
    );
    const network = await createStarNetwork<Meta, { from: string }>({
      center: { meta: { context: "background" } },
      leaves: [
        {
          meta: { context: "content-script", issueId: "one" },
          providers: { [definition.token.id]: registration.provider.service },
          cmConfig: { connectTo: [{ context: "background" }] },
        },
      ],
    });
    const remote = await connectNexusStore(
      network.get("background")!.nexus,
      definition,
      {
        target: { context: "content-script", issueId: "one" },
      },
    );
    await expect(remote.actions.increment(1)).resolves.toBe(1);
    expect(remote.getStatus().type).toBe("ready");
  });
});
