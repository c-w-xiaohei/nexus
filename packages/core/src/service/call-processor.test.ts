import { vi, describe, it, expect, beforeEach, type Mocked } from "vitest";
import {
  CallProcessor,
  type CallProcessorDependencies,
} from "./call-processor";
import type { UserMetadata, PlatformMetadata } from "@/types/identity";
import type { DispatchCallOptions } from "./engine";
import {
  NexusRemoteError,
  NexusTargetingError,
  NexusDisconnectedError,
} from "@/errors";

describe("CallProcessor", () => {
  let callProcessor: CallProcessor<any, any>;
  let mockDeps: Mocked<
    CallProcessorDependencies<UserMetadata, PlatformMetadata>
  >;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDeps = {
      connectionManager: {
        resolveConnection: vi.fn(),
        sendMessage: vi.fn(),
      },
      payloadProcessor: {
        sanitize: vi.fn((args) => args),
      },
      pendingCallManager: {
        register: vi.fn(),
      },
    } as unknown as Mocked<
      CallProcessorDependencies<UserMetadata, PlatformMetadata>
    >;

    callProcessor = new CallProcessor(mockDeps);
  });

  describe("Error Handling", () => {
    it("should throw NexusDisconnectedError if sendMessage finds no connections for a specific connectionId", async () => {
      // Simulate that the connection was closed between creation and call
      vi.mocked(mockDeps.connectionManager.sendMessage).mockReturnValue([]);

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { connectionId: "closed-conn-id" },
        resourceId: "service",
        path: ["method"],
      };

      await expect(callProcessor.process(options)).rejects.toBeInstanceOf(
        NexusDisconnectedError
      );
    });

    it("should return an empty result for a broadcast that finds no connections", async () => {
      vi.mocked(mockDeps.connectionManager.sendMessage).mockReturnValue([]);

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { matcher: () => true }, // Broadcast target
        resourceId: "service",
        path: ["method"],
        strategy: "all",
      };

      const result = await callProcessor.process(options);
      expect(result).toEqual([]); // Empty array for 'all' strategy
    });
  });

  describe("Message Building and Sending", () => {
    it("should call payloadProcessor.sanitize for APPLY calls", async () => {
      vi.mocked(mockDeps.connectionManager.sendMessage).mockReturnValue([
        "conn-1",
      ]);
      vi.mocked(mockDeps.pendingCallManager.register).mockResolvedValue([]);

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["method"],
        args: ["arg1", 123],
      };

      await callProcessor.process(options);

      expect(mockDeps.payloadProcessor.sanitize).toHaveBeenCalledWith(
        ["arg1", 123],
        "conn-1"
      );
    });

    it("should call payloadProcessor.sanitize for SET calls", async () => {
      vi.mocked(mockDeps.connectionManager.sendMessage).mockReturnValue([
        "conn-1",
      ]);
      vi.mocked(mockDeps.pendingCallManager.register).mockResolvedValue([]);

      const options: DispatchCallOptions = {
        type: "SET",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["prop"],
        value: "new-value",
      };

      await callProcessor.process(options);

      expect(mockDeps.payloadProcessor.sanitize).toHaveBeenCalledWith(
        ["new-value"],
        "conn-1"
      );
    });

    it("should throw if strategy is 'one' and more than one connection is found", async () => {
      vi.mocked(mockDeps.connectionManager.sendMessage).mockReturnValue([
        "conn-1",
        "conn-2",
      ]);

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { matcher: () => true },
        resourceId: "service",
        path: ["method"],
        strategy: "one",
      };

      await expect(callProcessor.process(options)).rejects.toBeInstanceOf(
        NexusTargetingError
      );
    });
  });

  describe("Pending Call Registration", () => {
    it("should register a call with PendingCallManager", async () => {
      vi.mocked(mockDeps.connectionManager.sendMessage).mockReturnValue([
        "conn-1",
      ]);
      vi.mocked(mockDeps.pendingCallManager.register).mockResolvedValue([]);

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["method"],
        timeout: 3000,
      };

      await callProcessor.process(options);

      expect(mockDeps.pendingCallManager.register).toHaveBeenCalledOnce();
      const [messageId, registerOptions] = vi.mocked(
        mockDeps.pendingCallManager.register
      ).mock.calls[0];
      expect(messageId).toBeTypeOf("number");
      expect(registerOptions).toEqual({
        strategy: "all", // "first" maps to "all" for the manager
        isBroadcast: false,
        sentConnectionIds: ["conn-1"],
        timeout: 3000,
      });
    });

    it("should correctly identify a broadcast call", async () => {
      vi.mocked(mockDeps.connectionManager.sendMessage).mockReturnValue([
        "conn-1",
        "conn-2",
      ]);
      vi.mocked(mockDeps.pendingCallManager.register).mockResolvedValue([]);

      const options: DispatchCallOptions = {
        type: "APPLY",
        target: { matcher: () => true },
        resourceId: "service",
        path: ["method"],
        strategy: "all",
      };

      await callProcessor.process(options);

      expect(mockDeps.pendingCallManager.register).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          isBroadcast: true,
          sentConnectionIds: ["conn-1", "conn-2"],
        })
      );
    });
  });

  describe("Result Adaptation", () => {
    it("should adapt result for 'first' strategy on success", async () => {
      const settlement = [
        { status: "fulfilled", value: "success", from: "conn-1" },
      ];
      vi.mocked(mockDeps.connectionManager.sendMessage).mockReturnValue([
        "conn-1",
      ]);
      vi.mocked(mockDeps.pendingCallManager.register).mockResolvedValue(
        settlement
      );

      const options: DispatchCallOptions = {
        type: "GET",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["prop"],
        strategy: "first",
      };

      const result = await callProcessor.process(options);
      expect(result).toBe("success");
    });

    it("should re-throw error for 'first' strategy on rejection", async () => {
      const error = { name: "Error", message: "Remote Error" };
      const settlement = [{ status: "rejected", value: error, from: "conn-1" }];
      vi.mocked(mockDeps.connectionManager.sendMessage).mockReturnValue([
        "conn-1",
      ]);
      vi.mocked(mockDeps.pendingCallManager.register).mockResolvedValue(
        settlement
      );

      const options: DispatchCallOptions = {
        type: "GET",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["prop"],
        strategy: "first",
      };

      await expect(callProcessor.process(options)).rejects.toBeInstanceOf(
        NexusRemoteError
      );
    });

    it("should return raw result for 'all' strategy", async () => {
      const settlement = [
        { status: "fulfilled", value: "success", from: "conn-1" },
      ];
      vi.mocked(mockDeps.connectionManager.sendMessage).mockReturnValue([
        "conn-1",
      ]);
      vi.mocked(mockDeps.pendingCallManager.register).mockResolvedValue(
        settlement
      );

      const options: DispatchCallOptions = {
        type: "GET",
        target: { connectionId: "conn-1" },
        resourceId: "service",
        path: ["prop"],
        strategy: "all",
      };

      const result = await callProcessor.process(options);
      expect(result).toEqual(settlement);
    });
  });
});
