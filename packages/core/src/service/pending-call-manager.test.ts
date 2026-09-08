import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_PROXY_SYMBOL } from "../types/symbols";
import { PendingCallManager } from "./pending-call-manager";
import { Result } from "better-result";

describe("PendingCallManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves timeout and all-disconnected collect semantics", async () => {
    vi.useFakeTimers();
    const manager = new PendingCallManager();
    const unicast = manager.register(1, {
      strategy: "all",
      isBroadcast: false,
      sentConnectionIds: ["A"],
      timeout: 100,
    });
    const multicast = manager.register(2, {
      strategy: "all",
      isBroadcast: true,
      sentConnectionIds: ["A", "B"],
      timeout: 100,
    });
    manager.handleResponse(2, "B", null, "B");
    vi.advanceTimersByTime(100);
    expect(await unicast).toMatchObject({ error: { code: "E_CALL_TIMEOUT" } });
    expect(await multicast).toEqual(
      Result.ok([{ status: "fulfilled", value: "B" }]),
    );
    const disconnected = manager.register(3, {
      strategy: "all",
      isBroadcast: true,
      sentConnectionIds: ["A", "B"],
      timeout: 100,
    });
    manager.onDisconnect("A");
    manager.onDisconnect("B");
    expect(await disconnected).toMatchObject({
      error: { code: "E_CONN_CLOSED" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles waiting stream readers on cancellation without affecting another manager", async () => {
    vi.useFakeTimers();
    const first = new PendingCallManager();
    const second = new PendingCallManager();
    const options = {
      strategy: "stream" as const,
      isBroadcast: true,
      sentConnectionIds: ["A"],
      timeout: 100,
    };
    const stream = first.register(1, options);
    const other = second.register(1, options);
    const reading = stream.next();
    await stream.return?.();
    expect(await reading).toEqual({ done: true, value: undefined });
    expect(second.canHandleResponse(1, "A")).toBe(true);
    second.handleResponse(1, "value", null, "A");
    expect(await other.next()).toEqual({
      done: false,
      value: { status: "fulfilled", value: "value" },
    });
    expect(await other.next()).toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("orders all results by private target order without exposing connection IDs", async () => {
    const manager = new PendingCallManager();
    const pending = manager.register(1, {
      strategy: "all",
      isBroadcast: true,
      sentConnectionIds: ["first", "second"],
      timeout: 1_000,
    });
    manager.handleResponse(1, "second", null, "second");
    manager.handleResponse(1, "first", null, "first");
    await expect(pending).resolves.toEqual(
      Result.ok([
        { status: "fulfilled", value: "first" },
        { status: "fulfilled", value: "second" },
      ]),
    );
  });

  it("keeps stream result order while hiding recipient IDs", async () => {
    const manager = new PendingCallManager();
    const stream = manager.register(1, {
      strategy: "stream",
      isBroadcast: true,
      sentConnectionIds: ["first", "second"],
      timeout: 1_000,
    }) as AsyncIterable<unknown>;
    manager.handleResponse(1, "second", null, "second");
    manager.handleResponse(1, "first", null, "first");
    const results: unknown[] = [];
    for await (const result of stream) results.push(result);
    expect(results).toEqual([
      { status: "fulfilled", value: "first" },
      { status: "fulfilled", value: "second" },
    ]);
  });

  it("cancels a stream after an early iteration break", async () => {
    vi.useFakeTimers();
    const manager = new PendingCallManager();
    const stream = manager.register(1, {
      strategy: "stream",
      isBroadcast: true,
      sentConnectionIds: ["first", "second"],
      timeout: 1_000,
    }) as AsyncIterable<unknown>;

    manager.handleResponse(1, "first", null, "first");
    for await (const result of stream) {
      expect(result).toEqual({ status: "fulfilled", value: "first" });
      break;
    }

    expect(manager.canHandleResponse(1, "second")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    manager.handleResponse(1, "late", null, "second");
  });

  it("releases queued nested resource proxies when a finished stream is cancelled", async () => {
    const manager = new PendingCallManager();
    const releaseDelivered = vi.fn();
    const releaseQueuedFunction = vi.fn();
    const releaseQueuedObject = vi.fn();
    const deliveredResource = Object.assign(() => undefined, {
      [RELEASE_PROXY_SYMBOL]: releaseDelivered,
    });
    const queuedFunctionResource = Object.assign(() => undefined, {
      [RELEASE_PROXY_SYMBOL]: releaseQueuedFunction,
    });
    const queuedObjectResource = {
      [RELEASE_PROXY_SYMBOL]: releaseQueuedObject,
    };
    const stream = manager.register(1, {
      strategy: "stream",
      isBroadcast: true,
      sentConnectionIds: ["first", "second"],
      timeout: 1_000,
    }) as AsyncIterable<unknown>;

    const queuedValue = Object.assign(Object.create(null) as object, {
      nested: [
        queuedFunctionResource,
        Object.assign(Object.create(null) as object, {
          resource: queuedFunctionResource,
        }),
        queuedObjectResource,
      ],
    });
    manager.handleResponse(1, queuedValue, null, "second");
    manager.handleResponse(1, deliveredResource, null, "first");

    for await (const result of stream) {
      expect(result).toEqual({ status: "fulfilled", value: deliveredResource });
      break;
    }

    expect(releaseDelivered).not.toHaveBeenCalled();
    expect(releaseQueuedFunction).toHaveBeenCalledTimes(1);
    expect(releaseQueuedObject).toHaveBeenCalledTimes(1);
  });

  it("releases a resource repeated across discarded stream results once", async () => {
    const manager = new PendingCallManager();
    const release = vi.fn();
    const resource = Object.assign(() => undefined, {
      [RELEASE_PROXY_SYMBOL]: release,
    });
    const stream = manager.register(1, {
      strategy: "stream",
      isBroadcast: true,
      sentConnectionIds: ["first", "second", "third"],
      timeout: 1_000,
    }) as AsyncIterable<unknown>;

    manager.handleResponse(1, resource, null, "second");
    manager.handleResponse(1, resource, null, "third");
    manager.handleResponse(1, "first", null, "first");

    for await (const result of stream) {
      expect(result).toEqual({ status: "fulfilled", value: "first" });
      break;
    }

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("makes stream return idempotent and resolves pending pulls as done", async () => {
    vi.useFakeTimers();
    const manager = new PendingCallManager();
    const stream = manager.register(1, {
      strategy: "stream",
      isBroadcast: true,
      sentConnectionIds: ["only"],
      timeout: 1_000,
    }) as AsyncIterableIterator<unknown>;
    const pendingPull = stream.next();

    await expect(stream.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(stream.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(pendingPull).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(manager.canHandleResponse(1, "only")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases queued and ordering-buffered capabilities together on cancellation", async () => {
    vi.useFakeTimers();
    const manager = new PendingCallManager();
    const release = vi.fn();
    const resource = Object.assign(() => undefined, {
      [RELEASE_PROXY_SYMBOL]: release,
    });
    const stream = manager.register(1, {
      strategy: "stream",
      isBroadcast: true,
      sentConnectionIds: ["A", "B", "C", "D"],
      timeout: 1_000,
    }) as AsyncIterableIterator<unknown>;
    manager.handleResponse(1, "delivered", null, "A");
    manager.handleResponse(1, resource, null, "B");
    manager.handleResponse(1, resource, null, "D");
    await stream.next();
    await stream.return?.();
    expect(release).toHaveBeenCalledOnce();
    expect(manager.canHandleResponse(1, "C")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a capability blocked entirely in the ordering buffer", async () => {
    const manager = new PendingCallManager();
    const release = vi.fn();
    const resource = Object.assign(() => undefined, {
      [RELEASE_PROXY_SYMBOL]: release,
    });
    const stream = manager.register(1, {
      strategy: "stream",
      isBroadcast: true,
      sentConnectionIds: ["A", "B"],
      timeout: 1_000,
    }) as AsyncIterableIterator<unknown>;
    manager.handleResponse(1, resource, null, "B");
    await stream.return?.();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a disconnected unicast call", async () => {
    const manager = new PendingCallManager();
    const pending = manager.register(1, {
      strategy: "all",
      isBroadcast: false,
      sentConnectionIds: ["only"],
      timeout: 1_000,
    });
    manager.onDisconnect("only");
    await expect(pending).resolves.toMatchObject({
      error: { code: "E_CONN_CLOSED" },
    });
  });

  it("does not release a buffered result delivered after stream timeout", async () => {
    vi.useFakeTimers();
    const manager = new PendingCallManager();
    const release = vi.fn();
    const resource = { [RELEASE_PROXY_SYMBOL]: release };
    const stream = manager.register(1, {
      strategy: "stream",
      isBroadcast: true,
      sentConnectionIds: ["A", "B"],
      timeout: 1_000,
    });
    manager.handleResponse(1, resource, null, "B");
    vi.advanceTimersByTime(1_000);
    expect(await stream.next()).toEqual({
      done: false,
      value: { status: "fulfilled", value: resource },
    });
    await stream.return?.();
    expect(release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["all", "stream"] as const)(
    "releases undeliverable %s results after dispatch failure",
    async (strategy) => {
      vi.useFakeTimers();
      const manager = new PendingCallManager();
      const options = {
        isBroadcast: true,
        sentConnectionIds: ["A", "B"],
        timeout: 1_000,
      };
      const pending =
        strategy === "all"
          ? manager.register(1, { ...options, strategy })
          : manager.register(1, { ...options, strategy });
      const release = vi.fn();
      manager.handleResponse(1, { [RELEASE_PROXY_SYMBOL]: release }, null, "A");
      const error = new Error("B send failed");
      manager.fail(1, error);
      if (pending instanceof Promise)
        expect(await pending).toMatchObject({ error });
      else
        expect(await pending.next()).toEqual({ done: true, value: undefined });
      expect(release).toHaveBeenCalledOnce();
      expect(manager.canHandleResponse(1, "B")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not count a responded recipient again when it disconnects", async () => {
    const manager = new PendingCallManager();
    const pending = manager.register(1, {
      strategy: "all",
      isBroadcast: true,
      sentConnectionIds: ["A", "B"],
      timeout: 1_000,
    });
    manager.handleResponse(1, "A", null, "A");
    manager.onDisconnect("A");
    expect(manager.canHandleResponse(1, "B")).toBe(true);
    manager.handleResponse(1, "duplicate", null, "A");
    manager.handleResponse(1, "B", null, "B");
    expect(await pending).toEqual(
      Result.ok([
        { status: "fulfilled", value: "A" },
        { status: "fulfilled", value: "B" },
      ]),
    );
  });

  it("ignores a disconnected recipient's late response until another all recipient responds", async () => {
    const manager = new PendingCallManager();
    const pending = manager.register(1, {
      strategy: "all",
      isBroadcast: true,
      sentConnectionIds: ["A", "B"],
      timeout: 1_000,
    });

    manager.onDisconnect("A");
    expect(manager.canHandleResponse(1, "A")).toBe(false);
    manager.handleResponse(1, "late-A", null, "A");
    manager.handleResponse(1, "from-B", null, "B");

    await expect(pending).resolves.toEqual(
      Result.ok([{ status: "fulfilled", value: "from-B" }]),
    );
  });

  it("ignores a disconnected recipient's late stream response until another recipient responds", async () => {
    const manager = new PendingCallManager();
    const stream = manager.register(1, {
      strategy: "stream",
      isBroadcast: true,
      sentConnectionIds: ["A", "B"],
      timeout: 1_000,
    }) as AsyncIterable<unknown>;

    manager.onDisconnect("A");
    expect(manager.canHandleResponse(1, "A")).toBe(false);
    manager.handleResponse(1, "late-A", null, "A");
    manager.handleResponse(1, "from-B", null, "B");

    const results: unknown[] = [];
    for await (const result of stream) results.push(result);
    expect(results).toEqual([{ status: "fulfilled", value: "from-B" }]);
  });
});
