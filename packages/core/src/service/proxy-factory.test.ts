import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mocked,
} from "vitest";
import { ProxyFactory } from "./proxy-factory";
import { ResourceManager } from "./resource-manager";
import { LocalResourceType } from "./types";
import { Result } from "better-result";
const { ok } = Result;
import { RELEASE_PROXY_SYMBOL } from "../types/symbols";
import { NexusResourceError } from "@/errors/resource-errors";
import { Logger } from "@/logger";

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
  let proxyFactory: ProxyFactory;
  let mockEngine: Mocked<ConstructorParameters<typeof ProxyFactory>[0]>;
  let resourceManager: ResourceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    finalizationRegistrations.clear();

    mockEngine = {
      safeDispatchCall: vi
        .fn()
        .mockReturnValue(Promise.resolve(ok("mocked promise result"))),
      dispatchRelease: vi.fn(),
    } as unknown as Mocked<ConstructorParameters<typeof ProxyFactory>[0]>;
    mockEngine.safeDispatchCall = vi
      .fn()
      .mockReturnValue(Promise.resolve(ok("mocked promise result")));
    mockEngine.dispatchRelease = vi.fn();

    resourceManager = new ResourceManager();
    proxyFactory = new ProxyFactory(mockEngine, resourceManager);
  });

  afterEach(() => vi.restoreAllMocks());

  describe("error ownership", () => {
    it.each(["GET", "APPLY"] as const)(
      "returns %s errors to the caller without logging them",
      async (operation) => {
        const log = vi
          .spyOn(Logger.prototype, "error")
          .mockImplementation(() => {});
        const error = new NexusResourceError(
          "remote read denied",
          "E_RESOURCE_ACCESS_DENIED",
          { resourceId: "protected" },
        );
        mockEngine.safeDispatchCall.mockResolvedValueOnce(Result.err(error));
        const proxy: any = proxyFactory.createServiceProxy("api", {
          target: { connectionId: "A" },
          strategy: "one",
          timeout: 1000,
        });

        const result =
          operation === "GET" ? Promise.resolve(proxy.value) : proxy.read();
        await expect(result).rejects.toBe(error);
        expect(log).not.toHaveBeenCalled();
      },
    );

    it.each(["error", "throw"] as const)(
      "observes background SET %s without changing the assignment result",
      async (failure) => {
        const error = new NexusResourceError(
          "remote write denied",
          "E_RESOURCE_ACCESS_DENIED",
        );
        let logged!: () => void;
        const observed = new Promise<void>((resolve) => {
          logged = resolve;
        });
        const log = vi
          .spyOn(Logger.prototype, "error")
          .mockImplementation(() => logged());
        mockEngine.safeDispatchCall.mockImplementationOnce(() => {
          if (failure === "throw") throw error;
          return Promise.resolve(Result.err(error));
        });
        const resource: any = proxyFactory.createRemoteResourceProxy(
          "writable",
          "A",
        );

        expect((resource.value = 12)).toBe(12);
        await observed;
        expect(log).toHaveBeenCalledExactlyOnceWith(
          "Remote property assignment failed",
          error,
        );
      },
    );

    it("reports a released SET synchronously instead of scheduling a background write", () => {
      const log = vi
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => {});
      const resource: any = proxyFactory.createRemoteResourceProxy(
        "released",
        "A",
      );
      resource[RELEASE_PROXY_SYMBOL]();
      expect(() => {
        resource.value = 12;
      }).toThrow(NexusResourceError);
      expect(mockEngine.safeDispatchCall).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe("createServiceProxy", () => {
    it("keeps roots non-thenable and captures the original multicast binding", async () => {
      const ids = ["A", "B"];
      const options = {
        target: { connectionIds: ids },
        strategy: "all" as const,
        timeout: 1000,
      };
      const service: any = proxyFactory.createServiceProxy("api", options);
      const resource: any = proxyFactory.createRemoteResourceProxy(
        "resource",
        "A",
      );
      expect(await Promise.resolve(service)).toBe(service);
      expect(await Promise.resolve(resource)).toBe(resource);
      expect(mockEngine.safeDispatchCall).not.toHaveBeenCalled();
      ids.push("C");
      options.timeout = 10;
      await service.run();
      expect(mockEngine.safeDispatchCall).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { connectionIds: ["A", "B"] },
          timeout: 1000,
        }),
      );
    });
    it("keeps paths and bindings isolated while traps are shared", async () => {
      const first: any = proxyFactory.createServiceProxy("first", {
        target: { connectionId: "A" },
        strategy: "one",
        timeout: 1000,
      });
      const second: any = proxyFactory.createServiceProxy("second", {
        target: { connectionId: "B" },
        strategy: "one",
        timeout: 2000,
      });
      const firstMethod = first.nested.run;
      const secondMethod = second.run;
      await secondMethod(2);
      await firstMethod(1);
      await first.value;
      expect(
        mockEngine.safeDispatchCall.mock.calls.map(([options]) => options),
      ).toEqual([
        {
          target: { connectionId: "B" },
          strategy: "one",
          timeout: 2000,
          resourceId: null,
          type: "APPLY",
          path: ["second", "run"],
          args: [2],
        },
        {
          target: { connectionId: "A" },
          strategy: "one",
          timeout: 1000,
          resourceId: null,
          type: "APPLY",
          path: ["first", "nested", "run"],
          args: [1],
        },
        {
          target: { connectionId: "A" },
          strategy: "one",
          timeout: 1000,
          resourceId: null,
          type: "GET",
          path: ["first", "value"],
        },
      ]);
    });

    it("releasing a resource scope does not affect other proxies from the factory", async () => {
      const first: any = proxyFactory.createRemoteResourceProxy("first", "A");
      const second: any = proxyFactory.createRemoteResourceProxy("second", "B");
      const firstMethod = first.nested.run;
      const release = first[RELEASE_PROXY_SYMBOL];
      release();
      await expect(firstMethod()).rejects.toMatchObject({
        code: "E_RESOURCE_ACCESS_DENIED",
      });
      await second.run();
      expect(mockEngine.safeDispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.safeDispatchCall).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: "second",
          target: { connectionId: "B" },
        }),
      );
      expect(mockEngine.dispatchRelease).toHaveBeenCalledExactlyOnceWith(
        "first",
        "A",
      );
    });

    it("does not expose Symbol.dispose", () => {
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { connectionId: "conn-1" },
        strategy: "one",
        timeout: 5000,
      });

      expect(serviceProxy[Symbol.dispose]).toBeUndefined();
    });

    it("should dispatch an APPLY call on method invocation", () => {
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { connectionId: "conn-1" },
        strategy: "one",
        timeout: 5000,
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
        strategy: "one",
        timeout: 5000,
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
        strategy: "one",
        timeout: 5000,
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
        strategy: "one",
        timeout: 5000,
      });
      const method = serviceProxy.doSomething; // Access without calling
      expect(method).toBeTypeOf("function");
      expect(mockEngine.safeDispatchCall).not.toHaveBeenCalled();
    });

    it("should pass strategy and timeout options to dispatchCall", () => {
      const serviceProxy: any = proxyFactory.createServiceProxy("api", {
        target: { connectionIds: ["conn-1", "conn-2"] },
        strategy: "stream",
        timeout: 1000,
      });

      serviceProxy.doWork();

      expect(mockEngine.safeDispatchCall).toHaveBeenCalledOnce();
      expect(mockEngine.safeDispatchCall).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "APPLY",
          target: { connectionIds: ["conn-1", "conn-2"] },
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

    it("discard only unregisters finalization, leaving calls and explicit release usable", async () => {
      const resource: any = proxyFactory.createRemoteResourceProxy("kept", "A");
      const child = resource.deep;
      proxyFactory.discardRemoteResourceProxy(resource);
      simulateFinalization(mockRegister.mock.calls[0][0]);
      expect(mockEngine.dispatchRelease).not.toHaveBeenCalled();
      expect(resourceManager.hasRemoteProxy("kept", "A")).toBe(true);
      await child.run();
      const release = child[RELEASE_PROXY_SYMBOL];
      release();
      resource[RELEASE_PROXY_SYMBOL]();
      expect(mockEngine.dispatchRelease).toHaveBeenCalledExactlyOnceWith(
        "kept",
        "A",
      );
      await expect(child.run()).rejects.toMatchObject({
        code: "E_RESOURCE_ACCESS_DENIED",
      });
    });

    it("does not infer remote service ownership from a colliding local ID", async () => {
      const resourceId = resourceManager.registerLocalResource(
        {},
        "conn-1",
        LocalResourceType.OBJECT,
        "unrelated-local-service",
      );
      const remote: any = proxyFactory.createRemoteResourceProxy(
        resourceId,
        "conn-1",
      );
      await remote.read();
      expect(mockEngine.safeDispatchCall.mock.calls[0][0]).not.toHaveProperty(
        "invocationServiceName",
      );
      remote[RELEASE_PROXY_SYMBOL]();
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
        strategy: "one",
        timeout: 5000,
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
        strategy: "one",
        timeout: 5000,
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
        strategy: "one",
        timeout: 5000,
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

    it("disposes shared resource facades exactly once and terminalizes them", async () => {
      const remoteObj: any = proxyFactory.createRemoteResourceProxy(
        "res-dispose",
        "conn-dispose",
      );
      const nested = remoteObj.deep.path;
      const lifetimeAnchor = mockRegister.mock.calls[0][0];

      nested[Symbol.dispose]();
      remoteObj[Symbol.dispose]();

      expect(mockEngine.dispatchRelease).toHaveBeenCalledOnce();
      expect(mockEngine.dispatchRelease).toHaveBeenCalledWith(
        "res-dispose",
        "conn-dispose",
      );
      expect(resourceManager.countRemoteProxies()).toBe(0);
      expect(mockUnregister).toHaveBeenCalledOnce();
      expect(mockUnregister).toHaveBeenCalledWith(lifetimeAnchor);
      await expect(remoteObj.run()).rejects.toThrow(NexusResourceError);
      await expect(nested.value).rejects.toThrow(/released/i);
      expect(() => {
        nested.value = "blocked-after-dispose";
      }).toThrow(NexusResourceError);
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
