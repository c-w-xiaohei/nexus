import { describe, it, expect, beforeEach, vi, type Mocked } from "vitest";
import { Engine } from "./engine";
import { ProxyFactory } from "./proxy-factory";
import { ResourceManager } from "./resource-manager";

// Mock the Engine class. The mock will be hoisted.
vi.mock("./engine");

// Mock the global FinalizationRegistry
const mockFinalizationRegistryCallback = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();
global.FinalizationRegistry = vi.fn().mockImplementation((callback) => {
  // Capture the callback passed to the constructor for manual invocation
  mockFinalizationRegistryCallback.mockImplementation(callback);
  return {
    register: mockRegister,
    unregister: mockUnregister,
  };
});

describe("ProxyFactory", () => {
  let proxyFactory: ProxyFactory<any, any>;
  let mockEngine: Mocked<Engine<any, any>>;
  let resourceManager: ResourceManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a mock instance of the Engine using the vi.mocked helper
    mockEngine = new (Engine as any)() as Mocked<Engine<any, any>>;
    mockEngine.dispatchCall = vi
      .fn()
      .mockResolvedValue("mocked promise result");
    mockEngine.dispatchRelease = vi.fn();

    resourceManager = new ResourceManager();
    proxyFactory = new ProxyFactory(mockEngine, resourceManager);
  });

  describe("createServiceProxy", () => {
    it("should dispatch an APPLY call on method invocation", () => {
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { connectionId: "conn-1" },
      });

      serviceProxy.doSomething("hello", 123);

      expect(mockEngine.dispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.dispatchCall).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "APPLY",
          target: { connectionId: "conn-1" },
          resourceId: null,
          path: ["api", "doSomething"],
          args: ["hello", 123],
        })
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
      mockEngine.dispatchCall.mockReturnValue(
        Promise.resolve("mocked promise result")
      );
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { connectionId: "conn-1" },
      });
      // The `get` trap returns a promise, so we await it to trigger the call
      await serviceProxy.getValue;

      expect(mockEngine.dispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.dispatchCall).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "GET",
          target: { connectionId: "conn-1" },
          resourceId: null,
          path: ["api", "getValue"],
        })
      );
    });

    it("should not dispatch a call on simple property access", () => {
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { connectionId: "conn-1" },
      });
      const method = serviceProxy.doSomething; // Access without calling
      expect(method).toBeTypeOf("function");
      expect(mockEngine.dispatchCall).not.toHaveBeenCalled();
    });

    it("should pass strategy and timeout options to dispatchCall", () => {
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { groupName: "workers" },
        strategy: "stream",
        timeout: 1000,
      });

      serviceProxy.doWork();

      expect(mockEngine.dispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.dispatchCall).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "APPLY",
          target: { groupName: "workers" },
          resourceId: null,
          path: ["api", "doWork"],
          args: [],
          strategy: "stream",
          timeout: 1000,
        })
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
      expect(resourceManagerCallArgs[1]).toBe(proxy); // Check for reference equality
      expect(resourceManagerCallArgs[2]).toBe("conn-1");

      expect(mockRegister).toHaveBeenCalledOnce();
      const finalizationRegistryCallArgs = mockRegister.mock.calls[0];
      expect(finalizationRegistryCallArgs[0]).toBe(proxy); // Check for reference equality
      expect(finalizationRegistryCallArgs[1]).toEqual({
        resourceId: "res-123",
        connectionId: "conn-1",
      });
    });

    it("should dispatch an APPLY call when the proxy is called as a function", () => {
      const remoteFn: any = proxyFactory.createRemoteResourceProxy(
        "res-func",
        "conn-2"
      );
      remoteFn("arg1", { key: "value" });

      expect(mockEngine.dispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.dispatchCall).toHaveBeenCalledWith({
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
        "conn-3"
      );
      // Await the property to trigger the 'then' trap in the proxy
      const result = await remoteObj.someProp;

      expect(mockEngine.dispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.dispatchCall).toHaveBeenCalledWith({
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
        "conn-4"
      );
      remoteObj.someProp = "new value";

      expect(mockEngine.dispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.dispatchCall).toHaveBeenCalledWith({
        type: "SET",
        target: { connectionId: "conn-4" },
        resourceId: "res-obj",
        path: ["someProp"],
        value: "new value",
      });
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
        releaseContext.connectionId
      );
    });
  });
});
