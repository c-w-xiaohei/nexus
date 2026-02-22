import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageHandler } from "./message-handler";
import { ResourceManager } from "../resource-manager";
import type { MessageHandlerCallbacks } from "../engine";
import { PayloadProcessor } from "../payload/payload-processor";
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
import { err, ok } from "neverthrow";

const mockEngine = {
  safeSendMessage: vi.fn(() => ok([])),
  handleResponse: vi.fn(),
} as unknown as MessageHandlerCallbacks<any>;

describe("MessageHandler", () => {
  let messageHandler: MessageHandler.Runtime;
  let resourceManager: ResourceManager.Runtime;
  let context: HandlerContext<any, any>;
  let payloadProcessor: PayloadProcessor.Runtime<any, any>;
  let sanitizeSpy: ReturnType<typeof vi.spyOn>;
  let reviveSpy: ReturnType<typeof vi.spyOn>;

  const sourceConnectionId = "conn-test-source";

  beforeEach(() => {
    vi.clearAllMocks();

    resourceManager = ResourceManager.create();
    payloadProcessor = PayloadProcessor.create(resourceManager, {
      createRemoteResourceProxy: vi.fn(),
    } as any);

    context = {
      engine: mockEngine,
      resourceManager,
      payloadProcessor,
    };
    messageHandler = MessageHandler.create(context);

    sanitizeSpy = vi
      .spyOn(payloadProcessor, "safeSanitize")
      .mockImplementation((args: any[]) => ok(args));
    reviveSpy = vi
      .spyOn(payloadProcessor, "safeRevive")
      .mockImplementation((args: any[]) => ok(args));
  });

  it("should throw an error for an unknown message type", async () => {
    const unknownMessage = { type: 999 } as any;
    const result = await messageHandler.safeHandleMessage(
      unknownMessage,
      sourceConnectionId,
    );
    expect(result.isErr()).toBe(true);
    result.match(
      () => undefined,
      (error) => {
        expect(error.message).toContain("No message handler found");
      },
    );
  });

  describe("APPLY Handler", () => {
    const mockService = {
      add: (a: number, b: number) => a + b,
    };

    it("should call a method on an exposed service and return the result", async () => {
      resourceManager.registerExposedService("calculator", mockService);
      sanitizeSpy.mockReturnValueOnce(ok(["sanitized_3"]));

      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 1,
        resourceId: null,
        path: ["calculator", "add"],
        args: [1, 2],
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(reviveSpy).toHaveBeenCalledWith([1, 2], sourceConnectionId);
      expect(sanitizeSpy).toHaveBeenCalledWith([3], sourceConnectionId);
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.RES,
          id: 1,
          result: "sanitized_3",
        },
        sourceConnectionId,
      );
    });

    it("should return Err when safeSendMessage fails", async () => {
      const sendError = new Error("send failed");
      const sendSpy = vi
        .spyOn(mockEngine, "safeSendMessage")
        .mockReturnValueOnce(err(sendError));

      resourceManager.registerExposedService("calculator", mockService);
      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 999,
        resourceId: null,
        path: ["calculator", "add"],
        args: [1, 2],
      };

      const result = await messageHandler.safeHandleMessage(
        message,
        sourceConnectionId,
      );

      expect(sendSpy).toHaveBeenCalled();
      expect(result.isErr()).toBe(true);
    });

    it("should call a function from the local resource registry", async () => {
      const mockFn = vi.fn().mockReturnValue("resource_result");
      const resourceId = resourceManager.registerLocalResource(
        mockFn,
        sourceConnectionId,
        LocalResourceType.FUNCTION,
      );

      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 2,
        resourceId,
        path: [],
        args: ["arg1"],
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(mockFn).toHaveBeenCalledWith("arg1");
      expect(sanitizeSpy).toHaveBeenCalledWith(
        ["resource_result"],
        sourceConnectionId,
      );
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NexusMessageType.RES,
          id: 2,
          result: "resource_result",
        }),
        sourceConnectionId,
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

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 3,
          error: expect.objectContaining({
            name: "Error",
            message: "Calculation failed",
          }),
        },
        sourceConnectionId,
      );
    });
  });

  describe("GET Handler", () => {
    const mockStore = { config: { version: "1.0" } };

    it("should get a property from an exposed service", async () => {
      resourceManager.registerExposedService("store", mockStore);
      sanitizeSpy.mockReturnValueOnce(ok(["sanitized_v1.0"]));

      const message: GetMessage = {
        type: NexusMessageType.GET,
        id: 10,
        resourceId: null,
        path: ["store", "config", "version"],
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(sanitizeSpy).toHaveBeenCalledWith(["1.0"], sourceConnectionId);
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.RES,
          id: 10,
          result: "sanitized_v1.0",
        },
        sourceConnectionId,
      );
    });

    it("should get a property from a local resource", async () => {
      const resourceId = resourceManager.registerLocalResource(
        mockStore,
        sourceConnectionId,
        LocalResourceType.OBJECT,
      );
      const expectedConfig = { version: "1.0" };
      sanitizeSpy.mockReturnValueOnce(ok([expectedConfig]));

      const message: GetMessage = {
        type: NexusMessageType.GET,
        id: 11,
        resourceId,
        path: ["config"],
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(sanitizeSpy).toHaveBeenCalledWith(
        [expectedConfig],
        sourceConnectionId,
      );
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NexusMessageType.RES,
          id: 11,
          result: expectedConfig,
        }),
        sourceConnectionId,
      );
    });
  });

  describe("SET Handler", () => {
    const mockStore: { user?: { name: string } } = {};

    it("should set a property on an exposed service", async () => {
      resourceManager.registerExposedService("store", mockStore);
      reviveSpy.mockReturnValueOnce(ok([{ name: "John" }]));

      const message: SetMessage = {
        type: NexusMessageType.SET,
        id: 20,
        resourceId: null,
        path: ["store", "user"],
        value: { name: "John" },
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(reviveSpy).toHaveBeenCalledWith(
        [{ name: "John" }],
        sourceConnectionId,
      );
      expect(mockStore.user?.name).toBe("John");
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.RES,
          id: 20,
          result: true,
        },
        sourceConnectionId,
      );
    });
  });

  describe("RES Handler", () => {
    it("should resolve a pending call with the revived result", async () => {
      reviveSpy.mockReturnValueOnce(ok(["revived_result"]));
      const message: ResMessage = {
        type: NexusMessageType.RES,
        id: 30,
        result: "original_result",
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(reviveSpy).toHaveBeenCalledWith(
        ["original_result"],
        sourceConnectionId,
      );
      expect(mockEngine.handleResponse).toHaveBeenCalledWith(
        30,
        "revived_result",
        null,
        sourceConnectionId,
      );
    });
  });

  describe("ERR Handler", () => {
    it("should reject a pending call with the error", async () => {
      const error = {
        name: "Error",
        code: "E_UNKNOWN",
        message: "Remote failure",
      };
      const message: ErrMessage = {
        type: NexusMessageType.ERR,
        id: 40,
        error,
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(mockEngine.handleResponse).toHaveBeenCalledWith(
        40,
        null,
        error,
        sourceConnectionId,
      );
    });
  });

  describe("RELEASE Handler", () => {
    it("should release a local resource", async () => {
      const resourceId = resourceManager.registerLocalResource(
        () => {},
        "some-other-conn",
        LocalResourceType.FUNCTION,
      );
      expect(resourceManager.getLocalResource(resourceId)).toBeDefined();

      const message: ReleaseMessage = {
        type: NexusMessageType.RELEASE,
        id: null,
        resourceId,
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(resourceManager.getLocalResource(resourceId)).toBeUndefined();
    });
  });
});
