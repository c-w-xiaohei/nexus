import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Engine } from "./engine";
import { CallProcessor } from "./call-processor";
import { MessageHandler } from "./message/message-handler";
import { NexusMessageType, type ApplyMessage } from "@/types/message";
import { createL3Endpoints } from "@/utils/test-utils";
import { SERVICE_ON_DISCONNECT } from "./service-invocation-hooks";
import { Nexus } from "@/api/nexus";
import { NexusDisconnectedError, NexusConnectionError } from "@/errors";
import { Result } from "better-result";
import {
  Logger,
  LogLevel,
  configureNexusLogger,
  resetNexusLoggerForTest,
} from "@/logger";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import type { ConnectionManager } from "@/connection/connection-manager";
import { Token } from "@/api/token";

// A mock service to be registered on the host engine for tests.
const mockTestService = {
  someMethod: vi.fn(),
  anotherMethod: vi.fn(),
};

describe("Engine", () => {
  let clientEngine: Engine<any>;
  let hostEngine: Engine<any>;
  let clientConnectionId: string;
  let hostConnectionId: string;
  let clientManager: ConnectionManager<any>;
  let hostManager: ConnectionManager<any>;

  beforeEach(async () => {
    // This helper creates two fully connected L3 engines.
    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        providers: { testService: mockTestService },
      },
      { meta: { id: "client" }, connectTo: [{ context: "host" }] },
    );

    clientEngine = setup.clientEngine;
    hostEngine = setup.hostEngine;
    clientConnectionId = setup.clientConnection.connectionId;
    hostConnectionId = setup.hostConnection.connectionId;
    clientManager = setup.clientCm;
    hostManager = setup.hostCm;
  });

  afterEach(() => {
    resetNexusLoggerForTest();
    vi.restoreAllMocks();
  });

  it("preserves the transport cause when converting a send failure to a call error", async () => {
    const cause = { name: "Error", message: "port rejected send" };
    vi.spyOn(clientManager, "safeSendMessage").mockReturnValue(
      Result.err(
        new NexusConnectionError(
          "closed",
          "E_CONN_CLOSED",
          { connectionId: clientConnectionId },
          cause,
        ),
      ),
    );
    const proxy = clientEngine.createServiceProxy<any>("testService", {
      connectionId: clientConnectionId,
      timeout: 5000,
    });
    const result = await Nexus.safeCall(proxy.someMethod());
    expect(result).toMatchObject({
      error: {
        code: "E_CONN_CLOSED",
        cause,
        context: { connectionId: clientConnectionId },
      },
    });
    expect(result.isErr() && result.error).toBeInstanceOf(
      NexusDisconnectedError,
    );
  });

  it("safeRelease succeeds locally even when the release notification cannot be sent", async () => {
    const nexus = new Nexus();
    hostEngine.provideServices([
      {
        token: new Token("resourceService"),
        service: { open: () => nexus.ref({ run() {} }) },
      },
    ]);
    const service = clientEngine.createServiceProxy<any>("resourceService", {
      connectionId: clientConnectionId,
      timeout: 5000,
    });
    const resource = await service.open();
    const error = new NexusConnectionError(
      "connection closed",
      "E_CONN_CLOSED",
    );
    const send = vi
      .spyOn(clientManager, "safeSendMessage")
      .mockReturnValue(Result.err(error));
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    expect(Nexus.safeRelease(resource).isOk()).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      {
        type: NexusMessageType.RELEASE,
        id: null,
        resourceId: expect.any(String),
        scopeId: expect.any(String),
      },
      clientConnectionId,
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`to ${clientConnectionId}.`),
      expect.objectContaining({
        code: "E_CONN_CLOSED",
        message: error.message,
      }),
    );
    await expect(resource.run()).rejects.toMatchObject({
      code: "E_RESOURCE_ACCESS_DENIED",
    });
    resource[RELEASE_PROXY_SYMBOL]();
    expect(send).toHaveBeenCalledOnce();
  });

  it("should delegate dispatchCall to CallProcessor", async () => {
    const callProcessorSpy = vi.spyOn(CallProcessor.prototype, "safeProcess");

    // Create a proxy to trigger the call
    const proxy = clientEngine.createServiceProxy<any>("testService", {
      connectionId: clientConnectionId,
      timeout: 5000,
    });

    // Declaring a lazy call does not reach the processor; consuming it does.
    await proxy.someMethod("arg1", 2);

    expect(callProcessorSpy).toHaveBeenCalledOnce();

    const [options] = callProcessorSpy.mock.calls[0] as [
      {
        type: string;
        path: (string | number)[];
        args?: any[];
      },
    ];
    expect(options.type).toBe("APPLY");
    expect(options.path).toEqual(["testService", "someMethod"]);
    expect(options.args).toEqual(["arg1", 2]);
  });

  it("should forward incoming messages to the message handler", async () => {
    const handleMessageSpy = vi.spyOn(
      MessageHandler.prototype,
      "safeHandleMessage",
    );

    const message: ApplyMessage = {
      type: NexusMessageType.APPLY,
      id: 1,
      resourceId: null,
      path: ["testService", "someMethod"],
      args: [],
    };

    // Simulate L2 passing a message to L3
    await hostEngine.onMessage(message, hostConnectionId);

    expect(handleMessageSpy).toHaveBeenCalledWith(
      message,
      hostConnectionId,
      undefined,
      undefined,
    );
  });

  it.each([false, true])(
    "consumes inbound failure without reply or disconnect (logger throws: %s)",
    async (throws) => {
      const failure = new Error("inbound processing failed");
      const handle = vi.spyOn(MessageHandler.prototype, "safeHandleMessage");
      handle.mockResolvedValueOnce(Result.err(failure));
      const log = vi.fn(() => {
        if (throws) throw new Error("diagnostic sink failed");
      });
      configureNexusLogger({
        enabled: true,
        level: LogLevel.ERROR,
        handler: log,
      });
      const session = hostManager.getConnection(hostConnectionId)!;
      const send = vi.spyOn(hostManager, "safeSendMessage");
      const completed = vi.spyOn(hostEngine, "onMessage");
      const result = await session.safeHandleMessage({
        type: NexusMessageType.RELEASE,
        id: null,
        resourceId: "unused",
      });
      // L2 hands business work off; Engine consumes its own failure.
      expect(result.isOk()).toBe(true);
      await expect(completed.mock.results[0]!.value).resolves.toBeUndefined();
      expect(handle).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledExactlyOnceWith(
        LogLevel.ERROR,
        "Nexus-L3 --- Engine",
        "Incoming message handling failed",
        failure,
      );
      expect(send).not.toHaveBeenCalled();
      const proxy = clientEngine.createServiceProxy<any>("testService", {
        connectionId: clientConnectionId,
        timeout: 5000,
      });
      await expect(proxy.someMethod()).resolves.toBeUndefined();
      expect(session.isReady()).toBe(true);
    },
  );

  it("should notify managers on disconnect", () => {
    const resourceManagerSpy = vi.spyOn(
      (clientEngine as any).resourceManager,
      "cleanupConnection",
    );
    const pendingCallManagerSpy = vi.spyOn(
      (clientEngine as any).pendingCallManager,
      "onDisconnect",
    );

    // Simulate L2 notifying L3 of a disconnect
    clientEngine.onDisconnect(clientConnectionId);

    expect(resourceManagerSpy).toHaveBeenCalledWith(clientConnectionId);
    expect(pendingCallManagerSpy).toHaveBeenCalledWith(clientConnectionId);
  });

  it("should invoke disconnect hooks declared with matching global symbols", () => {
    const onDisconnect = vi.fn();
    const service = {
      [Symbol("nexus.service.on.disconnect")]: onDisconnect,
    };
    (hostEngine as any).resourceManager.registerExposedServices([
      { name: "globalSymbolService", service },
    ]);

    hostEngine.onDisconnect(hostConnectionId);

    expect((service as any)[SERVICE_ON_DISCONNECT]).toBeUndefined();
    expect(onDisconnect).toHaveBeenCalledWith(hostConnectionId);
  });

  it("continues disconnect cleanup after an exposed service hook throws", () => {
    const throwingHook = vi.fn(() => {
      throw new Error("service disconnect failure");
    });
    const laterHook = vi.fn();
    (hostEngine as any).resourceManager.registerExposedServices([
      {
        name: "throwingDisconnectService",
        service: { [SERVICE_ON_DISCONNECT]: throwingHook },
      },
      {
        name: "laterDisconnectService",
        service: { [SERVICE_ON_DISCONNECT]: laterHook },
      },
    ]);
    const resourceManagerSpy = vi.spyOn(
      (hostEngine as any).resourceManager,
      "cleanupConnection",
    );
    const pendingCallManagerSpy = vi.spyOn(
      (hostEngine as any).pendingCallManager,
      "onDisconnect",
    );

    expect(() => hostEngine.onDisconnect(hostConnectionId)).not.toThrow();
    expect(throwingHook).toHaveBeenCalledWith(hostConnectionId);
    expect(laterHook).toHaveBeenCalledWith(hostConnectionId);
    expect(resourceManagerSpy).toHaveBeenCalledWith(hostConnectionId);
    expect(pendingCallManagerSpy).toHaveBeenCalledWith(hostConnectionId);
  });

  it("looks up only disconnect hooks and isolates throwing hook getters", () => {
    const unrelated = vi.fn(() => {
      throw new Error("must not inspect start hook");
    });
    const disconnected = vi.fn();
    const service = {
      get [Symbol.for("nexus.service.invoke.start")]() {
        return unrelated();
      },
      [SERVICE_ON_DISCONNECT]: disconnected,
    };
    (hostEngine as any).resourceManager.registerExposedServices([
      { name: "unrelated", service },
      {
        name: "throwingGetter",
        service: {
          get [SERVICE_ON_DISCONNECT]() {
            throw new Error("getter failed");
          },
        },
      },
    ]);
    const later = vi.fn();
    (hostEngine as any).resourceManager.registerExposedServices([
      { name: "later", service: { [SERVICE_ON_DISCONNECT]: later } },
    ]);

    expect(() => hostEngine.onDisconnect(hostConnectionId)).not.toThrow();
    expect(unrelated).not.toHaveBeenCalled();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
  });

  // The other tests about connection resolution and pending call registration
  // are now moved to call-processor.test.ts because they test the logic
  // that is no longer in the Engine.
});
