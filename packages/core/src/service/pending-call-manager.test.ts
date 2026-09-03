import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_PROXY_SYMBOL } from "../types/symbols";
import { PendingCallManager } from "./pending-call-manager";

describe("PendingCallManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("orders all results by private target order without exposing connection IDs", async () => {
    const manager = PendingCallManager.create();
    const pending = manager.register(1, {
      strategy: "all",
      isBroadcast: true,
      sentConnectionIds: ["first", "second"],
      timeout: 1_000,
    }) as Promise<unknown[]>;
    manager.handleResponse(1, "second", null, "second");
    manager.handleResponse(1, "first", null, "first");
    await expect(pending).resolves.toEqual([
      { status: "fulfilled", value: "first" },
      { status: "fulfilled", value: "second" },
    ]);
  });

  it("keeps stream result order while hiding recipient IDs", async () => {
    const manager = PendingCallManager.create();
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
    const manager = PendingCallManager.create();
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
    const manager = PendingCallManager.create();
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
    const manager = PendingCallManager.create();
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
    const manager = PendingCallManager.create();
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

  it("rejects a disconnected unicast call", async () => {
    const manager = PendingCallManager.create();
    const pending = manager.register(1, {
      strategy: "all",
      isBroadcast: false,
      sentConnectionIds: ["only"],
      timeout: 1_000,
    }) as Promise<unknown[]>;
    manager.onDisconnect("only");
    await expect(pending).rejects.toMatchObject({ code: "E_CONN_CLOSED" });
  });

  it("ignores a disconnected recipient's late response until another all recipient responds", async () => {
    const manager = PendingCallManager.create();
    const pending = manager.register(1, {
      strategy: "all",
      isBroadcast: true,
      sentConnectionIds: ["A", "B"],
      timeout: 1_000,
    }) as Promise<unknown[]>;

    manager.onDisconnect("A");
    expect(manager.canHandleResponse(1, "A")).toBe(false);
    manager.handleResponse(1, "late-A", null, "A");
    manager.handleResponse(1, "from-B", null, "B");

    await expect(pending).resolves.toEqual([
      { status: "fulfilled", value: "from-B" },
    ]);
  });

  it("ignores a disconnected recipient's late stream response until another recipient responds", async () => {
    const manager = PendingCallManager.create();
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
