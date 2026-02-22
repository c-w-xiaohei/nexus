import { vi, describe, it, expect, beforeEach } from "vitest";
import { CallProcessor } from "./call-processor";
import type { UserMetadata, PlatformMetadata } from "@/types/identity";
import type { DispatchCallOptions } from "./engine";
import { PendingCallManager } from "./pending-call-manager";
import { PayloadProcessor } from "./payload/payload-processor";
import { ok, okAsync } from "neverthrow";

describe("CallProcessor", () => {
  let processorState: CallProcessor.Runtime;
  let deps: CallProcessor.Dependencies<UserMetadata, PlatformMetadata>;

  beforeEach(() => {
    vi.clearAllMocks();

    deps = {
      nextMessageId: vi.fn(() => 1),
      resolveConnection: vi.fn(() => okAsync(null)),
      sendMessage: vi.fn(() => ok([])),
      payloadProcessor: PayloadProcessor.create({} as any, {} as any),
      pendingCallManager: PendingCallManager.create(),
    };

    processorState = CallProcessor.create(deps);
  });

  describe("Error Handling", () => {
    it("should throw disconnected error if sendMessage finds no connections for a specific connectionId", async () => {
      vi.mocked(deps.sendMessage).mockReturnValue(ok([]));

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

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { matcher: () => true },
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
  });

  describe("Message Building and Sending", () => {
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

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { matcher: () => true },
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
      const registerSpy = vi
        .spyOn(deps.pendingCallManager, "register")
        .mockResolvedValue([] as any);

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { matcher: () => true },
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
      const settlement = [
        { status: "fulfilled", value: "success", from: "conn-1" },
      ];
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
      const settlement = [
        { status: "rejected", reason: error, from: "conn-1" },
      ];
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
      const settlement = [
        { status: "fulfilled", value: "success", from: "conn-1" },
      ];
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
