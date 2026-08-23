import { describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import { PayloadProcessor } from "./payload-processor";
import { Placeholder } from "./placeholder";
import { PlaceholderType } from "./protocol";
import { ProxyFactory, type ProxyFactoryCallbacks } from "../proxy-factory";
import { ResourceManager } from "../resource-manager";

const { ok } = Result;
const sourceConnectionId = "conn-source";

const resource = (resourceId: string): string =>
  new Placeholder(PlaceholderType.RESOURCE, resourceId).toString();

const malformedMap = new Placeholder(
  PlaceholderType.MAP,
  "not-json",
).toString();

const createPayloadProcessor = () => {
  const resourceManager = ResourceManager.create();
  const engine: ProxyFactoryCallbacks = {
    safeDispatchCall: vi.fn(() => Promise.resolve(ok(undefined))),
    dispatchRelease: vi.fn(),
  };
  const proxyFactory = new ProxyFactory(engine, resourceManager);
  return {
    engine,
    resourceManager,
    payloadProcessor: PayloadProcessor.create(resourceManager, proxyFactory),
  };
};

describe("PayloadProcessor resource identity", () => {
  it("reuses one proxy for duplicate resource identities within a successful payload", () => {
    const { payloadProcessor, resourceManager } = createPayloadProcessor();

    const result = payloadProcessor.safeRevive(
      [resource("res-1"), resource("res-1")],
      sourceConnectionId,
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value[0]).toBe(result.value[1]);
    expect(resourceManager.countRemoteProxies()).toBe(1);
  });

  it("releases a duplicate new identity once when a later placeholder fails", () => {
    const { engine, payloadProcessor, resourceManager } =
      createPayloadProcessor();

    const result = payloadProcessor.safeRevive(
      [resource("res-1"), resource("res-1"), malformedMap],
      sourceConnectionId,
    );

    expect(result.isErr()).toBe(true);
    expect(engine.dispatchRelease).toHaveBeenCalledOnce();
    expect(engine.dispatchRelease).toHaveBeenCalledWith(
      "res-1",
      sourceConnectionId,
    );
    expect(resourceManager.countRemoteProxies()).toBe(0);
  });

  it("discards a failed revive's temporary facade for an existing identity", () => {
    const registrations = new Map<object, unknown>();
    let latestRegistrationToken: object | undefined;
    let finalize: (heldValue: unknown) => void;
    const originalFinalizationRegistry = global.FinalizationRegistry;
    global.FinalizationRegistry = class {
      constructor(callback: (heldValue: unknown) => void) {
        finalize = callback;
      }

      register(target: object, heldValue: unknown, token?: object): void {
        const unregisterToken = token ?? target;
        latestRegistrationToken = unregisterToken;
        registrations.set(unregisterToken, heldValue);
      }

      unregister(token: object): boolean {
        return registrations.delete(token);
      }
    } as any;

    try {
      const { engine, payloadProcessor, resourceManager } =
        createPayloadProcessor();
      payloadProcessor.safeRevive(
        [resource("res-existing")],
        sourceConnectionId,
      );

      const result = payloadProcessor.safeRevive(
        [resource("res-existing"), malformedMap],
        sourceConnectionId,
      );
      const temporaryFacadeToken = latestRegistrationToken;
      expect(temporaryFacadeToken).toBeDefined();
      const heldValue = registrations.get(temporaryFacadeToken!);
      if (heldValue) finalize(heldValue);

      expect(result.isErr()).toBe(true);
      expect(registrations.has(temporaryFacadeToken!)).toBe(false);
      expect(engine.dispatchRelease).not.toHaveBeenCalled();
      expect(
        resourceManager.hasRemoteProxy("res-existing", sourceConnectionId),
      ).toBe(true);
    } finally {
      global.FinalizationRegistry = originalFinalizationRegistry;
    }
  });
});
