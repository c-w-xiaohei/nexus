import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Engine } from "./engine";
import { CallProcessor } from "./call-processor";
import { MessageHandler } from "./message/message-handler";
import { NexusMessageType, type ApplyMessage } from "@/types/message";
import { createL3Endpoints } from "@/utils/test-utils";
import { SERVICE_ON_DISCONNECT } from "./service-invocation-hooks";
import { Nexus } from "@/api/nexus";
import { NexusDisconnectedError, NexusUsageError } from "@/errors";
import { Result } from "better-result";
import { Logger } from "@/logger";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("safeRelease succeeds locally even when the release notification cannot be sent", async () => {
    const error = new NexusDisconnectedError("connection closed");
    const send = vi
      .spyOn(clientEngine, "safeSendMessage")
      .mockReturnValue(Result.err(error));
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const resource: any = (
      clientEngine as any
    ).proxyFactory.createRemoteResourceProxy("released", clientConnectionId);

    expect(Nexus.safeRelease(resource).isOk()).toBe(true);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { type: NexusMessageType.RELEASE, id: null, resourceId: "released" },
      clientConnectionId,
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `Failed to dispatch release for resource #released to ${clientConnectionId}.`,
      error,
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
      target: { connectionId: clientConnectionId },
      strategy: "one",
      timeout: 5000,
    });

    // Trigger the call
    proxy.someMethod("arg1", 2);

    // Wait for the async processing to occur
    await vi.waitFor(() => {
      expect(callProcessorSpy).toHaveBeenCalledOnce();
    });

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
    await hostEngine.safeOnMessage(message, hostConnectionId);

    expect(handleMessageSpy).toHaveBeenCalledWith(message, hostConnectionId);
  });

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
    (hostEngine as any).resourceManager.registerExposedService(
      "globalSymbolService",
      service,
    );

    hostEngine.onDisconnect(hostConnectionId);

    expect((service as any)[SERVICE_ON_DISCONNECT]).toBeUndefined();
    expect(onDisconnect).toHaveBeenCalledWith(hostConnectionId);
  });

  it("continues disconnect cleanup after an exposed service hook throws", () => {
    const throwingHook = vi.fn(() => {
      throw new Error("service disconnect failure");
    });
    const laterHook = vi.fn();
    (hostEngine as any).resourceManager.registerExposedService(
      "throwingDisconnectService",
      { [SERVICE_ON_DISCONNECT]: throwingHook },
    );
    (hostEngine as any).resourceManager.registerExposedService(
      "laterDisconnectService",
      { [SERVICE_ON_DISCONNECT]: laterHook },
    );
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

  it("evaluates identity staleness with immutable connection metadata", () => {
    const where = vi.fn(
      (identity: { id: string }, connection: { from: string }) =>
        identity.id === "host" && connection.from === "transport",
    );
    const proxy = clientEngine.createServiceProxy<any>("testService", {
      target: { connectionId: clientConnectionId },
      strategy: "one",
      timeout: 5000,
      staleTarget: { where },
    });

    clientEngine.onConnectionTargetStale(
      clientConnectionId,
      { id: "replacement" },
      { id: "host" },
      { from: "transport" },
    );

    expect(where).toHaveBeenNthCalledWith(
      1,
      { id: "host" },
      {
        from: "transport",
      },
    );
    expect(where).toHaveBeenNthCalledWith(
      2,
      { id: "replacement" },
      {
        from: "transport",
      },
    );
    expect(Nexus.getProxyStatus(proxy)).toEqual({
      type: "active",
      selection: "stale",
    });
  });

  it("exposes status and constrained diagnostics only for exact unicast roots", () => {
    const proxy = clientEngine.createServiceProxy<any>("testService", {
      target: { connectionId: clientConnectionId },
      strategy: "one",
      timeout: 5000,
    });
    const current = Nexus.getProxyStatus(proxy);

    expect(Nexus.getProxyStatus(proxy)).toBe(current);
    expect(Nexus.inspectProxy(proxy)).toEqual({
      tokenId: "testService",
      connectionId: clientConnectionId,
      status: { type: "active", selection: "current" },
    });
    expect(() => Nexus.getProxyStatus(proxy.method)).toThrow(NexusUsageError);
    expect(() => Nexus.inspectProxy({})).toThrow(NexusUsageError);

    clientEngine.onDisconnect(clientConnectionId);
    expect(Nexus.getProxyStatus(proxy)).toMatchObject({
      type: "disconnected",
      error: expect.any(NexusDisconnectedError),
    });
  });

  it("continues stale target evaluation after a predicate throws", () => {
    const throwingWhere = vi.fn(() => {
      throw new Error("stale target predicate failure");
    });
    const matchingWhere = vi.fn(
      (identity: { id: string }) => identity.id === "host",
    );
    const throwingProxy = clientEngine.createServiceProxy<any>("testService", {
      target: { connectionId: clientConnectionId },
      strategy: "one",
      timeout: 5000,
      staleTarget: { where: throwingWhere },
    });
    const matchingProxy = clientEngine.createServiceProxy<any>("testService", {
      target: { connectionId: clientConnectionId },
      strategy: "one",
      timeout: 5000,
      staleTarget: { where: matchingWhere },
    });
    const throwingListener = vi.fn();
    const matchingListener = vi.fn();
    Nexus.subscribeProxyStatus(throwingProxy, throwingListener);
    Nexus.subscribeProxyStatus(matchingProxy, matchingListener);

    expect(() =>
      clientEngine.onConnectionTargetStale(
        clientConnectionId,
        { id: "replacement" },
        { id: "host" },
        {},
      ),
    ).not.toThrow();
    expect(throwingListener).toHaveBeenCalledOnce();
    expect(matchingListener).toHaveBeenCalledTimes(2);

    clientEngine.onConnectionTargetStale(
      clientConnectionId,
      { id: "replacement" },
      { id: "host" },
      {},
    );

    expect(throwingWhere).toHaveBeenCalledTimes(2);
    expect(matchingListener).toHaveBeenCalledTimes(2);
  });

  // The other tests about connection resolution and pending call registration
  // are now moved to call-processor.test.ts because they test the logic
  // that is no longer in the Engine.
});
