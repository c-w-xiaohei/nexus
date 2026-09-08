import { beforeEach, describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import {
  CallProcessor,
  type CallBinding,
  type DispatchCallOptions,
} from "./call-processor";
import { PendingCallManager } from "./pending-call-manager";
import { PayloadProcessor } from "./payload/payload-processor";
import { ResourceManager } from "./resource-manager";
import { ProxyFactory } from "./proxy-factory";
import { NexusDisconnectedError, NexusRemoteError } from "@/errors/call-errors";
import { NexusMessageType } from "@/types/message";

describe("CallProcessor", () => {
  let deps: ConstructorParameters<typeof CallProcessor>[0];
  let processor: CallProcessor;
  let resources: ResourceManager;
  const unicast: CallBinding = {
    target: { connectionId: "A" },
    strategy: "one",
    timeout: 1000,
  };
  const multicast: CallBinding = {
    target: { connectionIds: ["A", "B", "C"] },
    strategy: "all",
    timeout: 1000,
  };
  const call = (
    binding: CallBinding = unicast,
  ): DispatchCallOptions & { type: "APPLY" } => ({
    ...binding,
    type: "APPLY",
    resourceId: null,
    path: ["service", "method"],
    args: [],
  });

  beforeEach(() => {
    resources = new ResourceManager();
    const proxies = new ProxyFactory(
      {
        safeDispatchCall: async () => Result.ok(undefined),
        dispatchRelease() {},
      },
      resources,
    );
    const pending = new PendingCallManager();
    deps = {
      getReadyConnectionIds: vi.fn((target) =>
        Result.ok(
          "connectionId" in target
            ? [target.connectionId]
            : [...target.connectionIds],
        ),
      ),
      sendMessage: vi.fn((message, connectionId) => {
        pending.handleResponse(message.id!, connectionId, null, connectionId);
        return Result.ok(undefined);
      }),
      payloadProcessor: new PayloadProcessor(resources, proxies),
      pendingCallManager: pending,
    };
    processor = new CallProcessor(deps);
  });

  it("preserves existing connection errors", async () => {
    const error = new NexusDisconnectedError("closed");
    vi.mocked(deps.getReadyConnectionIds).mockReturnValue(Result.err(error));
    const result = await processor.safeProcess(call());
    expect(result.isErr() && result.error).toBe(error);
  });

  it.each([unicast, multicast])(
    "rejects incomplete bindings before side effects ($strategy)",
    async (binding) => {
      vi.mocked(deps.getReadyConnectionIds).mockReturnValue(Result.ok([]));
      const register = vi.spyOn(deps.pendingCallManager, "register");
      const result = await processor.safeProcess({
        ...call(binding),
        args: [() => {}],
      });
      expect(result).toMatchObject({ error: { code: "E_CONN_CLOSED" } });
      expect(register).not.toHaveBeenCalled();
      expect(deps.sendMessage).not.toHaveBeenCalled();
      expect(resources.countLocalResources()).toBe(0);
    },
  );

  it.each(["all", "stream"] as const)(
    "returns empty %s without pending state",
    async (strategy) => {
      const register = vi.spyOn(deps.pendingCallManager, "register");
      const result = await processor.safeProcess(
        call({ target: { connectionIds: [] }, strategy, timeout: 1000 }),
      );
      expect(result.isOk()).toBe(true);
      const value = result.unwrap();
      const values = strategy === "all" ? value : await Array.fromAsync(value);
      expect(values).toEqual([]);
      expect(register).not.toHaveBeenCalled();
      expect(deps.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("registers before synchronous responses and unwraps a unicast result", async () => {
    expect(await processor.safeProcess(call())).toEqual(Result.ok("A"));
    expect(deps.pendingCallManager.canHandleResponse(1, "A")).toBe(false);
  });

  it("owns an independent monotonically increasing message sequence", async () => {
    await processor.safeProcess(call());
    await processor.safeProcess(call());
    const other = new CallProcessor(deps);
    await other.safeProcess(call());
    expect(
      vi.mocked(deps.sendMessage).mock.calls.map(([message]) => message.id),
    ).toEqual([1, 2, 1]);
  });

  it("sanitizes callbacks separately for every bound recipient", async () => {
    expect(
      await processor.safeProcess({ ...call(multicast), args: [() => {}] }),
    ).toEqual(
      Result.ok([
        { status: "fulfilled", value: "A" },
        { status: "fulfilled", value: "B" },
        { status: "fulfilled", value: "C" },
      ]),
    );
    for (const id of ["A", "B", "C"])
      expect(resources.listLocalResourceIdsByOwner(id)).toHaveLength(1);
  });

  it.each(["send", "sanitize"] as const)(
    "keeps earlier capabilities after a later %s failure",
    async (boundary) => {
      const error = new Error("C failed");
      if (boundary === "send") {
        vi.mocked(deps.sendMessage).mockImplementation((_message, id) =>
          id === "C" ? Result.err(error) : Result.ok(undefined),
        );
      } else {
        vi.mocked(deps.sendMessage).mockReturnValue(Result.ok(undefined));
        const sanitize = deps.payloadProcessor.safeSanitize.bind(
          deps.payloadProcessor,
        );
        vi.spyOn(deps.payloadProcessor, "safeSanitize").mockImplementation(
          (args, id) => (id === "C" ? Result.err(error) : sanitize(args, id)),
        );
      }
      const result = await processor.safeProcess({
        ...call(multicast),
        args: [() => {}],
      });
      expect(result.isErr() && result.error).toBe(error);
      expect(resources.listLocalResourceIdsByOwner("A")).toHaveLength(1);
      expect(resources.listLocalResourceIdsByOwner("B")).toHaveLength(1);
      expect(resources.listLocalResourceIdsByOwner("C")).toHaveLength(0);
      expect(deps.pendingCallManager.canHandleResponse(1, "A")).toBe(false);
    },
  );

  it("releases capabilities when exact send fails", async () => {
    vi.mocked(deps.sendMessage).mockReturnValue(
      Result.err(new NexusDisconnectedError("not accepted")),
    );
    const result = await processor.safeProcess({ ...call(), args: [() => {}] });
    expect(result).toMatchObject({ error: { code: "E_CONN_CLOSED" } });
    expect(resources.countLocalResources()).toBe(0);
    expect(deps.pendingCallManager.canHandleResponse(1, "A")).toBe(false);
  });

  it("contains unexpected send throws and cleans the failed handoff", async () => {
    const error = new Error("transport threw");
    vi.mocked(deps.sendMessage).mockImplementation(() => {
      throw error;
    });
    const result = await processor.safeProcess({ ...call(), args: [() => {}] });
    expect(result.isErr() && result.error).toBe(error);
    expect(resources.countLocalResources()).toBe(0);
    expect(deps.pendingCallManager.canHandleResponse(1, "A")).toBe(false);
  });

  it("preserves multicast settlements for a single bound recipient", async () => {
    expect(
      await processor.safeProcess(
        call({
          target: { connectionIds: ["A"] },
          strategy: "all",
          timeout: 1000,
        }),
      ),
    ).toEqual(Result.ok([{ status: "fulfilled", value: "A" }]));
  });

  it("sanitizes SET values and preserves the operation path", async () => {
    await processor.safeProcess({
      ...unicast,
      type: "SET",
      resourceId: "remote",
      path: ["prop"],
      value: undefined,
    });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      {
        id: 1,
        type: NexusMessageType.SET,
        resourceId: "remote",
        path: ["prop"],
        value: "\u0003U",
      },
      "A",
    );
  });

  it("propagates a pending disconnect through Result", async () => {
    vi.mocked(deps.sendMessage).mockReturnValue(Result.ok(undefined));
    const result = processor.safeProcess(call());
    deps.pendingCallManager.onDisconnect("A");
    expect(await result).toMatchObject({
      error: {
        code: "E_CONN_CLOSED",
        context: { connectionId: "A", messageId: 1 },
      },
    });
  });

  it("wraps a remote error with its original structured cause", async () => {
    const remoteError = {
      name: "Denied",
      code: "E_AUTH_CALL_DENIED",
      message: "denied",
    };
    vi.mocked(deps.sendMessage).mockImplementation((message, id) => {
      deps.pendingCallManager.handleResponse(
        message.id!,
        null,
        remoteError,
        id,
      );
      return Result.ok(undefined);
    });
    const result = await processor.safeProcess(call());
    expect(result.isErr() && result.error).toBeInstanceOf(NexusRemoteError);
    expect(result).toMatchObject({
      error: { code: "E_REMOTE_EXCEPTION", context: { remoteError } },
    });
  });

  it("returns a fixed ordered stream", async () => {
    const result = await processor.safeProcess(
      call({ ...multicast, strategy: "stream" }),
    );
    const results = [];
    for await (const value of result.unwrap()) results.push(value);
    expect(results).toEqual(
      ["A", "B", "C"].map((value) => ({ status: "fulfilled", value })),
    );
  });
});
