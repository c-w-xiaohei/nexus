import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageHandler } from "./message-handler";
import { ResourceManager } from "../resource-manager";
import type { Engine } from "../engine";
import type { PayloadProcessor } from "../payload/payload-processor";
import type { HandlerContext } from "./types";
import {
  NexusMessageType,
  type ApplyMessage,
  type GetMessage,
  type SetMessage,
  type ResMessage,
  type ErrMessage,
  type ReleaseMessage,
} from "../../types/message";
import { LocalResourceType } from "../types";

// 1. Mock the dependencies to isolate the MessageHandler logic
const mockEngine = {
  sendMessage: vi.fn(),
  handleResponse: vi.fn(),
} as unknown as Engine<any, any>;

const mockPayloadProcessor = {
  sanitize: vi.fn(),
  revive: vi.fn(),
};

describe("MessageHandler", () => {
  let messageHandler: MessageHandler<any, any>;
  let resourceManager: ResourceManager;
  let context: HandlerContext<any, any>;

  const sourceConnectionId = "conn-test-source";

  // 2. Setup a clean state before each test
  beforeEach(() => {
    vi.clearAllMocks(); // Resets call counts and mock implementations

    resourceManager = new ResourceManager(); // Use a real, clean ResourceManager
    context = {
      engine: mockEngine,
      resourceManager,
      payloadProcessor: mockPayloadProcessor as unknown as PayloadProcessor<
        any,
        any
      >,
    };
    messageHandler = new MessageHandler(context);

    // Provide default mock implementations that return the input.
    // This simplifies tests that don't need to assert on processing.
    mockPayloadProcessor.sanitize.mockImplementation(
      (args: any[], _connId: string) => args
    );
    mockPayloadProcessor.revive.mockImplementation(
      (args: any[], _connId: string) => args
    );
  });

  it("should throw an error for an unknown message type", async () => {
    const unknownMessage = { type: 999 } as any;
    // The handler is designed to throw for unknown types, which is caught by the Engine.
    // The test should verify this throwing behavior.
    await expect(
      messageHandler.handleMessage(unknownMessage, "conn-test-source")
    ).rejects.toThrowError('No message handler found for message type "999"');
  });

  // 3. Test each message handler individually
  describe("APPLY Handler", () => {
    const mockService = {
      add: (a: number, b: number) => a + b,
    };

    it("should call a method on an exposed service and return the result", async () => {
      resourceManager.registerExposedService("calculator", mockService);
      // Mock that the payload processor returns the sanitized result
      mockPayloadProcessor.sanitize.mockReturnValueOnce(["sanitized_3"]);

      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 1,
        resourceId: null,
        path: ["calculator", "add"],
        args: [1, 2],
      };

      await messageHandler.handleMessage(message, sourceConnectionId);

      expect(mockPayloadProcessor.revive).toHaveBeenCalledWith(
        [1, 2],
        sourceConnectionId
      );
      expect(mockPayloadProcessor.sanitize).toHaveBeenCalledWith(
        [3],
        sourceConnectionId
      );
      expect(mockEngine.sendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.RES,
          id: 1,
          result: "sanitized_3",
        },
        sourceConnectionId
      );
    });

    it("should call a function from the local resource registry", async () => {
      const mockFn = vi.fn().mockReturnValue("resource_result");
      const resourceId = resourceManager.registerLocalResource(
        mockFn,
        sourceConnectionId,
        LocalResourceType.FUNCTION
      );

      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 2,
        resourceId,
        path: [],
        args: ["arg1"],
      };

      await messageHandler.handleMessage(message, sourceConnectionId);

      expect(mockFn).toHaveBeenCalledWith("arg1");
      expect(mockPayloadProcessor.sanitize).toHaveBeenCalledWith(
        ["resource_result"],
        sourceConnectionId
      );
      expect(mockEngine.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NexusMessageType.RES,
          id: 2,
          result: "resource_result", // Should be the value itself
        }),
        sourceConnectionId
      );
    });

    it("should return an ERR message if the target function throws", async () => {
      const error = new Error("Calculation failed");
      const mockServiceWithErr = {
        divide: () => {
          throw error;
        },
      };
      resourceManager.registerExposedService("failingCalc", mockServiceWithErr);

      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 3,
        resourceId: null,
        path: ["failingCalc", "divide"],
        args: [],
      };

      await messageHandler.handleMessage(message, sourceConnectionId);

      expect(mockEngine.sendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 3,
          error: expect.objectContaining({
            name: "Error",
            message: "Calculation failed",
          }),
        },
        sourceConnectionId
      );
    });
  });

  describe("GET Handler", () => {
    const mockStore = { config: { version: "1.0" } };

    it("should get a property from an exposed service", async () => {
      resourceManager.registerExposedService("store", mockStore);
      mockPayloadProcessor.sanitize.mockReturnValueOnce(["sanitized_v1.0"]);

      const message: GetMessage = {
        type: NexusMessageType.GET,
        id: 10,
        resourceId: null,
        path: ["store", "config", "version"],
      };

      await messageHandler.handleMessage(message, sourceConnectionId);

      expect(mockPayloadProcessor.sanitize).toHaveBeenCalledWith(
        ["1.0"],
        sourceConnectionId
      );
      expect(mockEngine.sendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.RES,
          id: 10,
          result: "sanitized_v1.0",
        },
        sourceConnectionId
      );
    });

    it("should get a property from a local resource", async () => {
      const resourceId = resourceManager.registerLocalResource(
        mockStore,
        sourceConnectionId,
        LocalResourceType.OBJECT
      );
      const expectedConfig = { version: "1.0" };
      // CORRECT: Mock sanitize to return an ARRAY containing the expected value.
      mockPayloadProcessor.sanitize.mockReturnValueOnce([expectedConfig]);

      const message: GetMessage = {
        type: NexusMessageType.GET,
        id: 11,
        resourceId,
        path: ["config"],
      };

      await messageHandler.handleMessage(message, sourceConnectionId);

      expect(mockPayloadProcessor.sanitize).toHaveBeenCalledWith(
        [expectedConfig],
        sourceConnectionId
      );
      expect(mockEngine.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NexusMessageType.RES,
          id: 11,
          result: expectedConfig, // Should be the value itself
        }),
        sourceConnectionId
      );
    });
  });

  describe("SET Handler", () => {
    const mockStore: { user?: { name: string } } = {};

    it("should set a property on an exposed service", async () => {
      resourceManager.registerExposedService("store", mockStore);
      mockPayloadProcessor.revive.mockReturnValueOnce([{ name: "John" }]);

      const message: SetMessage = {
        type: NexusMessageType.SET,
        id: 20,
        resourceId: null,
        path: ["store", "user"],
        value: { name: "John" },
      };

      await messageHandler.handleMessage(message, sourceConnectionId);

      expect(mockPayloadProcessor.revive).toHaveBeenCalledWith(
        [{ name: "John" }],
        sourceConnectionId
      );
      expect(mockStore.user?.name).toBe("John");
      expect(mockEngine.sendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.RES,
          id: 20,
          result: true, // Acknowledge success
        },
        sourceConnectionId
      );
    });
  });

  describe("RES Handler", () => {
    it("should resolve a pending call with the revived result", async () => {
      mockPayloadProcessor.revive.mockReturnValueOnce(["revived_result"]);
      const message: ResMessage = {
        type: NexusMessageType.RES,
        id: 30,
        result: "original_result",
      };

      await messageHandler.handleMessage(message, sourceConnectionId);

      expect(mockPayloadProcessor.revive).toHaveBeenCalledWith(
        ["original_result"],
        sourceConnectionId
      );
      expect(mockEngine.handleResponse).toHaveBeenCalledWith(
        30,
        "revived_result",
        null,
        sourceConnectionId
      );
    });
  });

  describe("ERR Handler", () => {
    it("should reject a pending call with the error", async () => {
      const error = { name: "Error", message: "Remote failure" };
      const message: ErrMessage = {
        type: NexusMessageType.ERR,
        id: 40,
        error,
      };

      await messageHandler.handleMessage(message, sourceConnectionId);

      expect(mockEngine.handleResponse).toHaveBeenCalledWith(
        40,
        null,
        error,
        sourceConnectionId
      );
    });
  });

  describe("RELEASE Handler", () => {
    it("should release a local resource", async () => {
      const resourceId = resourceManager.registerLocalResource(
        () => {},
        "some-other-conn",
        LocalResourceType.FUNCTION
      );
      expect(resourceManager.getLocalResource(resourceId)).toBeDefined();

      const message: ReleaseMessage = {
        type: NexusMessageType.RELEASE,
        id: null,
        resourceId,
      };

      await messageHandler.handleMessage(message, sourceConnectionId);

      expect(resourceManager.getLocalResource(resourceId)).toBeUndefined();
    });
  });
});
