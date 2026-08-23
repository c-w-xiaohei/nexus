import { describe, it, expect, beforeEach, vi, type Mocked } from "vitest";
import type { ProxyFactoryCallbacks } from "./proxy-factory";
import { ProxyFactory } from "./proxy-factory";
import { ResourceManager } from "./resource-manager";
import { Result } from "better-result";
const { ok } = Result;
import { RELEASE_PROXY_SYMBOL } from "../types/symbols";
import { NexusResourceError } from "@/errors/resource-errors";

// Mock the global FinalizationRegistry
const mockFinalizationRegistryCallback = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();
const finalizationRegistrations = new Map<object, unknown>();
global.FinalizationRegistry = class {
  constructor(callback: any) {
    mockFinalizationRegistryCallback.mockImplementation(callback);
  }

  register = mockRegister.mockImplementation(
    (target: object, heldValue: unknown, unregisterToken?: object) => {
      finalizationRegistrations.set(unregisterToken ?? target, heldValue);
    },
  );
  unregister = mockUnregister.mockImplementation((unregisterToken: object) =>
    finalizationRegistrations.delete(unregisterToken),
  );
} as any;

const simulateFinalization = (unregisterToken: object): void => {
  const heldValue = finalizationRegistrations.get(unregisterToken);
  if (!heldValue) return;
  finalizationRegistrations.delete(unregisterToken);
  mockFinalizationRegistryCallback(heldValue);
};

