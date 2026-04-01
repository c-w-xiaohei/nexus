/**
 * Simulates state-store discovery decisions when multiple content-script hosts
 * exist, verifying dynamic matcher handoff behavior and fixed-descriptor target
 * stability as endpoint identities change over time.
 */
import { describe, expect, it, vi } from "vitest";

import { Token } from "../../src/api/token";
import { createStarNetwork } from "../../src/utils/test-utils";
import {
  connectNexusStore,
  defineNexusStore,
  NexusStoreDisconnectedError,
  provideNexusStore,
} from "../../src/state";

import type { AppPlatformMeta, AppUserMeta } from "../fixtures";

describe("Nexus State Integration: Targeting and Identity Handoff", () => {
  it("marks existing dynamic-matcher store handle stale after active-target identity handoff", async () => {
    type CounterState = { count: number };
    type CounterActions = { increment(by: number): number };

    const definition = defineNexusStore<
      CounterState,
      CounterActions,
      AppUserMeta
    >({
      token: new Token("state:counter:dynamic-active-handoff:integration"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        increment(by: number) {
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
      defaultTarget: {
        matcher: (id: any) => id.context === "content-script" && id.isActive,
        descriptor: { context: "content-script" },
      },
    });

    const cs1Registration = provideNexusStore(definition);
    const cs2Registration = provideNexusStore(definition);

    const network = await createStarNetwork<AppUserMeta, AppPlatformMeta>({
      center: {
        meta: { context: "background", version: "1.0.0" },
      },
      leaves: [
        {
          meta: {
            context: "content-script",
            issueId: "CS1-ACTIVE",
            url: "github.com/issue/active",
            isActive: true,
            groups: ["issue-pages"],
          },
          services: {
            [definition.token.id]: cs1Registration.implementation,
          },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
        {
          meta: {
            context: "content-script",
            issueId: "CS2-INACTIVE",
            url: "github.com/issue/inactive",
            isActive: false,
            groups: ["issue-pages"],
          },
          services: {
            [definition.token.id]: cs2Registration.implementation,
          },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const backgroundNexus = network.get("background")!.nexus;
    const cs1Nexus = network.get("content-script:CS1-ACTIVE")!.nexus;
    const cs2Nexus = network.get("content-script:CS2-INACTIVE")!.nexus;

    const remote = await connectNexusStore(backgroundNexus, definition, {
      target: {
        matcher: (id: any) => id.context === "content-script" && id.isActive,
        descriptor: { context: "content-script" },
      },
    });

    await remote.actions.increment(1);
    expect(remote.getState().count).toBe(1);

    await cs1Nexus.updateIdentity({ isActive: false });
    await cs2Nexus.updateIdentity({ isActive: true });

    await vi.waitFor(() => {
      expect(remote.getStatus().type).toBe("stale");
    });

    await expect(remote.actions.increment(1)).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
  });

  it("keeps a fixed-target store handle ready on unrelated identity updates", async () => {
    type CounterState = { count: number };
    type CounterActions = { increment(by: number): number };

    const definition = defineNexusStore<
      CounterState,
      CounterActions,
      AppUserMeta
    >({
      token: new Token("state:counter:fixed-target-stability:integration"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        increment(by: number) {
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
      defaultTarget: {
        descriptor: { context: "content-script" },
      },
    });

    const cs1Registration = provideNexusStore(definition);
    const cs2Registration = provideNexusStore(definition);

    const network = await createStarNetwork<AppUserMeta, AppPlatformMeta>({
      center: {
        meta: { context: "background", version: "1.0.0" },
      },
      leaves: [
        {
          meta: {
            context: "content-script",
            issueId: "CS1-FIXED",
            url: "github.com/issue/fixed",
            isActive: true,
            groups: ["issue-pages"],
          },
          services: {
            [definition.token.id]: cs1Registration.implementation,
          },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
        {
          meta: {
            context: "content-script",
            issueId: "CS2-OTHER",
            url: "github.com/issue/other",
            isActive: false,
            groups: ["issue-pages"],
          },
          services: {
            [definition.token.id]: cs2Registration.implementation,
          },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const backgroundNexus = network.get("background")!.nexus;
    const cs2Nexus = network.get("content-script:CS2-OTHER")!.nexus;

    const remote = await connectNexusStore(backgroundNexus, definition, {
      target: {
        descriptor: { issueId: "CS1-FIXED", context: "content-script" },
      },
    });

    await remote.actions.increment(1);
    expect(remote.getState().count).toBe(1);

    await cs2Nexus.updateIdentity({ url: "github.com/issue/other-updated" });
    await new Promise((r) => setTimeout(r, 30));

    expect(remote.getStatus().type).toBe("ready");
    await expect(remote.actions.increment(1)).resolves.toBe(2);
    expect(remote.getState().count).toBe(2);
  });

  it("returns explicit stale-disconnect when active target flips during in-flight action", async () => {
    type CounterState = { count: number };
    type CounterActions = { increment(by: number): Promise<number> };

    let releaseCs1Action!: () => void;
    const cs1Gate = new Promise<void>((resolve) => {
      releaseCs1Action = resolve;
    });
    let markCs1Started!: () => void;
    const cs1Started = new Promise<void>((resolve) => {
      markCs1Started = resolve;
    });

    const definition = defineNexusStore<
      CounterState,
      CounterActions,
      AppUserMeta
    >({
      token: new Token("state:counter:dynamic-handoff-inflight:integration"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        async increment(by: number) {
          markCs1Started();
          await cs1Gate;
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
      defaultTarget: {
        matcher: (id: any) => id.context === "content-script" && id.isActive,
        descriptor: { context: "content-script" },
      },
    });

    const cs1Registration = provideNexusStore(definition);
    const cs2Registration = provideNexusStore(definition);

    const network = await createStarNetwork<AppUserMeta, AppPlatformMeta>({
      center: {
        meta: { context: "background", version: "1.0.0" },
      },
      leaves: [
        {
          meta: {
            context: "content-script",
            issueId: "CS1-HANDOFF-INFLIGHT",
            url: "github.com/issue/handoff-inflight-1",
            isActive: true,
            groups: ["issue-pages"],
          },
          services: {
            [definition.token.id]: cs1Registration.implementation,
          },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
        {
          meta: {
            context: "content-script",
            issueId: "CS2-HANDOFF-INFLIGHT",
            url: "github.com/issue/handoff-inflight-2",
            isActive: false,
            groups: ["issue-pages"],
          },
          services: {
            [definition.token.id]: cs2Registration.implementation,
          },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const backgroundNexus = network.get("background")!.nexus;
    const cs1Nexus = network.get("content-script:CS1-HANDOFF-INFLIGHT")!.nexus;
    const cs2Nexus = network.get("content-script:CS2-HANDOFF-INFLIGHT")!.nexus;

    const remote = await connectNexusStore(backgroundNexus, definition, {
      target: {
        matcher: (id: any) => id.context === "content-script" && id.isActive,
        descriptor: { context: "content-script" },
      },
    });

    const pending = remote.actions.increment(1);
    await cs1Started;

    await cs1Nexus.updateIdentity({ isActive: false });
    await cs2Nexus.updateIdentity({ isActive: true });

    await vi.waitFor(() => {
      expect(remote.getStatus().type).toBe("stale");
    });

    releaseCs1Action();

    await expect(pending).rejects.toBeInstanceOf(NexusStoreDisconnectedError);
    await pending.catch((error: unknown) => {
      expect((error as Error).message).toMatch(/stale/i);
    });
    expect(remote.getState().count).toBe(0);
  });
});
