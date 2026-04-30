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
      getConnectionAuthContext: vi.fn(() => ({
        localIdentity: { id: "host" },
        remoteIdentity: { id: "client" },
        platform: { from: "client" },
      })),
    };
    messageHandler = MessageHandler.create(context);

    sanitizeSpy = vi
      .spyOn(payloadProcessor, "safeSanitize")
      .mockImplementation((args: any[]) => ok(args));
    vi.spyOn(payloadProcessor, "safeSanitizeFromService").mockImplementation(
      (args: any[], targetConnectionId: string, serviceName: string) => {
        const baseResult = payloadProcessor.safeSanitize(
          args,
          targetConnectionId,
        );
        if (baseResult.isErr()) {
          return baseResult;
        }
        if (baseResult.value.some((value, index) => value !== args[index])) {
          return baseResult;
        }
        const sanitized = args.map((value) => {
          if (typeof value !== "object" || value === null) {
            return value;
          }
          const resourceId = resourceManager.registerLocalResource(
            value,
            targetConnectionId,
            LocalResourceType.OBJECT,
            serviceName,
          );
          return `\u0003R:${resourceId}`;
        });
        return ok(sanitized);
      },
    );
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

    it("should deny APPLY before invoking a local service when policy.canCall returns false", async () => {
      const add = vi.fn((a: number, b: number) => a + b);
      resourceManager.registerExposedService("calculator", { add });
      context.policy = {
        canCall: vi.fn(() => false),
      } as any;

      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 100,
        resourceId: null,
        path: ["calculator", "add"],
        args: [1, 2],
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(add).not.toHaveBeenCalled();
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 100,
          error: expect.objectContaining({ code: "E_AUTH_CALL_DENIED" }),
        },
        sourceConnectionId,
      );
    });

    it("should normalize policy.canCall throw to E_AUTH_CALL_DENIED", async () => {
      const add = vi.fn((a: number, b: number) => a + b);
      resourceManager.registerExposedService("calculator", { add });
      context.policy = {
        canCall: vi.fn(() => {
          throw new Error("policy exploded");
        }),
      } as any;

      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 101,
        resourceId: null,
        path: ["calculator", "add"],
        args: [1, 2],
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(add).not.toHaveBeenCalled();
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 101,
          error: expect.objectContaining({ code: "E_AUTH_CALL_DENIED" }),
        },
        sourceConnectionId,
      );
    });

    it("should normalize policy.canCall rejection to E_AUTH_CALL_DENIED", async () => {
      const add = vi.fn((a: number, b: number) => a + b);
      resourceManager.registerExposedService("calculator", { add });
      context.policy = {
        canCall: vi.fn(() => Promise.reject(new Error("policy rejected"))),
      } as any;

      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 102,
        resourceId: null,
        path: ["calculator", "add"],
        args: [1, 2],
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(add).not.toHaveBeenCalled();
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 102,
          error: expect.objectContaining({ code: "E_AUTH_CALL_DENIED" }),
        },
        sourceConnectionId,
      );
    });

    it("should authorize APPLY against a local resource before invoking it", async () => {
      const mockFn = vi.fn().mockReturnValue("resource_result");
      const resourceId = resourceManager.registerLocalResource(
        mockFn,
        sourceConnectionId,
        LocalResourceType.FUNCTION,
      );
      context.policy = {
        canCall: vi.fn(() => false),
      } as any;

      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 103,
        resourceId,
        path: [],
        args: ["arg1"],
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(mockFn).not.toHaveBeenCalled();
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 103,
          error: expect.objectContaining({ code: "E_AUTH_CALL_DENIED" }),
        },
        sourceConnectionId,
      );
    });

    it("should deny foreign resource access before invoking resource policy", async () => {
      const mockFn = vi.fn().mockReturnValue("resource_result");
      const resourcePolicy = {
        canCall: vi.fn(() => true),
      };
      const resourceId = resourceManager.registerLocalResource(
        mockFn,
        "conn-owner",
        LocalResourceType.FUNCTION,
        "vault",
        resourcePolicy,
      );

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.APPLY,
          id: 116,
          resourceId,
          path: [],
          args: ["arg1"],
        },
        sourceConnectionId,
      );

      expect(resourcePolicy.canCall).not.toHaveBeenCalled();
      expect(mockFn).not.toHaveBeenCalled();
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 116,
          error: expect.objectContaining({ code: "E_RESOURCE_ACCESS_DENIED" }),
        },
        sourceConnectionId,
      );
    });

    it("should preserve service canCall policy for resources returned by that service", async () => {
      const child = { read: vi.fn(() => "secret") };
      const servicePolicy = {
        canCall: vi.fn(({ path }) => path[0] !== "read"),
      };
      resourceManager.registerExposedService(
        "vault",
        { getChild: () => child },
        servicePolicy,
      );
      vi.mocked(payloadProcessor.safeSanitizeFromService).mockImplementation(
        (args: any[], targetConnectionId: string, serviceName: string) => {
          const resourceId = resourceManager.registerLocalResource(
            args[0],
            targetConnectionId,
            LocalResourceType.OBJECT,
            serviceName,
            resourceManager.getExposedServiceRecord(serviceName)?.policy,
          );
          return ok([`\u0003R:${resourceId}`]);
        },
      );
      context.policy = { canCall: vi.fn(() => true) } as any;

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.GET,
          id: 104,
          resourceId: null,
          path: ["vault", "getChild"],
        },
        sourceConnectionId,
      );
      const resourceId =
        resourceManager.listLocalResourceIdsByOwner(sourceConnectionId)[0];
      expect(resourceId).toBeDefined();

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.APPLY,
          id: 105,
          resourceId,
          path: ["read"],
          args: [],
        },
        sourceConnectionId,
      );

      expect(child.read).not.toHaveBeenCalled();
      expect(context.policy.canCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ serviceName: `resource:${resourceId}` }),
      );
      expect(servicePolicy.canCall).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: "vault",
          path: ["read"],
          operation: "APPLY",
        }),
      );
      expect(mockEngine.safeSendMessage).toHaveBeenLastCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 105,
          error: expect.objectContaining({ code: "E_AUTH_CALL_DENIED" }),
        },
        sourceConnectionId,
      );
    });

    it("should keep using the original service policy snapshot after service registration is overwritten", async () => {
      const child = { read: vi.fn(() => "secret") };
      const originalPolicy = {
        canCall: vi.fn(({ path }) => path[0] !== "read"),
      };
      const replacementPolicy = {
        canCall: vi.fn(() => true),
      };
      resourceManager.registerExposedService(
        "vault",
        { getChild: () => child },
        originalPolicy,
      );
      vi.mocked(payloadProcessor.safeSanitizeFromService).mockImplementation(
        (args: any[], targetConnectionId: string, serviceName: string) => {
          const resourceId = resourceManager.registerLocalResource(
            args[0],
            targetConnectionId,
            LocalResourceType.OBJECT,
            serviceName,
            resourceManager.getExposedServiceRecord(serviceName)?.policy,
          );
          return ok([`\u0003R:${resourceId}`]);
        },
      );

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.GET,
          id: 107,
          resourceId: null,
          path: ["vault", "getChild"],
        },
        sourceConnectionId,
      );
      const resourceId =
        resourceManager.listLocalResourceIdsByOwner(sourceConnectionId)[0];
      resourceManager.registerExposedService(
        "vault",
        { getChild: () => child },
        replacementPolicy,
      );

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.APPLY,
          id: 108,
          resourceId,
          path: ["read"],
          args: [],
        },
        sourceConnectionId,
      );

      expect(child.read).not.toHaveBeenCalled();
      expect(originalPolicy.canCall).toHaveBeenCalledWith(
        expect.objectContaining({ serviceName: "vault", path: ["read"] }),
      );
      expect(replacementPolicy.canCall).not.toHaveBeenCalled();
      expect(mockEngine.safeSendMessage).toHaveBeenLastCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 108,
          error: expect.objectContaining({ code: "E_AUTH_CALL_DENIED" }),
        },
        sourceConnectionId,
      );
    });

    it("should preserve the authorized service policy snapshot for async results after service overwrite", async () => {
      let resolveChild!: (value: object) => void;
      const child = { restricted: vi.fn(() => "secret") };
      const originalPolicy = {
        canCall: vi.fn(({ path }) => path[0] !== "restricted"),
      };
      const replacementPolicy = {
        canCall: vi.fn(() => true),
      };
      resourceManager.registerExposedService(
        "vault",
        {
          getChild: () =>
            new Promise((resolve) => {
              resolveChild = resolve;
            }),
        },
        originalPolicy,
      );
      vi.mocked(payloadProcessor.safeSanitizeFromService).mockImplementation(
        (
          args: any[],
          targetConnectionId: string,
          serviceName: string,
          servicePolicy?: any,
        ) => {
          const resourceId = resourceManager.registerLocalResource(
            args[0],
            targetConnectionId,
            LocalResourceType.OBJECT,
            serviceName,
            servicePolicy,
          );
          return ok([`R:${resourceId}`]);
        },
      );

      const handling = messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.APPLY,
          id: 112,
          resourceId: null,
          path: ["vault", "getChild"],
          args: [],
        },
        sourceConnectionId,
      );

      await vi.waitFor(() => {
        expect(originalPolicy.canCall).toHaveBeenCalledWith(
          expect.objectContaining({ serviceName: "vault", path: ["getChild"] }),
        );
      });
      resourceManager.registerExposedService(
        "vault",
        { getChild: () => child },
        replacementPolicy,
      );
      resolveChild(child);
      await handling;

      const resourceId =
        resourceManager.listLocalResourceIdsByOwner(sourceConnectionId)[0];
      expect(resourceId).toBeDefined();

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.APPLY,
          id: 113,
          resourceId,
          path: ["restricted", "call"],
          args: ["ignored"],
        },
        sourceConnectionId,
      );

      expect(child.restricted).not.toHaveBeenCalled();
      expect(originalPolicy.canCall).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: "vault",
          path: ["restricted", "call"],
        }),
      );
      expect(replacementPolicy.canCall).not.toHaveBeenCalled();
      expect(mockEngine.safeSendMessage).toHaveBeenLastCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 113,
          error: expect.objectContaining({ code: "E_AUTH_CALL_DENIED" }),
        },
        sourceConnectionId,
      );
    });

    it("should preserve an authorized undefined service policy snapshot for async results", async () => {
      let resolveChild!: (value: object) => void;
      const child = { restricted: vi.fn(() => "secret") };
      const replacementPolicy = {
        canCall: vi.fn(() => false),
      };
      resourceManager.registerExposedService("vault", {
        getChild: () =>
          new Promise((resolve) => {
            resolveChild = resolve;
          }),
      });

      const handling = messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.APPLY,
          id: 114,
          resourceId: null,
          path: ["vault", "getChild"],
          args: [],
        },
        sourceConnectionId,
      );

      await vi.waitFor(() => {
        expect(resolveChild).toBeTypeOf("function");
      });
      resourceManager.registerExposedService(
        "vault",
        { getChild: () => child },
        replacementPolicy,
      );
      resolveChild(child);
      await handling;

      const resourceId =
        resourceManager.listLocalResourceIdsByOwner(sourceConnectionId)[0];
      expect(resourceId).toBeDefined();

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.APPLY,
          id: 115,
          resourceId,
          path: ["restricted"],
          args: [],
        },
        sourceConnectionId,
      );

      expect(child.restricted).toHaveBeenCalledOnce();
      expect(replacementPolicy.canCall).not.toHaveBeenCalled();
      expect(mockEngine.safeSendMessage).toHaveBeenLastCalledWith(
        {
          type: NexusMessageType.RES,
          id: 115,
          result: "secret",
        },
        sourceConnectionId,
      );
    });

    it("should preserve an existing resource policy snapshot for nested returned resources after service overwrite", async () => {
      const nested = vi.fn(() => "nested secret");
      const child = { getNested: vi.fn(() => nested) };
      const originalPolicy = {
        canCall: vi.fn(
          ({ path }) => path.length === 0 || path[0] !== "restricted",
        ),
      };
      const replacementPolicy = {
        canCall: vi.fn(() => true),
      };
      resourceManager.registerExposedService(
        "vault",
        { getChild: () => child },
        originalPolicy,
      );
      vi.mocked(payloadProcessor.safeSanitizeFromService).mockImplementation(
        (
          args: any[],
          targetConnectionId: string,
          serviceName: string,
          servicePolicy?: any,
        ) => {
          const resourceId = resourceManager.registerLocalResource(
            args[0],
            targetConnectionId,
            typeof args[0] === "function"
              ? LocalResourceType.FUNCTION
              : LocalResourceType.OBJECT,
            serviceName,
            servicePolicy ??
              resourceManager.getExposedServiceRecord(serviceName)?.policy,
          );
          return ok([`\u0003R:${resourceId}`]);
        },
      );
      context.policy = { canCall: vi.fn(() => true) } as any;

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.GET,
          id: 109,
          resourceId: null,
          path: ["vault", "getChild"],
        },
        sourceConnectionId,
      );
      const childResourceId =
        resourceManager.listLocalResourceIdsByOwner(sourceConnectionId)[0];
      resourceManager.registerExposedService(
        "vault",
        { getChild: () => child },
        replacementPolicy,
      );

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.GET,
          id: 110,
          resourceId: childResourceId,
          path: ["getNested"],
        },
        sourceConnectionId,
      );
      const nestedResourceId = resourceManager
        .listLocalResourceIdsByOwner(sourceConnectionId)
        .find((id) => id !== childResourceId);
      expect(nestedResourceId).toBeDefined();

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.APPLY,
          id: 111,
          resourceId: nestedResourceId!,
          path: ["restricted"],
          args: [],
        },
        sourceConnectionId,
      );

      expect(nested).not.toHaveBeenCalled();
      expect(originalPolicy.canCall).toHaveBeenCalledWith(
        expect.objectContaining({ serviceName: "vault", path: ["restricted"] }),
      );
      expect(replacementPolicy.canCall).not.toHaveBeenCalled();
      expect(mockEngine.safeSendMessage).toHaveBeenLastCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 111,
          error: expect.objectContaining({ code: "E_AUTH_CALL_DENIED" }),
        },
        sourceConnectionId,
      );
    });

    it("should fall back to global canCall when service policy does not define canCall", async () => {
      const add = vi.fn((a: number, b: number) => a + b);
      const servicePolicy = {
        canConnect: vi.fn(() => true),
      };
      resourceManager.registerExposedService(
        "calculator",
        { add },
        servicePolicy,
      );
      context.policy = {
        canCall: vi.fn(() => false),
      } as any;

      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 106,
        resourceId: null,
        path: ["calculator", "add"],
        args: [1, 2],
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(add).not.toHaveBeenCalled();
      expect(context.policy.canCall).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: "calculator",
          path: ["add"],
          operation: "APPLY",
        }),
      );
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 106,
          error: expect.objectContaining({ code: "E_AUTH_CALL_DENIED" }),
        },
        sourceConnectionId,
      );
    });

    it("should fall back to global canCall when resource policy snapshot does not define canCall", async () => {
      const child = { read: vi.fn(() => "secret") };
      const servicePolicy = {
        canConnect: vi.fn(() => true),
      };
      const resourceId = resourceManager.registerLocalResource(
        child,
        sourceConnectionId,
        LocalResourceType.OBJECT,
        "vault",
        servicePolicy,
      );
      context.policy = {
        canCall: vi.fn(() => false),
      } as any;

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.APPLY,
          id: 117,
          resourceId,
          path: ["read"],
          args: [],
        },
        sourceConnectionId,
      );

      expect(child.read).not.toHaveBeenCalled();
      expect(context.policy.canCall).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceName: "vault",
          path: ["read"],
          operation: "APPLY",
        }),
      );
      expect(mockEngine.safeSendMessage).toHaveBeenLastCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 117,
          error: expect.objectContaining({ code: "E_AUTH_CALL_DENIED" }),
        },
        sourceConnectionId,
      );
    });

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

    it("should deny constructor function access through RPC paths", async () => {
      resourceManager.registerExposedService("store", { value: "safe" });

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.GET,
          id: 12,
          resourceId: null,
          path: ["store", "constructor", "constructor"],
        },
        sourceConnectionId,
      );

      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 12,
          error: expect.objectContaining({ code: "E_INVALID_SERVICE_PATH" }),
        },
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

    it("should deny prototype pollution through RPC set paths", async () => {
      resourceManager.registerExposedService("store", {});
      reviveSpy.mockReturnValueOnce(ok(["polluted"]));

      await messageHandler.safeHandleMessage(
        {
          type: NexusMessageType.SET,
          id: 21,
          resourceId: null,
          path: ["store", "__proto__", "polluted"],
          value: "polluted",
        },
        sourceConnectionId,
      );

      expect(({} as { polluted?: string }).polluted).toBeUndefined();
      expect(mockEngine.safeSendMessage).toHaveBeenCalledWith(
        {
          type: NexusMessageType.ERR,
          id: 21,
          error: expect.objectContaining({ code: "E_INVALID_SERVICE_PATH" }),
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
    it("should release a local resource owned by the source connection", async () => {
      const resourceId = resourceManager.registerLocalResource(
        () => {},
        sourceConnectionId,
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

    it("should not release a local resource owned by another connection", async () => {
      const resourceId = resourceManager.registerLocalResource(
        () => {},
        "some-other-conn",
        LocalResourceType.FUNCTION,
      );
      const message: ReleaseMessage = {
        type: NexusMessageType.RELEASE,
        id: null,
        resourceId,
      };

      await messageHandler.safeHandleMessage(message, sourceConnectionId);

      expect(resourceManager.getLocalResource(resourceId)).toBeDefined();
    });
  });
});
