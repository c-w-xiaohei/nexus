import { beforeEach, describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import { CallProcessor, type DispatchCallOptions } from "./call-processor";
import { PendingCallManager } from "./pending-call-manager";
import { PayloadProcessor } from "./payload/payload-processor";
import { ResourceManager } from "./resource-manager";
import { ProxyFactory } from "./proxy-factory";
import { NexusDisconnectedError, NexusRemoteError } from "@/errors/call-errors";
import type { Connection } from "@/api/connection";

describe("CallProcessor", () => {
  let deps: ConstructorParameters<typeof CallProcessor>[0];
  let processor: CallProcessor;
  let resources: ResourceManager;

  const call = (
    overrides: Partial<DispatchCallOptions> = {},
  ): DispatchCallOptions => ({
    connectionId: "A",
    timeout: 1_000,
    type: "APPLY",
    resourceId: null,
    path: ["service", "method"],
    args: [],
    ...overrides,
  });

  beforeEach(() => {
    resources = new ResourceManager();
    const proxies = new ProxyFactory(
      {
        safeDispatchCall: async () => Result.ok(undefined),
        dispatchRelease() {},
      },
      resources,
      () => ({ id: "A" }) as Connection<any>,
    );
    const pending = new PendingCallManager();
    deps = {
      isConnectionReady: vi.fn(() => true),
      safeSendMessage: vi.fn((message, connectionId) => {
        pending.handleResponse(message.id!, connectionId, null, connectionId);
        return Result.ok(undefined);
      }),
      payloadProcessor: new PayloadProcessor(resources, proxies),
      pendingCallManager: pending,
    };
    processor = new CallProcessor(deps);
  });

  it("rejects a bound connection that is no longer ready before registering", async () => {
    vi.mocked(deps.isConnectionReady).mockReturnValue(false);
    const register = vi.spyOn(deps.pendingCallManager, "register");

    await expect(processor.safeProcess(call())).resolves.toMatchObject({
      error: { code: "E_CONN_CLOSED", context: { connectionId: "A" } },
    });
    expect(register).not.toHaveBeenCalled();
    expect(deps.safeSendMessage).not.toHaveBeenCalled();
  });

  it("registers before a synchronous response and resolves the response value", async () => {
    await expect(processor.safeProcess(call())).resolves.toEqual(
      Result.ok("A"),
    );
    expect(deps.pendingCallManager.canHandleResponse(1, "A")).toBe(false);
  });

  it("returns the RPC timeout while a Blob read stays reserved until it settles", async () => {
    vi.useFakeTimers();
    let finishRead!: (buffer: ArrayBuffer) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    const blob = new Blob([new Uint8Array(32)]);
    Object.defineProperty(blob, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishRead = resolve;
          readStarted();
        }),
    });
    let reserved = 0;
    const payloadProcessor = new PayloadProcessor(resources, {
      createRemoteResourceProxy: vi.fn(),
    } as any);
    const timed = new CallProcessor({
      ...deps,
      payloadProcessor,
      payloadReservation: {
        reserveBytes: (bytes) => {
          reserved += bytes;
          return true;
        },
        releaseBytes: (bytes) => (reserved -= bytes),
      },
    });
    try {
      const callPromise = timed.safeProcess(
        call({ args: [blob], timeout: 10 }),
      );
      await started;
      expect(reserved).toBeGreaterThanOrEqual(32);
      await vi.advanceTimersByTimeAsync(11);
      const result = await callPromise;
      expect(result.isErr()).toBe(true);
      expect(result.isErr() && result.error.code).toBe("E_CALL_TIMEOUT");
      expect(reserved).toBeGreaterThanOrEqual(32);
      finishRead(new Uint8Array(32).buffer);
      await vi.waitFor(() => expect(reserved).toBe(0));
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the outgoing lease until the pending RPC settles", async () => {
    let used = 0;
    const payloadReservation = {
      reserveBytes: (bytes: number) => {
        used += bytes;
        return true;
      },
      releaseBytes: (bytes: number) => (used -= bytes),
    };
    const safeSendMessage = vi.fn(async () => Result.ok(undefined));
    const timed = new CallProcessor({
      ...deps,
      safeSendMessage,
      payloadReservation,
    });
    const pending = timed.safeProcess(call({ args: [new Uint8Array(32)] }));
    await vi.waitFor(() => expect(safeSendMessage).toHaveBeenCalledOnce());
    expect(used).toBeGreaterThanOrEqual(32);
    deps.pendingCallManager.handleResponse(1, "done", null, "A");
    await expect(pending).resolves.toEqual(Result.ok("done"));
    expect(used).toBe(0);
  });

  it("keeps a message sequence per processor", async () => {
    await processor.safeProcess(call());
    await processor.safeProcess(call());
    await new CallProcessor(deps).safeProcess(call());

    expect(
      vi.mocked(deps.safeSendMessage).mock.calls.map(([message]) => message.id),
    ).toEqual([1, 2, 1]);
  });

  it("releases sanitized capabilities when send fails", async () => {
    vi.mocked(deps.safeSendMessage).mockReturnValue(
      Result.err(new NexusDisconnectedError("closed")),
    );

    await expect(
      processor.safeProcess(call({ args: [() => undefined] })),
    ).resolves.toMatchObject({
      error: { code: "E_CONN_CLOSED" },
    });
    expect(resources.countLocalResources()).toBe(0);
    expect(deps.pendingCallManager.canHandleResponse(1, "A")).toBe(false);
  });

  it("registers before a reentrant transport reply", async () => {
    const register = vi.spyOn(deps.pendingCallManager, "register");
    vi.mocked(deps.safeSendMessage).mockImplementation(
      (message, connectionId) => {
        expect(register).toHaveBeenCalledWith(
          message.id,
          expect.objectContaining({ connectionId, timeout: 1_000 }),
        );
        deps.pendingCallManager.handleResponse(
          message.id!,
          "reentrant",
          null,
          connectionId,
        );
        return Result.ok(undefined);
      },
    );

    await expect(processor.safeProcess(call())).resolves.toEqual(
      Result.ok("reentrant"),
    );
  });

  it("keeps a valid response when the send promise rejects afterward", async () => {
    vi.mocked(deps.safeSendMessage).mockImplementation((message, source) => {
      deps.pendingCallManager.handleResponse(
        message.id!,
        "response won",
        null,
        source,
      );
      return Promise.reject(new Error("late native rejection"));
    });

    await expect(processor.safeProcess(call())).resolves.toEqual(
      Result.ok("response won"),
    );
    expect(deps.pendingCallManager.canHandleResponse(1, "A")).toBe(false);
  });

  it("removes pending state after a thrown transport handoff", async () => {
    vi.mocked(deps.safeSendMessage).mockImplementation(() => {
      throw new Error("transport threw");
    });

    await processor.safeProcess(call({ args: [() => undefined] }));
    expect(resources.countLocalResources()).toBe(0);
    expect(deps.pendingCallManager.canHandleResponse(1, "A")).toBe(false);
  });

  it("propagates disconnects through the pending Result", async () => {
    vi.mocked(deps.safeSendMessage).mockReturnValue(Result.ok(undefined));
    const result = processor.safeProcess(call());
    deps.pendingCallManager.onDisconnect("A");

    const pending = await result;
    expect(pending.isErr()).toBe(true);
    expect(pending.error.code).toBe("E_CONN_CLOSED");
  });

  it("wraps an unrecognized remote error with its structured cause", async () => {
    const remoteError = {
      name: "Denied",
      code: "E_AUTH_CALL_DENIED",
      message: "denied",
    };
    vi.mocked(deps.safeSendMessage).mockImplementation(
      (message, connectionId) => {
        deps.pendingCallManager.handleResponse(
          message.id!,
          null,
          remoteError,
          connectionId,
        );
        return Result.ok(undefined);
      },
    );

    const result = await processor.safeProcess(call());
    expect(result.isErr() && result.error).toBeInstanceOf(NexusRemoteError);
    expect(result).toMatchObject({
      error: { code: "E_REMOTE_EXCEPTION", context: { remoteError } },
    });
  });
});
