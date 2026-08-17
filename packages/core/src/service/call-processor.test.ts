import { vi, describe, it, expect, beforeEach } from "vitest";
import { CallProcessor } from "./call-processor";
import type { DefaultAdapterModel } from "@/types/adapter-model";
import type { DispatchCallOptions } from "./engine";
import { PendingCallManager } from "./pending-call-manager";
import { PayloadProcessor } from "./payload/payload-processor";
import { ResourceManager } from "./resource-manager";
import { Result } from "better-result";
const { err, ok } = Result;

describe("CallProcessor", () => {
  let processorState: CallProcessor.Runtime;
  let deps: CallProcessor.Dependencies<DefaultAdapterModel>;

  beforeEach(() => {
    vi.clearAllMocks();

    deps = {
      nextMessageId: vi.fn(() => 1),
      getReadyConnectionIds: vi.fn((target) =>
        ok("connectionId" in target ? [target.connectionId] : ["conn-1"]),
      ),
      sendMessage: vi.fn(() => ok([])),
      payloadProcessor: PayloadProcessor.create({} as any, {} as any),
      pendingCallManager: PendingCallManager.create(),
    };

    processorState = CallProcessor.create(deps);
  });

  describe("Error Handling", () => {
    it("should throw disconnected error if sendMessage finds no connections for a specific connectionId", async () => {
      vi.mocked(deps.sendMessage).mockReturnValue(ok([]));
      vi.mocked(deps.getReadyConnectionIds).mockReturnValue(ok([]));

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { connectionId: "closed-conn-id" },
        resourceId: "service",
        path: ["method"],
      };

      const result = await processorState.safeProcess(options);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(CallProcessor.Error.Disconnected);
      }
    });

    it("should return an empty result for a broadcast that finds no connections", async () => {
      vi.mocked(deps.sendMessage).mockReturnValue(ok([]));
      vi.mocked(deps.getReadyConnectionIds).mockReturnValue(ok([]));

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { where: () => true },
        resourceId: "service",
        path: ["method"],
        strategy: "all",
      };

      const result = await processorState.safeProcess(options);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual([]);
      }
    });

    it("returns an empty broadcast result before registering a pending call, timer, or resource", async () => {
      vi.mocked(deps.getReadyConnectionIds).mockReturnValue(ok([]));
      const registerSpy = vi.spyOn(deps.pendingCallManager, "register");
      const sanitizeSpy = vi.spyOn(deps.payloadProcessor, "safeSanitize");
      const timerSpy = vi.spyOn(globalThis, "setTimeout");

      const result = await processorState.safeProcess({
        type: "APPLY",
        target: { where: () => true },
        resourceId: "service",
        path: ["method"],
        args: [() => {}],
        strategy: "all",
      });

      expect(result.value).toEqual([]);
      expect(registerSpy).not.toHaveBeenCalled();
      expect(sanitizeSpy).not.toHaveBeenCalled();
      expect(timerSpy).not.toHaveBeenCalled();
    });
  });

  describe("Message Building and Sending", () => {
    it("releases every dispatch-created resource and terminates pending when a later multicast send fails", async () => {
      vi.mocked(deps.getReadyConnectionIds).mockReturnValue(
        ok(["conn-1", "conn-2", "conn-3"]),
      );
      const resourceManager = ResourceManager.create();
      const existingResourceId = resourceManager.registerLocalResource(
        {},
        "existing-conn",
        0,
      );
      deps.payloadProcessor = PayloadProcessor.create(
        resourceManager,
        {} as any,
      );
      processorState = CallProcessor.create(deps);
      const register = deps.pendingCallManager.register.bind(
        deps.pendingCallManager,
      );
      let pendingPromise: Promise<unknown> | undefined;
      const registerSpy = vi
        .spyOn(deps.pendingCallManager, "register")
        .mockImplementation((messageId, options) => {
          pendingPromise = register(messageId, options);
          return pendingPromise;
        });
      const failSpy = vi.spyOn(deps.pendingCallManager, "fail");
      vi.mocked(deps.sendMessage)
        .mockReturnValueOnce(ok(["conn-1"]))
        .mockReturnValueOnce(ok(["conn-2"]))
        .mockReturnValueOnce(err(new Error("conn-3 send failed")));

      const result = await processorState.safeProcess({
        type: "APPLY",
        target: { connectionIds: ["conn-1", "conn-2", "conn-3"] },
        resourceId: "service",
        path: ["method"],
        args: [() => {}],
        strategy: "all",
      });

      expect(registerSpy).toHaveBeenCalledBefore(deps.sendMessage as never);
      expect(failSpy).toHaveBeenCalledWith(1, expect.any(Error));
      expect(result.isErr()).toBe(true);
      expect(resourceManager.countLocalResources()).toBe(1);
      expect(resourceManager.hasLocalResource(existingResourceId)).toBe(true);
      await expect(pendingPromise).rejects.toThrow("conn-3 send failed");
      deps.pendingCallManager.handleResponse(1, "late", null, "conn-1");
      deps.pendingCallManager.onDisconnect("conn-2");
      expect(resourceManager.countLocalResources()).toBe(1);
    });

    it("releases earlier dispatch-created resources when a later multicast sanitize fails", async () => {
      vi.mocked(deps.getReadyConnectionIds).mockReturnValue(
        ok(["conn-1", "conn-2", "conn-3"]),
      );
      const resourceManager = ResourceManager.create();
      const existingResourceId = resourceManager.registerLocalResource(
        {},
        "existing-conn",
        0,
      );
      deps.payloadProcessor = PayloadProcessor.create(
        resourceManager,
        {} as any,
      );
      processorState = CallProcessor.create(deps);
      const sanitize = deps.payloadProcessor.safeSanitize.bind(
        deps.payloadProcessor,
      );
      vi.spyOn(deps.payloadProcessor, "safeSanitize").mockImplementation(
        (args, connectionId) =>
          connectionId === "conn-3"
            ? err(new Error("conn-3 sanitize failed"))
            : sanitize(args, connectionId),
      );
      vi.mocked(deps.sendMessage).mockReturnValue(ok(["conn-1"]));

      const result = await processorState.safeProcess({
        type: "APPLY",
        target: { connectionIds: ["conn-1", "conn-2", "conn-3"] },
        resourceId: "service",
        path: ["method"],
        args: [() => {}],
        strategy: "all",
      });

      expect(result.isErr()).toBe(true);
      expect(deps.sendMessage).toHaveBeenCalledTimes(2);
      expect(resourceManager.countLocalResources()).toBe(1);
      expect(resourceManager.hasLocalResource(existingResourceId)).toBe(true);
    });

    it("sanitizes a multicast payload separately for every bound session", async () => {
      vi.mocked(deps.getReadyConnectionIds).mockReturnValue(
        ok(["conn-1", "conn-2"]),
      );
      vi.mocked(deps.sendMessage).mockReturnValue(ok(["conn-1"]));
      vi.spyOn(deps.pendingCallManager, "register").mockResolvedValue(
        [] as any,
      );
      const sanitizeSpy = vi.spyOn(deps.payloadProcessor, "safeSanitize");

      await processorState.safeProcess({
        type: "APPLY",
        target: { connectionIds: ["conn-1", "conn-2"] },
        resourceId: "service",
        path: ["method"],
        args: ["arg"],
        strategy: "all",
      });

      expect(sanitizeSpy).toHaveBeenCalledWith(["arg"], "conn-1");
      expect(sanitizeSpy).toHaveBeenCalledWith(["arg"], "conn-2");
    });

    it("fails a bound multicast when any acquired session is closed", async () => {
      vi.mocked(deps.getReadyConnectionIds).mockReturnValue(ok(["conn-1"]));

      const result = await processorState.safeProcess({
        type: "APPLY",
        target: { connectionIds: ["conn-1", "conn-2"] },
        resourceId: "service",
        path: ["method"],
        args: [],
        strategy: "all",
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(CallProcessor.Error.Disconnected);
      }
    });

    it("should call PayloadProcessor.safeSanitize for APPLY calls", async () => {
      vi.mocked(deps.sendMessage).mockReturnValue(ok(["conn-1"]));
      vi.spyOn(deps.pendingCallManager, "register").mockResolvedValue(
        [] as any,
      );
      const sanitizeSpy = vi.spyOn(deps.payloadProcessor, "safeSanitize");

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["method"],
        args: ["arg1", 123],
      };

      await processorState.safeProcess(options);

      expect(sanitizeSpy).toHaveBeenCalledWith(["arg1", 123], "conn-1");
    });

    it("should call PayloadProcessor.safeSanitize for SET calls", async () => {
      vi.mocked(deps.sendMessage).mockReturnValue(ok(["conn-1"]));
      vi.spyOn(deps.pendingCallManager, "register").mockResolvedValue(
        [] as any,
      );
      const sanitizeSpy = vi.spyOn(deps.payloadProcessor, "safeSanitize");

      const options: DispatchCallOptions = {
        type: "SET",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["prop"],
        value: "new-value",
      };

      await processorState.safeProcess(options);

      expect(sanitizeSpy).toHaveBeenCalledWith(["new-value"], "conn-1");
    });

    it("should throw if strategy is 'one' and more than one connection is found", async () => {
      vi.mocked(deps.sendMessage).mockReturnValue(ok(["conn-1", "conn-2"]));
      vi.mocked(deps.getReadyConnectionIds).mockReturnValue(
        ok(["conn-1", "conn-2"]),
      );

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { where: () => true },
        resourceId: "service",
        path: ["method"],
        strategy: "one",
      };

      const result = await processorState.safeProcess(options);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(CallProcessor.Error.Targeting);
      }
    });
  });

  describe("Pending Call Registration", () => {
    it("should register a call with PendingCallManager", async () => {
      vi.mocked(deps.sendMessage).mockReturnValue(ok(["conn-1"]));
      const registerSpy = vi
        .spyOn(deps.pendingCallManager, "register")
        .mockResolvedValue([] as any);

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["method"],
        timeout: 3000,
      };

      await processorState.safeProcess(options);

      expect(registerSpy).toHaveBeenCalledOnce();
      const [messageId, registerOptions] = registerSpy.mock.calls[0];
      expect(messageId).toBeTypeOf("number");
      expect(registerOptions).toEqual({
        strategy: "all",
        isBroadcast: false,
        sentConnectionIds: ["conn-1"],
        timeout: 3000,
      });
    });

    it("should correctly identify a broadcast call", async () => {
      vi.mocked(deps.sendMessage).mockReturnValue(ok(["conn-1", "conn-2"]));
      vi.mocked(deps.getReadyConnectionIds).mockReturnValue(
        ok(["conn-1", "conn-2"]),
      );
      const registerSpy = vi
        .spyOn(deps.pendingCallManager, "register")
        .mockResolvedValue([] as any);

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { where: () => true },
        resourceId: "service",
        path: ["method"],
        strategy: "all",
      };

      await processorState.safeProcess(options);

      expect(registerSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          isBroadcast: true,
          sentConnectionIds: ["conn-1", "conn-2"],
        }),
      );
    });
  });

  describe("Result Adaptation", () => {
    it("should adapt result for 'first' strategy on success", async () => {
      const settlement = [{ status: "fulfilled", value: "success" }];
      vi.mocked(deps.sendMessage).mockReturnValue(ok(["conn-1"]));
      vi.spyOn(deps.pendingCallManager, "register").mockResolvedValue(
        settlement as any,
      );

      const options: DispatchCallOptions = {
        type: "GET",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["prop"],
        strategy: "first",
      };

      const result = await processorState.safeProcess(options);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBe("success");
      }
    });

    it("should re-throw error for 'first' strategy on rejection", async () => {
      const error = {
        name: "Error",
        code: "E_UNKNOWN",
        message: "Remote Error",
      };
      const settlement = [{ status: "rejected", reason: error }];
      vi.mocked(deps.sendMessage).mockReturnValue(ok(["conn-1"]));
      vi.spyOn(deps.pendingCallManager, "register").mockResolvedValue(
        settlement as any,
      );

      const options: DispatchCallOptions = {
        type: "GET",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["prop"],
        strategy: "first",
      };

      const result = await processorState.safeProcess(options);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(CallProcessor.Error.Remote);
      }
    });

    it("should return raw result for 'all' strategy", async () => {
      const settlement = [{ status: "fulfilled", value: "success" }];
      vi.mocked(deps.sendMessage).mockReturnValue(ok(["conn-1"]));
      vi.spyOn(deps.pendingCallManager, "register").mockResolvedValue(
        settlement as any,
      );

      const options: DispatchCallOptions = {
        type: "GET",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["prop"],
        strategy: "all",
      };

      const result = await processorState.safeProcess(options);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual(settlement);
      }
    });

    it("should return Err when 'all' strategy promise rejects", async () => {
      vi.mocked(deps.sendMessage).mockReturnValue(ok(["conn-1"]));
      vi.spyOn(deps.pendingCallManager, "register").mockReturnValue(
        Promise.reject(new Error("pending failed")) as any,
      );

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["method"],
        strategy: "all",
      };

      const result = await processorState.safeProcess(options);
      expect(result.isErr()).toBe(true);
    });
  });
});
