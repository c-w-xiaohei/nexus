import { describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import {
  safeConnect,
  safeConnectMulticast,
  type AcquisitionSource,
} from "./acquire";
import type { ConnectionManager } from "@/connection/connection-manager";
import { NexusConfigurationError } from "@/errors";
import { buildKernel } from "./kernel";

type TestModel = {
  contextMeta: { context: "bg" | "cs" };
  connectionMeta: object;
  connectionTarget: { context: "bg" } | { context: "cs"; id: string };
};

describe("connection acquisition boundaries", () => {
  it("rejects cancelled requests before asking Nexus to initialize", async () => {
    const ready =
      vi.fn<() => Promise<Result<ConnectionManager<TestModel>, Error>>>();
    const signal = AbortSignal.abort();

    expect(await safeConnect(ready, { signal })).toMatchObject({
      error: { code: "E_ABORTED" },
    });
    expect(await safeConnectMulticast(ready, { signal })).toMatchObject({
      error: { code: "E_ABORTED" },
    });
    expect(ready).not.toHaveBeenCalled();
  });

  it("includes bootstrap in acquisition timeouts and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const ready = vi.fn(
        () =>
          new Promise<Result<ConnectionManager<TestModel>, Error>>(() => {}),
      );
      const result = safeConnect(ready, {
        target: { context: "bg" },
        timeout: 20,
      });

      await vi.advanceTimersByTimeAsync(20);
      expect(await result).toMatchObject({
        error: { code: "E_SERVICE_ACQUISITION_TIMEOUT" },
      });
      expect(ready).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a bootstrap failure and removes the acquisition deadline", async () => {
    vi.useFakeTimers();
    try {
      const failure = new NexusConfigurationError("bootstrap failed");
      const ready = async (): Promise<
        Result<ConnectionManager<TestModel>, Error>
      > => Result.err(failure);

      const result = await safeConnectMulticast(ready, {
        targets: [{ context: "bg" }],
      });
      expect(result.isErr() && result.error).toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds a ready kernel without legacy acquisition defaults", async () => {
    const built = (
      await buildKernel<TestModel>(
        {
          endpoint: {
            meta: { context: "bg" },
            implementation: { listen() {} },
          },
        },
        [],
        null,
        vi.fn(),
      )
    ).unwrap();

    expect(built.connectionManager).toBeDefined();
    expect(built.engine).toBeDefined();
  });

  it("returns a fast target failure while an earlier target remains pending", async () => {
    const source: AcquisitionSource<TestModel> = {
      findReadyConnections: () => [],
      safeResolveConnections: async ({ target }) =>
        target.context === "bg"
          ? new Promise(() => {})
          : Result.err(new Error("missing content")),
      subscribeAvailabilityChanged: () => () => {},
    };
    const result = await safeConnectMulticast(async () => Result.ok(source), {
      targets: [{ context: "bg" }, { context: "cs", id: "one" }],
    });

    expect(result).toMatchObject({ error: { code: "E_SERVICE_UNAVAILABLE" } });
  });

  it("does not return an empty multicast snapshot after its predicate aborts", async () => {
    const controller = new AbortController();
    const source: AcquisitionSource<TestModel> = {
      findReadyConnections: () => [
        {
          connectionId: "content",
          remoteIdentity: { context: "cs" },
          context: { connection: {} },
          isReady: () => true,
        },
        {
          connectionId: "content-2",
          remoteIdentity: { context: "cs" },
          context: { connection: {} },
          isReady: () => true,
        },
      ],
      safeResolveConnections: async () => Result.ok([]),
      subscribeAvailabilityChanged: () => () => {},
    };

    const where = vi.fn(() => {
      controller.abort();
      return false;
    });
    const result = await safeConnectMulticast(async () => Result.ok(source), {
      signal: controller.signal,
      where,
    });

    expect(result).toMatchObject({ error: { code: "E_ABORTED" } });
    expect(where).toHaveBeenCalledOnce();
  });

  it("rejects a selected target that disconnects during its predicate", async () => {
    let ready = true;
    const source: AcquisitionSource<TestModel> = {
      findReadyConnections: () => [],
      safeResolveConnections: async () =>
        Result.ok([
          {
            connectionId: "background",
            remoteIdentity: { context: "bg" },
            context: { connection: {} },
            isReady: () => ready,
          },
        ]),
      subscribeAvailabilityChanged: () => () => {},
    };

    const result = await safeConnect(async () => Result.ok(source), {
      target: { context: "bg" },
      where: () => {
        ready = false;
        return true;
      },
    });

    expect(result).toMatchObject({ error: { code: "E_SERVICE_UNAVAILABLE" } });
  });

  it("stops invoking target predicates after aborting the request", async () => {
    const controller = new AbortController();
    const source: AcquisitionSource<TestModel> = {
      findReadyConnections: () => [],
      safeResolveConnections: async ({ target }) =>
        Result.ok([
          {
            connectionId: target.context,
            remoteIdentity: { context: target.context },
            context: { connection: {} },
            isReady: () => true,
          },
        ]),
      subscribeAvailabilityChanged: () => () => {},
    };
    const where = vi.fn(() => {
      controller.abort();
      return true;
    });

    const result = await safeConnectMulticast(async () => Result.ok(source), {
      signal: controller.signal,
      targets: [{ context: "bg" }, { context: "cs", id: "one" }],
      where,
    });

    expect(result).toMatchObject({ error: { code: "E_ABORTED" } });
    expect(where).toHaveBeenCalledOnce();
  });
});
