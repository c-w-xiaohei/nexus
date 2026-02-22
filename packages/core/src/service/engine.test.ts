import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Engine } from "./engine";
import { NexusMessageType, type ApplyMessage } from "@/types/message";
import { createL3Endpoints } from "@/utils/test-utils";

// A mock service to be registered on the host engine for tests.
const mockTestService = {
  someMethod: vi.fn(),
  anotherMethod: vi.fn(),
};

describe("Engine", () => {
  let clientEngine: Engine<any, any>;
  let hostEngine: Engine<any, any>;
  let clientConnectionId: string;
  let hostConnectionId: string;

  beforeEach(async () => {
    // This helper creates two fully connected L3 engines.
    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        services: { testService: mockTestService },
      },
      { meta: { id: "client" } },
    );

    clientEngine = setup.clientEngine;
    hostEngine = setup.hostEngine;
    clientConnectionId = setup.clientConnection.connectionId;
    hostConnectionId = setup.hostConnection.connectionId;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should delegate dispatchCall to CallProcessor", async () => {
    const callProcessorSpy = vi.spyOn(
      (clientEngine as any).callProcessor,
      "safeProcess",
    );

    // Create a proxy to trigger the call
    const proxy = clientEngine.createServiceProxy<any>("testService", {
      target: { connectionId: clientConnectionId },
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
      (hostEngine as any).messageHandler,
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

  // The other tests about connection resolution and pending call registration
  // are now moved to call-processor.test.ts because they test the logic
  // that is no longer in the Engine.
});