describe("ProxyFactory", () => {
  let proxyFactory: ProxyFactory<any>;
  let mockEngine: Mocked<ProxyFactoryCallbacks>;
  let resourceManager: ResourceManager.Runtime;

  beforeEach(() => {
    vi.clearAllMocks();
    finalizationRegistrations.clear();

    mockEngine = {
      safeDispatchCall: vi
        .fn()
        .mockReturnValue(Promise.resolve(ok("mocked promise result"))),
      dispatchRelease: vi.fn(),
    } as unknown as Mocked<ProxyFactoryCallbacks>;
    mockEngine.safeDispatchCall = vi
      .fn()
      .mockReturnValue(Promise.resolve(ok("mocked promise result")));
    mockEngine.dispatchRelease = vi.fn();

    resourceManager = ResourceManager.create();
    proxyFactory = new ProxyFactory(mockEngine, resourceManager);
  });

  describe("createServiceProxy", () => {
    it("should dispatch an APPLY call on method invocation", () => {
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { connectionId: "conn-1" },
      });

      serviceProxy.doSomething("hello", 123);

      expect(mockEngine.safeDispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.safeDispatchCall).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "APPLY",
          target: { connectionId: "conn-1" },
          resourceId: null,
          path: ["api", "doSomething"],
          args: ["hello", 123],
        }),
      );
    });

    it("should return the promise from dispatchCall on method invocation", async () => {
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { connectionId: "conn-1" },
      });
      const promise = serviceProxy.doSomething();
      await expect(promise).resolves.toBe("mocked promise result");
    });

    it("should dispatch a GET call when a property is awaited", async () => {
      mockEngine.safeDispatchCall.mockReturnValue(
        Promise.resolve(ok("mocked promise result")),
      );
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { connectionId: "conn-1" },
      });
      // The `get` trap returns a promise, so we await it to trigger the call
      await serviceProxy.getValue;

      expect(mockEngine.safeDispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.safeDispatchCall).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "GET",
          target: { connectionId: "conn-1" },
          resourceId: null,
          path: ["api", "getValue"],
        }),
      );
    });

    it("should not dispatch a call on simple property access", () => {
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { connectionId: "conn-1" },
      });
      const method = serviceProxy.doSomething; // Access without calling
      expect(method).toBeTypeOf("function");
      expect(mockEngine.safeDispatchCall).not.toHaveBeenCalled();
    });

    it("should pass strategy and timeout options to dispatchCall", () => {
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { group: "workers" },
        strategy: "stream",
        timeout: 1000,
      });

      serviceProxy.doWork();

      expect(mockEngine.safeDispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.safeDispatchCall).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "APPLY",
          target: { group: "workers" },
          resourceId: null,
          path: ["api", "doWork"],
          args: [],
          strategy: "stream",
          timeout: 1000,
        }),
      );
    });
  });

  describe("createRemoteResourceProxy", () => {
    let spyRegisterRemoteProxy: any;

    beforeEach(() => {
      spyRegisterRemoteProxy = vi.spyOn(resourceManager, "registerRemoteProxy");
    });

    it("should register the proxy with ResourceManager and FinalizationRegistry on creation", () => {
      const proxy = proxyFactory.createRemoteResourceProxy("res-123", "conn-1");

      // We inspect the mock calls directly to avoid the test runner's deep
      // equality check from accidentally triggering proxy traps.

      expect(spyRegisterRemoteProxy).toHaveBeenCalledOnce();
      const resourceManagerCallArgs = spyRegisterRemoteProxy.mock.calls[0];
      expect(resourceManagerCallArgs[0]).toBe("res-123");
      expect(resourceManagerCallArgs[1]).toBe("conn-1");

      expect(mockRegister).toHaveBeenCalledOnce();
      const finalizationRegistryCallArgs = mockRegister.mock.calls[0];
      expect(finalizationRegistryCallArgs[0]).not.toBe(proxy);
      expect(finalizationRegistryCallArgs[0]).toBeTypeOf("object");
      expect(finalizationRegistryCallArgs[1]).toEqual({
        resourceId: "res-123",
        connectionId: "conn-1",
      });
      expect(finalizationRegistryCallArgs[2]).toBe(
        finalizationRegistryCallArgs[0],
      );
    });

    it("should dispatch an APPLY call when the proxy is called as a function", () => {
      const remoteFn: any = proxyFactory.createRemoteResourceProxy(
        "res-func",
        "conn-2",
      );
      remoteFn("arg1", { key: "value" });

      expect(mockEngine.safeDispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.safeDispatchCall).toHaveBeenCalledWith({
        type: "APPLY",
        target: { connectionId: "conn-2" },
        resourceId: "res-func",
        path: [],
        args: ["arg1", { key: "value" }],
      });
    });

    it("should dispatch a GET call on property access and return a promise", async () => {
      const remoteObj: any = proxyFactory.createRemoteResourceProxy(
        "res-obj",
        "conn-3",
      );
      // Await the property to trigger the 'then' trap in the proxy
      const result = await remoteObj.someProp;

      expect(mockEngine.safeDispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.safeDispatchCall).toHaveBeenCalledWith({
        type: "GET",
        target: { connectionId: "conn-3" },
        resourceId: "res-obj",
        path: ["someProp"],
      });

      // Also check that the result is passed through from the mocked engine
      expect(result).toBe("mocked promise result");
    });

    it("should dispatch a SET call on property assignment", () => {
      const remoteObj: any = proxyFactory.createRemoteResourceProxy(
        "res-obj",
        "conn-4",
      );
      remoteObj.someProp = "new value";

      expect(mockEngine.safeDispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.safeDispatchCall).toHaveBeenCalledWith({
        type: "SET",
        target: { connectionId: "conn-4" },
        resourceId: "res-obj",
        path: ["someProp"],
        value: "new value",
      });
    });

    it("should unregister remote proxy on explicit release", () => {
      const remoteObj: any = proxyFactory.createRemoteResourceProxy(
        "res-release",
        "conn-5",
      );

      expect(resourceManager.countRemoteProxies()).toBe(1);
      remoteObj[RELEASE_PROXY_SYMBOL]();

      expect(mockEngine.dispatchRelease).toHaveBeenCalledWith(
        "res-release",
        "conn-5",
      );
      expect(resourceManager.countRemoteProxies()).toBe(0);
      expect(mockUnregister).toHaveBeenCalledWith(
        mockRegister.mock.calls[0][0],
      );
      simulateFinalization(mockRegister.mock.calls[0][0]);
      expect(mockEngine.dispatchRelease).toHaveBeenCalledOnce();
    });

    it("uses one finalization anchor for root and deep resource facades", async () => {
      const remoteObj: any = proxyFactory.createRemoteResourceProxy(
        "res-shared-lifetime",
        "conn-8",
      );
      const nested = remoteObj.deep.path;

      expect(mockRegister).toHaveBeenCalledOnce();
      expect(mockRegister.mock.calls[0][0]).not.toBe(remoteObj);
      expect(mockRegister.mock.calls[0][0]).not.toBe(nested);

      nested[RELEASE_PROXY_SYMBOL]();

      expect(mockEngine.dispatchRelease).toHaveBeenCalledOnce();
      expect(mockUnregister).toHaveBeenCalledWith(
        mockRegister.mock.calls[0][0],
      );
      await expect(remoteObj.run()).rejects.toThrow(/released/i);
    });

    it("should reject calls after explicit release", async () => {
      const remoteObj: any = proxyFactory.createRemoteResourceProxy(
        "res-release-guard",
        "conn-6",
      );

      remoteObj[RELEASE_PROXY_SYMBOL]();

      await expect(remoteObj.run()).rejects.toThrow(/released/i);
      await expect(remoteObj.someProp).rejects.toThrow(/released/i);
    });

    it("should throw a typed resource error on property assignment after explicit release", () => {
      const remoteObj: any = proxyFactory.createRemoteResourceProxy(
        "res-release-set-guard",
        "conn-7",
      );

      remoteObj[RELEASE_PROXY_SYMBOL]();

      expect(() => {
        remoteObj.someProp = "new value";
      }).toThrow(NexusResourceError);
      expect(() => {
        remoteObj.someProp = "new value";
      }).toThrow(/released/i);
      expect(mockEngine.safeDispatchCall).not.toHaveBeenCalled();
    });
  });

  describe("FinalizationRegistry Callback", () => {
    it("should dispatch a release message when a proxy is garbage collected", () => {
      // The callback is captured when the ProxyFactory is instantiated in beforeEach
      expect(mockFinalizationRegistryCallback).not.toHaveBeenCalled();

      // Manually trigger the captured callback, simulating GC
      const releaseContext = { resourceId: "res-gc", connectionId: "conn-gc" };
      mockFinalizationRegistryCallback(releaseContext);

      expect(mockEngine.dispatchRelease).toHaveBeenCalledOnce();
      expect(mockEngine.dispatchRelease).toHaveBeenCalledWith(
        releaseContext.resourceId,
        releaseContext.connectionId,
      );
    });
  });
});
