import { describe, it, expect, beforeEach, vi } from "vitest";
import { PayloadProcessor } from "./payload-processor";
import { ResourceManager } from "../resource-manager";
import { ProxyFactory } from "../proxy-factory";
import { LocalResourceType } from "../types";
import { REF_WRAPPER_SYMBOL } from "@/types/ref-wrapper";
import { Placeholder } from "./placeholder";
import { ESCAPE_CHAR, PlaceholderType } from "./protocol";

// Mocks
// We are mocking the entire class for ProxyFactory
vi.mock("../proxy-factory");
// We are mocking the entire class for ResourceManager to control its methods
vi.mock("../resource-manager");

describe("PayloadProcessor", () => {
  let resourceManager: ResourceManager;
  let proxyFactory: ProxyFactory<any, any>;
  let payloadProcessor: PayloadProcessor<any, any>;

  const mockConnectionId = "conn-1";
  const mockProxyObject = { __isProxy: true };

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Instantiate mocks
    resourceManager = new ResourceManager();
    proxyFactory = new (ProxyFactory as any)();

    // Mock specific methods
    vi.spyOn(resourceManager, "registerLocalResource").mockReturnValue(
      "res-123"
    );
    vi.spyOn(proxyFactory, "createRemoteResourceProxy").mockReturnValue(
      mockProxyObject
    );

    // Create the processor instance with mocks
    payloadProcessor = new PayloadProcessor(resourceManager, proxyFactory);
  });

  describe("sanitize", () => {
    it("should keep primitives (string, number, boolean, null) as they are", () => {
      expect(
        payloadProcessor.sanitize(["hello", 123, true, null], mockConnectionId)
      ).toEqual(["hello", 123, true, null]);
    });

    it("should convert undefined to an UNDEFINED placeholder", () => {
      const expected = new Placeholder(PlaceholderType.UNDEFINED).toString();
      expect(payloadProcessor.sanitize([undefined], mockConnectionId)).toEqual([
        expected,
      ]);
    });

    it("should escape strings that start with the placeholder or escape prefix", () => {
      const placeholderStr = new Placeholder(
        PlaceholderType.UNDEFINED
      ).toString();
      const escapedStr = `${ESCAPE_CHAR}test`;
      const result = payloadProcessor.sanitize(
        [placeholderStr, escapedStr],
        mockConnectionId
      );
      expect(result).toEqual([
        `${ESCAPE_CHAR}${placeholderStr}`,
        `${ESCAPE_CHAR}${escapedStr}`,
      ]);
    });

    it("should convert a Function to a RESOURCE placeholder", () => {
      const myFunc = () => {};
      const result = payloadProcessor.sanitize([myFunc], mockConnectionId);

      expect(resourceManager.registerLocalResource).toHaveBeenCalledWith(
        myFunc,
        mockConnectionId,
        LocalResourceType.FUNCTION
      );
      expect(result[0]).toBe(
        new Placeholder(PlaceholderType.RESOURCE, "res-123").toString()
      );
    });

    it("should convert a RefWrapper object to a RESOURCE placeholder", () => {
      const myObject = { id: 1 };
      const refWrapper = {
        [REF_WRAPPER_SYMBOL]: true,
        target: myObject,
      };
      const result = payloadProcessor.sanitize([refWrapper], mockConnectionId);

      expect(resourceManager.registerLocalResource).toHaveBeenCalledWith(
        myObject,
        mockConnectionId,
        LocalResourceType.OBJECT
      );
      expect(result[0]).toBe(
        new Placeholder(PlaceholderType.RESOURCE, "res-123").toString()
      );
    });

    it("should convert a Map to a MAP placeholder", () => {
      const myMap = new Map([["a", 1]]);
      const result = payloadProcessor.sanitize([myMap], mockConnectionId);
      const expectedPayload = JSON.stringify(Array.from(myMap.entries()));
      expect(result[0]).toBe(
        new Placeholder(PlaceholderType.MAP, expectedPayload).toString()
      );
    });

    it("should convert a Set to a SET placeholder", () => {
      const mySet = new Set(["a", 1]);
      const result = payloadProcessor.sanitize([mySet], mockConnectionId);
      const expectedPayload = JSON.stringify(Array.from(mySet.values()));
      expect(result[0]).toBe(
        new Placeholder(PlaceholderType.SET, expectedPayload).toString()
      );
    });

    it("should convert a BigInt to a BIGINT placeholder", () => {
      const myBigInt = BigInt(9007199254740991);
      const result = payloadProcessor.sanitize([myBigInt], mockConnectionId);
      expect(result[0]).toBe(
        new Placeholder(PlaceholderType.BIGINT, myBigInt.toString()).toString()
      );
    });

    it("should recursively sanitize arrays", () => {
      const myFunc = () => {};
      const arr = [1, "test", myFunc];
      const result = payloadProcessor.sanitize([arr], mockConnectionId)[0];

      expect(result).toEqual([
        1,
        "test",
        new Placeholder(PlaceholderType.RESOURCE, "res-123").toString(),
      ]);
      expect(resourceManager.registerLocalResource).toHaveBeenCalledOnce();
    });

    it("should recursively sanitize plain objects", () => {
      const myFunc = () => {};
      const obj = { a: 1, b: "test", c: myFunc };
      const result = payloadProcessor.sanitize([obj], mockConnectionId)[0];

      expect(result).toEqual({
        a: 1,
        b: "test",
        c: new Placeholder(PlaceholderType.RESOURCE, "res-123").toString(),
      });
      expect(resourceManager.registerLocalResource).toHaveBeenCalledOnce();
    });

    it("should serialize class instances as plain objects", () => {
      class MyClass {
        constructor(public value: number = 42) {}
      }
      const instance = new MyClass();
      const result = payloadProcessor.sanitize([instance], mockConnectionId);

      // Class instances are treated as plain objects, losing their prototype
      expect(result[0]).toEqual({ value: 42 });
      expect(result[0]).not.toBeInstanceOf(MyClass);
    });
  });

  describe("revive", () => {
    it("should keep primitives as they are", () => {
      expect(
        payloadProcessor.revive(["hello", 123, true, null], mockConnectionId)
      ).toEqual(["hello", 123, true, null]);
    });

    it("should un-escape strings prefixed with the escape character", () => {
      const placeholderStr = new Placeholder(
        PlaceholderType.UNDEFINED
      ).toString();
      const escapedPlaceholder = `${ESCAPE_CHAR}${placeholderStr}`;
      const result = payloadProcessor.revive(
        [escapedPlaceholder],
        mockConnectionId
      );
      expect(result[0]).toBe(placeholderStr);
    });

    it("should revive an UNDEFINED placeholder to undefined", () => {
      const placeholder = new Placeholder(PlaceholderType.UNDEFINED).toString();
      expect(payloadProcessor.revive([placeholder], mockConnectionId)).toEqual([
        undefined,
      ]);
    });

    it("should revive a RESOURCE placeholder to a proxy object", () => {
      const placeholder = new Placeholder(
        PlaceholderType.RESOURCE,
        "res-456"
      ).toString();
      const result = payloadProcessor.revive([placeholder], mockConnectionId);

      expect(proxyFactory.createRemoteResourceProxy).toHaveBeenCalledWith(
        "res-456",
        mockConnectionId
      );
      expect(result[0]).toBe(mockProxyObject);
    });

    it("should revive a MAP placeholder to a Map object", () => {
      const originalMap = new Map([["a", 1]]);
      const payload = JSON.stringify(Array.from(originalMap.entries()));
      const placeholder = new Placeholder(
        PlaceholderType.MAP,
        payload
      ).toString();
      const result = payloadProcessor.revive([placeholder], mockConnectionId);
      expect(result[0]).toBeInstanceOf(Map);
      expect(result[0]).toEqual(originalMap);
    });

    it("should revive a SET placeholder to a Set object", () => {
      const originalSet = new Set(["a", 1]);
      const payload = JSON.stringify(Array.from(originalSet.values()));
      const placeholder = new Placeholder(
        PlaceholderType.SET,
        payload
      ).toString();
      const result = payloadProcessor.revive([placeholder], mockConnectionId);
      expect(result[0]).toBeInstanceOf(Set);
      expect(result[0]).toEqual(originalSet);
    });

    it("should revive a BIGINT placeholder to a BigInt", () => {
      const originalBigInt = BigInt(9007199254740991);
      const placeholder = new Placeholder(
        PlaceholderType.BIGINT,
        originalBigInt.toString()
      ).toString();
      const result = payloadProcessor.revive([placeholder], mockConnectionId);
      expect(result[0]).toBe(originalBigInt);
    });

    it("should recursively revive arrays", () => {
      const placeholder = new Placeholder(
        PlaceholderType.RESOURCE,
        "res-789"
      ).toString();
      const arr = [1, "test", placeholder];
      const result = payloadProcessor.revive([arr], mockConnectionId)[0];

      expect(result).toEqual([1, "test", mockProxyObject]);
      expect(proxyFactory.createRemoteResourceProxy).toHaveBeenCalledWith(
        "res-789",
        mockConnectionId
      );
    });

    it("should recursively revive plain objects", () => {
      const placeholder = new Placeholder(
        PlaceholderType.RESOURCE,
        "res-xyz"
      ).toString();
      const obj = { a: 1, b: "test", c: placeholder };
      const result = payloadProcessor.revive([obj], mockConnectionId)[0];

      expect(result).toEqual({ a: 1, b: "test", c: mockProxyObject });
      expect(proxyFactory.createRemoteResourceProxy).toHaveBeenCalledWith(
        "res-xyz",
        mockConnectionId
      );
    });
  });
});
