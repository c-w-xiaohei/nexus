import { describe, expect, it, vi } from "vitest";
import { createRemoteStore } from "./remote-store";
import { safeInvokeStoreAction } from "./connect-store";
import {
  NexusStoreActionError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
} from "./errors";

type State = { count: number };
type Actions = { increment(by: number): number };

describe("State mirror", () => {
  it("applies init and snapshots through onSync", () => {
    const remote = createRemoteStore<State & Actions>();
    const unsubscribe = vi.fn();
    const increment = vi.fn(async (by: number) => by);
    const changes = vi.fn();
    remote.store.subscribe(changes);
    remote.onSync({
      type: "init",
      storeInstanceId: "one",
      version: 0,
      state: { count: 0 },
      actions: { increment },
      unsubscribe,
    });
    const baseline = remote.store.getState();
    expect(changes).toHaveBeenLastCalledWith(baseline, baseline);
    remote.onSync({
      type: "snapshot",
      storeInstanceId: "one",
      version: 1,
      state: { count: 1 },
    });
    expect(changes).toHaveBeenLastCalledWith(remote.store.getState(), baseline);
    expect(remote.safeReady().isOk()).toBe(true);
    expect(remote.store.getState()).toEqual({ count: 1 });
    remote.store.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("buffers early snapshots and freezes a handle after instance replacement", () => {
    const remote = createRemoteStore<State & Actions>();
    remote.onSync({
      type: "snapshot",
      storeInstanceId: "one",
      version: 1,
      state: { count: 1 },
    });
    remote.onSync({
      type: "init",
      storeInstanceId: "one",
      version: 0,
      state: { count: 0 },
      actions: {},
      unsubscribe: vi.fn(),
    });
    expect(remote.store.getState()).toEqual({ count: 1 });
    expect(() =>
      remote.onSync({
        type: "snapshot",
        storeInstanceId: "two",
        version: 2,
        state: { count: 2 },
      }),
    ).toThrowError(NexusStoreDisconnectedError);
    expect(remote.store.getStatus().type).toBe("stale");
    remote.store.destroy();
  });

  it("keeps init action capabilities and their Core errors unchanged", async () => {
    const coreError = Object.assign(new Error("released resource"), {
      code: "E_RESOURCE_ACCESS_DENIED",
    });
    const action = vi.fn(async () => {
      throw coreError;
    });
    const remote = createRemoteStore<State & Actions>();
    remote.onSync({
      type: "init",
      storeInstanceId: "one",
      version: 0,
      state: { count: 0 },
      actions: { increment: action },
      unsubscribe: vi.fn(),
    });
    expect(remote.store.actions.increment).toBe(action);
    await expect(remote.store.actions.increment(1)).rejects.toBe(coreError);
    remote.store.destroy();
  });

  it("safely invokes the original action and preserves structured failures", async () => {
    const remote = createRemoteStore<State & Actions>();
    const increment = vi.fn(async (by: number) => by * 2);
    remote.onSync({
      type: "init",
      storeInstanceId: "one",
      version: 0,
      state: { count: 0 },
      actions: { increment },
      unsubscribe: vi.fn(),
    });
    const result = await safeInvokeStoreAction(remote.store, "increment", [3]);
    expect(result.unwrap()).toBe(6);
    expect(increment).toHaveBeenCalledExactlyOnceWith(3);
    for (const cause of [
      new NexusStoreActionError("action failed"),
      new NexusStoreDisconnectedError("disconnected"),
      new NexusStoreProtocolError("invalid result"),
      new Error("core failure"),
    ]) {
      increment.mockRejectedValueOnce(cause);
      const failed = await safeInvokeStoreAction(
        remote.store,
        "increment",
        [1],
      );
      expect(failed.isErr()).toBe(true);
      if (failed.isErr()) {
        if (cause.constructor === Error) {
          expect(failed.error.code).toBe("E_STORE_ACTION");
          expect(failed.error.cause).toBe(cause);
        } else expect(failed.error).toBe(cause);
      }
    }
    expect(remote.store.getStatus().type).toBe("ready");
    remote.store.destroy();
  });

  it("transitions status and rejects state access before init", () => {
    const remote = createRemoteStore<State & Actions>();
    expect(() => remote.store.getState()).toThrowError(
      NexusStoreDisconnectedError,
    );
    const status = vi.fn();
    remote.store.subscribeStatus(status);
    remote.disconnect("closed");
    expect(remote.store.getStatus()).toMatchObject({ type: "disconnected" });
    expect(status).toHaveBeenCalledOnce();
    expect(() => remote.store.getState()).toThrowError(
      NexusStoreDisconnectedError,
    );
    remote.store.destroy();
  });

  it("rejects an uncloneable init as a protocol error and reclaims its capabilities", () => {
    const remote = createRemoteStore<State & Actions>();
    const unsubscribe = vi.fn();
    expect(() =>
      remote.onSync({
        type: "init",
        storeInstanceId: "uncloneable",
        version: 0,
        state: { count: 0, invalid: () => undefined },
        actions: {},
        unsubscribe,
      }),
    ).toThrowError(expect.objectContaining({ code: "E_STORE_PROTOCOL" }));
    expect(remote.store.getStatus().type).toBe("disconnected");
    expect(unsubscribe).toHaveBeenCalledOnce();
    remote.store.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
