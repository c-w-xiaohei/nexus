import { afterEach, describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import { PendingCallManager } from "./pending-call-manager";

describe("PendingCallManager", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves the concrete response value for its registered connection", async () => {
    const manager = new PendingCallManager();
    const pending = manager.register(1, { connectionId: "A", timeout: 1_000 });

    manager.handleResponse(1, { answer: 42 }, null, "A");

    await expect(pending).resolves.toEqual(Result.ok({ answer: 42 }));
  });

  it("ignores a response sent by another connection", async () => {
    vi.useFakeTimers();
    const manager = new PendingCallManager();
    const pending = manager.register(1, { connectionId: "A", timeout: 100 });

    manager.handleResponse(1, "wrong session", null, "B");
    expect(manager.canHandleResponse(1, "A")).toBe(true);
    vi.advanceTimersByTime(100);

    const result = await pending;
    expect(result.isErr()).toBe(true);
    expect(result.error.code).toBe("E_CALL_TIMEOUT");
  });

  it("ignores duplicate and orphan responses after the first settlement", async () => {
    const manager = new PendingCallManager();
    const pending = manager.register(1, { connectionId: "A", timeout: 1_000 });

    manager.handleResponse(1, "first", null, "A");
    manager.handleResponse(1, "duplicate", null, "A");
    manager.handleResponse(2, "orphan", null, "A");

    await expect(pending).resolves.toEqual(Result.ok("first"));
    expect(manager.canHandleResponse(1, "A")).toBe(false);
  });

  it("revives framework response errors instead of wrapping them as remote errors", async () => {
    const manager = new PendingCallManager();
    const pending = manager.register(1, { connectionId: "A", timeout: 1_000 });

    manager.handleResponse(
      1,
      null,
      {
        name: "NexusDisconnectedError",
        code: "E_CONN_CLOSED",
        message: "peer closed",
        origin: "framework",
      },
      "A",
    );

    const result = await pending;
    expect(result.isErr()).toBe(true);
    expect(result.error.code).toBe("E_CONN_CLOSED");
  });

  it("fails every pending call for a disconnected connection", async () => {
    const manager = new PendingCallManager();
    const first = manager.register(1, { connectionId: "A", timeout: 1_000 });
    const other = manager.register(2, { connectionId: "B", timeout: 1_000 });

    manager.onDisconnect("A");

    const result = await first;
    expect(result.isErr()).toBe(true);
    expect(result.error.code).toBe("E_CONN_CLOSED");
    expect(manager.canHandleResponse(2, "B")).toBe(true);
    manager.handleResponse(2, "still open", null, "B");
    await expect(other).resolves.toEqual(Result.ok("still open"));
  });

  it("clears its timer when the response settles", async () => {
    vi.useFakeTimers();
    const manager = new PendingCallManager();
    const pending = manager.register(1, { connectionId: "A", timeout: 1_000 });

    manager.handleResponse(1, "settled", null, "A");

    await expect(pending).resolves.toEqual(Result.ok("settled"));
    expect(vi.getTimerCount()).toBe(0);
  });
});
