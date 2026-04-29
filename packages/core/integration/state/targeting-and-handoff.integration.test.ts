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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

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
    const oldSnapshots: number[] = [];
    const stopOld = remote.subscribe((snapshot) => {
      oldSnapshots.push(snapshot.count);
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

    stopOld();
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

    type SnapshotEvent = {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: CounterState;
    };

    const cs1DispatchStarted = deferred<void>();
    const cs1DispatchRelease = deferred<void>();
    const cs1UnsubscribeRelease = deferred<void>();
    let cs1LateDeliveryAttempts = 0;

    const createStoreService = (
      storeInstanceId: string,
      options?: {
        onDispatchStart?: () => void;
        beforeUnsubscribe?: () => Promise<void>;
        dispatchGate?: Promise<void>;
        onSnapshotAttempt?: () => void;
      },
    ) => {
      let version = 0;
      let state: CounterState = { count: 0 };
      const subscriptions = new Map<string, (event: SnapshotEvent) => void>();
      let subscriptionSeq = 0;

      const emitSnapshot = () => {
        const event: SnapshotEvent = {
          type: "snapshot",
          storeInstanceId,
          version,
          state,
        };
        for (const callback of subscriptions.values()) {
          options?.onSnapshotAttempt?.();
          callback(event);
        }
      };

      return {
        async subscribe(onSync: (event: SnapshotEvent) => void) {
          const subscriptionId = `${storeInstanceId}:sub:${++subscriptionSeq}`;
          subscriptions.set(subscriptionId, onSync);
          return { storeInstanceId, subscriptionId, version, state };
        },
        async unsubscribe(subscriptionId: string) {
          await options?.beforeUnsubscribe?.();
          subscriptions.delete(subscriptionId);
        },
        async dispatch(_action: "increment", args: [number]) {
          options?.onDispatchStart?.();
          await options?.dispatchGate;

          state = { count: state.count + args[0] };
          version += 1;
          emitSnapshot();

          return {
            type: "dispatch-result" as const,
            committedVersion: version,
            result: state.count,
          };
        },
      };
    };

    const definition = defineNexusStore<
      CounterState,
      CounterActions,
      AppUserMeta
    >({
      token: new Token("state:counter:dynamic-handoff-inflight:integration"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        async increment(by: number) {
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
      defaultTarget: {
        matcher: (id: any) => id.context === "content-script" && id.isActive,
        descriptor: { context: "content-script" },
      },
    });

    const cs1Service = createStoreService("cs1:v1", {
      onDispatchStart: () => cs1DispatchStarted.resolve(),
      beforeUnsubscribe: () => cs1UnsubscribeRelease.promise,
      dispatchGate: cs1DispatchRelease.promise,
      onSnapshotAttempt: () => {
        cs1LateDeliveryAttempts += 1;
      },
    });

    const cs2Service = createStoreService("cs2:v1");

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
            [definition.token.id]: cs1Service,
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
            [definition.token.id]: cs2Service,
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
    const oldSnapshots: number[] = [];
    const stopOld = remote.subscribe((snapshot) => {
      oldSnapshots.push(snapshot.count);
    });

    const pendingOutcome = remote.actions.increment(1).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await cs1DispatchStarted.promise;

    await cs1Nexus.updateIdentity({ isActive: false });
    await cs2Nexus.updateIdentity({ isActive: true });

    await vi.waitFor(() => {
      expect(remote.getStatus().type).toBe("stale");
    });

    const replacement = await connectNexusStore(backgroundNexus, definition, {
      target: {
        matcher: (id: any) => id.context === "content-script" && id.isActive,
        descriptor: { context: "content-script" },
      },
    });

    const replacementSnapshots: number[] = [];
    const stopReplacement = replacement.subscribe((snapshot) => {
      replacementSnapshots.push(snapshot.count);
    });

    expect(replacement.getStatus().type).toBe("ready");
    expect(replacement.getState().count).toBe(0);

    cs1DispatchRelease.resolve();

    await vi.waitFor(() => {
      expect(cs1LateDeliveryAttempts).toBe(1);
    });

    const pendingResult = await pendingOutcome;
    expect(pendingResult.ok).toBe(false);
    if (!pendingResult.ok) {
      expect(pendingResult.error).toBeInstanceOf(NexusStoreDisconnectedError);
      expect((pendingResult.error as Error).message).toMatch(/stale/i);
    }

    expect(oldSnapshots).toEqual([]);
    expect(remote.getState().count).toBe(0);
    expect(replacementSnapshots).toEqual([]);
    expect(replacement.getState().count).toBe(0);

    cs1UnsubscribeRelease.resolve();

    await expect(replacement.actions.increment(2)).resolves.toBe(2);
    await vi.waitFor(() => {
      expect(replacementSnapshots).toEqual([2]);
      expect(replacement.getState().count).toBe(2);
    });

    stopOld();
    stopReplacement();
  });
});
