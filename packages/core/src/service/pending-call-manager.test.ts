import { describe, expect, it } from "vitest";
import { PendingCallManager } from "./pending-call-manager";

describe("PendingCallManager", () => {
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
});
