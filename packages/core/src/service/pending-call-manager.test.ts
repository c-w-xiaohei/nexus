import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { PendingCallManager } from "./pending-call-manager";
import type { SerializedError } from "@/types/message";
import { NexusCallTimeoutError, NexusDisconnectedError } from "@/errors";

describe("PendingCallManager", () => {
  let manager: PendingCallManager;

  beforeEach(() => {
    manager = new PendingCallManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('register and handleResponse ("all" strategy)', () => {
    it("should resolve a promise for a single successful response", async () => {
      const promise = manager.register(1, {
        strategy: "all",
        isBroadcast: false,
        sentConnectionIds: ["conn-1"],
        timeout: 1000,
      });

      manager.handleResponse(1, "success", null, "conn-1");

      await expect(promise).resolves.toEqual([
        { status: "fulfilled", value: "success", from: "conn-1" },
      ]);
    });

    it("should reject a promise for a single error response", async () => {
      const promise = manager.register(1, {
        strategy: "all",
        isBroadcast: false,
        sentConnectionIds: ["conn-1"],
        timeout: 1000,
      });

      const error: SerializedError = {
        name: "Error",
        message: "Failure",
      };
      manager.handleResponse(1, null, error, "conn-1");

      // For 'all' strategy, even single-target errors are aggregated.
      await expect(promise).resolves.toEqual([
        { status: "rejected", reason: error, from: "conn-1" },
      ]);
    });

    it("should handle timeouts for single calls", async () => {
      const promise = manager.register(1, {
        strategy: "all",
        isBroadcast: false,
        sentConnectionIds: ["conn-1"],
        timeout: 1000,
      });

      vi.advanceTimersByTime(1001);

      await expect(promise).rejects.toBeInstanceOf(NexusCallTimeoutError);
    });

    it("should aggregate results for a broadcast call", async () => {
      const promise = manager.register(1, {
        strategy: "all",
        isBroadcast: true,
        sentConnectionIds: ["conn-1", "conn-2"],
        timeout: 1000,
      });

      manager.handleResponse(1, "res-1", null, "conn-1");
      manager.handleResponse(1, "res-2", null, "conn-2");

      await expect(promise).resolves.toEqual([
        { status: "fulfilled", value: "res-1", from: "conn-1" },
        { status: "fulfilled", value: "res-2", from: "conn-2" },
      ]);
    });

    it("should resolve with partial results on broadcast timeout", async () => {
      const promise = manager.register(1, {
        strategy: "all",
        isBroadcast: true,
        sentConnectionIds: ["conn-1", "conn-2"],
        timeout: 1000,
      });

      manager.handleResponse(1, "res-1", null, "conn-1");
      vi.advanceTimersByTime(1001);

      await expect(promise).resolves.toEqual([
        { status: "fulfilled", value: "res-1", from: "conn-1" },
      ]);
    });
  });

  describe('register and handleResponse ("stream" strategy)', () => {
    it("should push results to the async iterator", async () => {
      const stream = manager.register(1, {
        strategy: "stream",
        isBroadcast: true,
        sentConnectionIds: ["conn-1", "conn-2"],
        timeout: 1000,
      }) as AsyncIterable<any>;

      manager.handleResponse(1, "res-1", null, "conn-1");
      manager.handleResponse(1, "res-2", null, "conn-2");

      const results = [];
      for await (const res of stream) {
        results.push(res);
      }
      expect(results).toEqual([
        { status: "fulfilled", value: "res-1", from: "conn-1" },
        { status: "fulfilled", value: "res-2", from: "conn-2" },
      ]);
    });

    it("should end the stream when all responses are received", async () => {
      const stream = manager.register(1, {
        strategy: "stream",
        isBroadcast: true,
        sentConnectionIds: ["conn-1"],
        timeout: 1000,
      }) as AsyncIterable<any>;

      const onEnd = vi.fn();
      const iterator = stream[Symbol.asyncIterator]();
      iterator.next().then(onEnd); // Consume the result

      manager.handleResponse(1, "res-1", null, "conn-1");
      await vi.waitFor(() => {
        expect(onEnd).toHaveBeenCalledWith({
          value: { status: "fulfilled", value: "res-1", from: "conn-1" },
          done: false,
        });
      });

      const endPromise = iterator.next();
      await vi.waitFor(async () => {
        const endResult = await endPromise;
        expect(endResult.done).toBe(true);
      });
    });

    it("should end the stream on timeout", async () => {
      const stream = manager.register(1, {
        strategy: "stream",
        isBroadcast: true,
        sentConnectionIds: ["conn-1", "conn-2"],
        timeout: 1000,
      }) as AsyncIterable<any>;
      const onEnd = vi.fn();

      const iterator = stream[Symbol.asyncIterator]();
      const p1 = iterator.next().then(onEnd);
      const p2 = iterator.next().then(onEnd);

      manager.handleResponse(1, "res-1", null, "conn-1");
      vi.advanceTimersByTime(1001);

      await p1;
      await p2;

      expect(onEnd).toHaveBeenCalledTimes(2);
      expect(onEnd).toHaveBeenCalledWith({
        value: { status: "fulfilled", value: "res-1", from: "conn-1" },
        done: false,
      });
      expect(onEnd).toHaveBeenCalledWith({ value: undefined, done: true });
    });
  });

  describe("onDisconnect", () => {
    it("should reject a pending call for a disconnected unicast target", async () => {
      const promise = manager.register(1, {
        strategy: "all",
        isBroadcast: false,
        sentConnectionIds: ["conn-1"],
        timeout: 1000,
      });

      manager.onDisconnect("conn-1");

      await expect(promise).rejects.toBeInstanceOf(NexusDisconnectedError);
    });

    it("should adjust expectations for a broadcast call and resolve if complete", async () => {
      const promise = manager.register(1, {
        strategy: "all",
        isBroadcast: true,
        sentConnectionIds: ["conn-1", "conn-2"],
        timeout: 1000,
      });

      manager.handleResponse(1, "res-1", null, "conn-1");
      manager.onDisconnect("conn-2");

      await expect(promise).resolves.toEqual([
        { status: "fulfilled", value: "res-1", from: "conn-1" },
      ]);
    });

    it("should adjust expectations for a stream call and end if complete", async () => {
      const stream = manager.register(1, {
        strategy: "stream",
        isBroadcast: true,
        sentConnectionIds: ["conn-1", "conn-2"],
        timeout: 1000,
      }) as AsyncIterable<any>;

      const onEnd = vi.fn();
      const iterator = stream[Symbol.asyncIterator]();
      const p1 = iterator.next().then(onEnd);
      const p2 = iterator.next().then(onEnd);

      manager.handleResponse(1, "res-1", null, "conn-1");
      manager.onDisconnect("conn-2");

      await p1;
      await p2;

      expect(onEnd).toHaveBeenCalledTimes(2);
      expect(onEnd).toHaveBeenCalledWith({
        value: { status: "fulfilled", value: "res-1", from: "conn-1" },
        done: false,
      });
      expect(onEnd).toHaveBeenCalledWith({ value: undefined, done: true });
    });

    it("should not affect calls unrelated to the disconnected connection", async () => {
      const promise1 = manager.register(1, {
        strategy: "all",
        isBroadcast: false,
        sentConnectionIds: ["conn-1"],
        timeout: 1000,
      });
      const promise2 = manager.register(2, {
        strategy: "all",
        isBroadcast: false,
        sentConnectionIds: ["conn-2"],
        timeout: 1000,
      });

      manager.onDisconnect("conn-1");

      await expect(promise1).rejects.toThrow();
      manager.handleResponse(2, "success", null, "conn-2");
      await expect(promise2).resolves.toEqual([
        { status: "fulfilled", value: "success", from: "conn-2" },
      ]);
    });
  });
});
