/**
 * These tests cover the state host runtime in isolation.
 * They stay under `src/state` because they validate host-side bookkeeping,
 * dispatch semantics, rollback, and subscriber lifecycle directly rather than
 * the higher-level cross-endpoint scenarios covered by `packages/core/integration`.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Token } from "../api/token";
import { defineNexusStore } from "./define-store";
import {
  NexusStoreActionError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
} from "./errors";
import { createStoreHost } from "./host/store-host";
import { RELEASE_PROXY_SYMBOL } from "../types/symbols";

const createCounterDefinition = () =>
  defineNexusStore({
    token: new Token("state:counter:host-runtime"),
    state: () => ({ count: 0 }),
    actions: ({ getState, setState }) => ({
      increment(by: number) {
        setState({ count: getState().count + by });
        return getState().count;
      },
      explode() {
        throw new Error("boom");
      },
      mutateThenExplode() {
        setState({ count: 999 });
        throw new Error("boom-after-mutate");
      },
    }),
  });

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

describe("state host runtime baseline handshake", () => {
  it("creates store instance ids even when crypto.randomUUID is unavailable", async () => {
    const originalCrypto = globalThis.crypto;

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });

    try {
      const host = createStoreHost(createCounterDefinition());
      const baseline = await host.subscribe(() => {});

      expect(baseline.storeInstanceId).toMatch(/^store-instance:/);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it("creates initial versioned snapshot via subscribe baseline", async () => {
    const host = createStoreHost(createCounterDefinition());

    const baseline = await host.subscribe(() => {});

    expect(baseline.storeInstanceId).toMatch(/^store-instance:/);
    expect(baseline.subscriptionId).toMatch(/^store-subscription:/);
    expect(baseline.version).toBe(0);
    expect(baseline.state).toEqual({ count: 0 });
  });

  it("multiple subscribers observe same monotonic version stream", async () => {
    const host = createStoreHost(createCounterDefinition());
    const leftEvents: Array<{ version: number; count: number }> = [];
    const rightEvents: Array<{ version: number; count: number }> = [];

    await host.subscribe((event) => {
      leftEvents.push({ version: event.version, count: event.state.count });
    });
    await host.subscribe((event) => {
      rightEvents.push({ version: event.version, count: event.state.count });
    });

    await host.dispatch("increment", [1]);
    await host.dispatch("increment", [2]);

    expect(leftEvents).toEqual([
      { version: 1, count: 1 },
      { version: 2, count: 3 },
    ]);
    expect(rightEvents).toEqual([
      { version: 1, count: 1 },
      { version: 2, count: 3 },
    ]);
  });

  it("unsubscribe and destroy of one subscriber does not affect others", async () => {
    const host = createStoreHost(createCounterDefinition());
    const left = vi.fn();
    const right = vi.fn();

    const leftBaseline = await host.subscribe(left);
    await host.subscribe(right);

    await host.unsubscribe(leftBaseline.subscriptionId);
    await host.dispatch("increment", [1]);

    expect(left).not.toHaveBeenCalled();
    expect(right).toHaveBeenCalledTimes(1);

    host.destroy();
    await expect(host.dispatch("increment", [1])).rejects.toThrow();
  });

  it("isolates and drops a subscriber that throws", async () => {
    const host = createStoreHost(createCounterDefinition());
    const unstable = vi.fn(() => {
      throw new Error("listener-failed");
    });
    const stable = vi.fn();

    await host.subscribe(unstable);
    await host.subscribe(stable);

    await host.dispatch("increment", [1]);
    await host.dispatch("increment", [1]);

    expect(unstable).toHaveBeenCalledTimes(1);
    expect(stable).toHaveBeenCalledTimes(2);
  });

  it("clears disconnected owner marker once invocation ends", async () => {
    const host = createStoreHost(createCounterDefinition());
    const invocation = host.onInvokeStart("conn-owner-marker");

    host.cleanupConnection("conn-owner-marker");

    await expect(
      host.subscribe(() => undefined, {
        ownerConnectionId: "conn-owner-marker",
      }),
    ).rejects.toBeInstanceOf(NexusStoreDisconnectedError);

    host.onInvokeEnd(invocation);

    await expect(
      host.subscribe(() => undefined, {
        ownerConnectionId: "conn-owner-marker",
      }),
    ).resolves.toMatchObject({
      version: 0,
      state: { count: 0 },
    });
  });

  it("destroy clears invocation and disconnect owner bookkeeping maps", () => {
    const host = createStoreHost(createCounterDefinition());
    const invocation = host.onInvokeStart("conn-destroy-cleanup");

    host.cleanupConnection("conn-destroy-cleanup");
    host.onInvokeEnd(invocation);

    host.destroy();

    const runtime = host as any;
    expect(runtime.disconnectedConnections.size).toBe(0);
    expect(runtime.activeInvocationsByConnection.size).toBe(0);
  });
});

describe("state host runtime dispatch semantics", () => {
  it("rejects non-object initial state payload at host boundary", () => {
    const definition = defineNexusStore({
      token: new Token("state:counter:invalid-initial-state"),
      state: () => 123 as unknown as { count: number },
      actions: () => ({ noop: () => 0 }),
    });

    expect(() => createStoreHost(definition)).toThrowError(
      NexusStoreProtocolError,
    );
  });

  it("covers host missing-subscription cleanup branches", async () => {
    const host = createStoreHost(createCounterDefinition());
    const removedListener = vi.fn();
    const siblingListener = vi.fn();

    const removed = await host.subscribe(removedListener, {
      ownerConnectionId: "conn-a",
    });

    const sibling = await host.subscribe(siblingListener, {
      ownerConnectionId: "conn-b",
    });

    await host.unsubscribe("missing-subscription");
    await host.unsubscribe(removed.subscriptionId);

    await host.dispatch("increment", [1]);

    expect(removedListener).not.toHaveBeenCalled();
    expect(siblingListener).toHaveBeenCalledTimes(1);

    const dangling = await host.subscribe(() => {});
    (host as any).subscriptions.set(dangling.subscriptionId, {
      onSync: vi.fn(),
      ownerConnectionId: "conn-ghost",
    });
    await host.unsubscribe(dangling.subscriptionId);

    await host.unsubscribe(sibling.subscriptionId);
  });

  it("releases subscribe callback proxies on unsubscribe and destroy", async () => {
    const host = createStoreHost(createCounterDefinition());
    const releaseLeft = vi.fn();
    const releaseRight = vi.fn();

    const leftListener = Object.assign(vi.fn(), {
      [RELEASE_PROXY_SYMBOL]: releaseLeft,
    });
    const rightListener = Object.assign(vi.fn(), {
      [RELEASE_PROXY_SYMBOL]: releaseRight,
    });

    const left = await host.subscribe(leftListener);
    await host.subscribe(rightListener);

    await host.unsubscribe(left.subscriptionId);
    expect(releaseLeft).toHaveBeenCalledTimes(1);
    expect(releaseRight).toHaveBeenCalledTimes(0);

    host.destroy();
    expect(releaseLeft).toHaveBeenCalledTimes(1);
    expect(releaseRight).toHaveBeenCalledTimes(1);
  });

  it("rejects subscribe for already disconnected owner and unknown action dispatch", async () => {
    const host = createStoreHost(createCounterDefinition());
    const invocation = host.onInvokeStart("conn-stale-owner");

    host.cleanupConnection("conn-stale-owner");
    await expect(
      host.subscribe(() => undefined, {
        ownerConnectionId: "conn-stale-owner",
      }),
    ).rejects.toBeInstanceOf(NexusStoreDisconnectedError);
    host.onInvokeEnd(invocation);

    await expect(
      host.dispatch("missingAction" as any, []),
    ).rejects.toBeInstanceOf(NexusStoreProtocolError);
  });

  it("supports functional setState updater actions", async () => {
    const host = createStoreHost(
      defineNexusStore({
        token: new Token("state:counter:functional-set-state"),
        state: () => ({ count: 0 }),
        actions: ({ getState, setState }) => ({
          increment() {
            setState((current) => ({ count: current.count + 1 }));
            return getState().count;
          },
        }),
      }),
    );

    await expect(host.dispatch("increment", [])).resolves.toMatchObject({
      committedVersion: 1,
      result: 1,
    });
  });

  it("dispatch advances version monotonically", async () => {
    const host = createStoreHost(createCounterDefinition());
    const baseline = await host.subscribe(() => {});

    expect(baseline.version).toBe(0);
    await host.dispatch("increment", [1]);
    await host.dispatch("increment", [1]);

    const after = await host.subscribe(() => {});
    expect(after.version).toBe(2);
    expect(after.state.count).toBe(2);
  });

  it("host business error path does not corrupt versioned state", async () => {
    const host = createStoreHost(createCounterDefinition());
    const baseline = await host.subscribe(() => {});

    expect(baseline.version).toBe(0);
    await expect(host.dispatch("explode", [])).rejects.toMatchObject({
      name: "NexusStoreActionError",
      cause: expect.objectContaining({ message: "boom" }),
    } satisfies Partial<NexusStoreActionError>);
    await expect(host.dispatch("mutateThenExplode", [])).rejects.toMatchObject({
      name: "NexusStoreActionError",
      cause: expect.objectContaining({ message: "boom-after-mutate" }),
    } satisfies Partial<NexusStoreActionError>);

    const after = await host.subscribe(() => {});
    expect(after.version).toBe(0);
    expect(after.state).toEqual({ count: 0 });
  });

  it("host rollback is transactional for nested in-place mutation through getState", async () => {
    const definition = defineNexusStore({
      token: new Token("state:counter:host-rollback-nested-inplace"),
      state: () => ({ nested: { count: 0 } }),
      actions: ({ getState }) => ({
        mutateNestedThenThrow() {
          getState().nested.count += 1;
          throw new Error("nested-mutate-failed");
        },
      }),
    });

    const host = createStoreHost(definition);
    const before = await host.subscribe(() => {});

    await expect(
      host.dispatch("mutateNestedThenThrow", []),
    ).rejects.toMatchObject({
      name: "NexusStoreActionError",
      cause: expect.objectContaining({ message: "nested-mutate-failed" }),
    } satisfies Partial<NexusStoreActionError>);

    const after = await host.subscribe(() => {});
    expect(after.version).toBe(before.version);
    expect(after.state).toEqual({ nested: { count: 0 } });
  });

  it("serializes overlapping async dispatches without losing updates", async () => {
    const firstGate = deferred<void>();

    const definition = defineNexusStore({
      token: new Token("state:counter:host-dispatch-serialization"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        async addAfter(by: number, gate: Promise<void>) {
          const base = getState().count;
          await gate;
          setState({ count: base + by });
          return getState().count;
        },
      }),
    });

    const host = createStoreHost(definition);

    const first = host.dispatch("addAfter", [1, firstGate.promise]);
    const second = host.dispatch("addAfter", [2, Promise.resolve()]);

    firstGate.resolve();

    await expect(first).resolves.toMatchObject({
      type: "dispatch-result",
      committedVersion: 1,
      result: 1,
    });
    await expect(second).resolves.toMatchObject({
      type: "dispatch-result",
      committedVersion: 2,
      result: 3,
    });

    const after = await host.subscribe(() => {});
    expect(after.version).toBe(2);
    expect(after.state).toEqual({ count: 3 });
  });

  it("rejects invalid dispatch request envelope at runtime boundary", async () => {
    const host = createStoreHost(createCounterDefinition());

    await expect(
      host.dispatch("increment", "not-array" as unknown as [number]),
    ).rejects.toBeInstanceOf(NexusStoreProtocolError);
  });

  it("validates host action result payload when author provides schema", async () => {
    const host = createStoreHost(
      defineNexusStore({
        token: new Token("state:counter:host-action-result-validation"),
        state: () => ({ count: 0 }),
        actions: ({ getState, setState }) => ({
          increment(by: number) {
            setState({ count: getState().count + by });
            return "invalid" as unknown as number;
          },
        }),
        validation: {
          actionResults: {
            increment: z.number(),
          },
        },
      }),
    );

    const before = await host.subscribe(() => {});
    await expect(host.dispatch("increment", [1])).rejects.toBeInstanceOf(
      NexusStoreProtocolError,
    );
    const after = await host.subscribe(() => {});
    expect(after.version).toBe(before.version);
    expect(after.state).toEqual(before.state);
  });
});
