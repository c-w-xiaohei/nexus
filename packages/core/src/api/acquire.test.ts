import { describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import { safeConnect, safeConnectMulticast } from "./acquire";
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
        new Map(),
        null,
        undefined,
        vi.fn(),
      )
    ).unwrap();

    expect(built.connectionManager).toBeDefined();
    expect(built.engine).toBeDefined();
  });
});
