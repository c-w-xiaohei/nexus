import { describe, it, expect, beforeEach, vi } from "vitest";
import { ok, type Result } from "neverthrow";
import { PayloadProcessor } from "./payload-processor";
import { ResourceManager } from "../resource-manager";
import { ProxyFactory } from "../proxy-factory";
import { LocalResourceType } from "../types";
import { REF_WRAPPER_SYMBOL } from "@/types/ref-wrapper";
import { Placeholder } from "./placeholder";
import { ESCAPE_CHAR, PlaceholderType } from "./protocol";

vi.mock("../proxy-factory");

const unwrap = <T>(result: Result<T, globalThis.Error>): T =>
  result.match(
    (value) => value,
    (error) => {
      throw error;
    },
  );

describe("PayloadProcessor", () => {
  let resourceManager: ResourceManager.Runtime;
  let proxyFactory: ProxyFactory<any>;
  let payloadProcessor: PayloadProcessor.Runtime<any, any>;

  const mockConnectionId = "conn-1";
  const mockProxyObject = { __isProxy: true };

  beforeEach(() => {
    vi.clearAllMocks();

    resourceManager = ResourceManager.create();
    proxyFactory = new (ProxyFactory as any)();

    vi.spyOn(resourceManager, "registerLocalResource").mockReturnValue(
      "res-123",
    );
    vi.spyOn(proxyFactory, "createRemoteResourceProxy").mockReturnValue(
      mockProxyObject,
    );

    payloadProcessor = PayloadProcessor.create(resourceManager, proxyFactory);
  });

  describe("safeSanitize", () => {
    it("should keep primitives (string, number, boolean, null) as they are", () => {
      const result = unwrap(
        payloadProcessor.safeSanitize(
          ["hello", 123, true, null],
          mockConnectionId,
        ),
      );
      expect(result).toEqual(["hello", 123, true, null]);
    });

    it("should convert undefined to an UNDEFINED placeholder", () => {
      const expected = new Placeholder(PlaceholderType.UNDEFINED).toString();
      const result = unwrap(
        payloadProcessor.safeSanitize([undefined], mockConnectionId),
      );
      expect(result).toEqual([expected]);
    });

    it("should escape strings that start with placeholder/escape prefix", () => {
      const placeholderStr = new Placeholder(
        PlaceholderType.UNDEFINED,
      ).toString();
      const escapedStr = `${ESCAPE_CHAR}test`;
      const result = unwrap(
        payloadProcessor.safeSanitize(
          [placeholderStr, escapedStr],
          mockConnectionId,
        ),
      );
      expect(result).toEqual([
        `${ESCAPE_CHAR}${placeholderStr}`,
        `${ESCAPE_CHAR}${escapedStr}`,
      ]);
    });

    it("should convert a Function to a RESOURCE placeholder", () => {
      const myFunc = () => {};
      const result = unwrap(
        payloadProcessor.safeSanitize([myFunc], mockConnectionId),
      );
      expect(resourceManager.registerLocalResource).toHaveBeenCalledWith(
        myFunc,
        mockConnectionId,
        LocalResourceType.FUNCTION,
      );
      expect(result[0]).toBe(
        new Placeholder(PlaceholderType.RESOURCE, "res-123").toString(),
      );
    });

    it("should convert a RefWrapper object to RESOURCE placeholder", () => {
      const myObject = { id: 1 };
      const refWrapper = { [REF_WRAPPER_SYMBOL]: true, target: myObject };
      const result = unwrap(
        payloadProcessor.safeSanitize([refWrapper], mockConnectionId),
      );
      expect(resourceManager.registerLocalResource).toHaveBeenCalledWith(
        myObject,
        mockConnectionId,
        LocalResourceType.OBJECT,
      );
      expect(result[0]).toBe(
        new Placeholder(PlaceholderType.RESOURCE, "res-123").toString(),
      );
    });

    it("should convert Map/Set/BigInt placeholders", () => {
      const myMap = new Map([["a", 1]]);
      const mySet = new Set(["a", 1]);
      const myBigInt = BigInt(9007199254740991);
      const mapResult = unwrap(
        payloadProcessor.safeSanitize([myMap], mockConnectionId),
      );
      const setResult = unwrap(
        payloadProcessor.safeSanitize([mySet], mockConnectionId),
      );
      const bigintResult = unwrap(
        payloadProcessor.safeSanitize([myBigInt], mockConnectionId),
      );
      expect(mapResult[0]).toBe(
        new Placeholder(
          PlaceholderType.MAP,
          JSON.stringify(Array.from(myMap.entries())),
        ).toString(),
      );
      expect(setResult[0]).toBe(
        new Placeholder(
          PlaceholderType.SET,
          JSON.stringify(Array.from(mySet.values())),
        ).toString(),
      );
      expect(bigintResult[0]).toBe(
        new Placeholder(PlaceholderType.BIGINT, myBigInt.toString()).toString(),
      );
    });

    it("should recursively sanitize arrays and plain objects", () => {
      const myFunc = () => {};
      const arr = [1, "test", myFunc];
      const obj = { a: 1, b: "test", c: myFunc };
      const arrResult = unwrap(
        payloadProcessor.safeSanitize([arr], mockConnectionId),
      )[0];
      const objResult = unwrap(
        payloadProcessor.safeSanitize([obj], mockConnectionId),
      )[0];
      expect(arrResult).toEqual([
        1,
        "test",
        new Placeholder(PlaceholderType.RESOURCE, "res-123").toString(),
      ]);
      expect(objResult).toEqual({
        a: 1,
        b: "test",
        c: new Placeholder(PlaceholderType.RESOURCE, "res-123").toString(),
      });
    });
  });

  describe("safeRevive", () => {
    it("should keep primitives and unescape escaped strings", () => {
      const placeholderStr = new Placeholder(
        PlaceholderType.UNDEFINED,
      ).toString();
      const escapedPlaceholder = `${ESCAPE_CHAR}${placeholderStr}`;
      const primitiveResult = unwrap(
        payloadProcessor.safeRevive(
          ["hello", 123, true, null],
          mockConnectionId,
        ),
      );
      const unescaped = unwrap(
        payloadProcessor.safeRevive([escapedPlaceholder], mockConnectionId),
      )[0];
      expect(primitiveResult).toEqual(["hello", 123, true, null]);
      expect(unescaped).toBe(placeholderStr);
    });

    it("should revive UNDEFINED and RESOURCE placeholders", () => {
      const undefinedPlaceholder = new Placeholder(
        PlaceholderType.UNDEFINED,
      ).toString();
      const resourcePlaceholder = new Placeholder(
        PlaceholderType.RESOURCE,
        "res-456",
      ).toString();
      expect(
        unwrap(
          payloadProcessor.safeRevive([undefinedPlaceholder], mockConnectionId),
        ),
      ).toEqual([undefined]);
      const result = unwrap(
        payloadProcessor.safeRevive([resourcePlaceholder], mockConnectionId),
      );
      expect(proxyFactory.createRemoteResourceProxy).toHaveBeenCalledWith(
        "res-456",
        mockConnectionId,
      );
      expect(result[0]).toBe(mockProxyObject);
    });

    it("should revive MAP/SET/BIGINT placeholders", () => {
      const originalMap = new Map([["a", 1]]);
      const originalSet = new Set(["a", 1]);
      const originalBigInt = BigInt(9007199254740991);
      const mapPlaceholder = new Placeholder(
        PlaceholderType.MAP,
        JSON.stringify(Array.from(originalMap.entries())),
      ).toString();
      const setPlaceholder = new Placeholder(
        PlaceholderType.SET,
        JSON.stringify(Array.from(originalSet.values())),
      ).toString();
      const bigintPlaceholder = new Placeholder(
        PlaceholderType.BIGINT,
        originalBigInt.toString(),
      ).toString();

      const mapResult = unwrap(
        payloadProcessor.safeRevive([mapPlaceholder], mockConnectionId),
      )[0];
      const setResult = unwrap(
        payloadProcessor.safeRevive([setPlaceholder], mockConnectionId),
      )[0];
      const bigintResult = unwrap(
        payloadProcessor.safeRevive([bigintPlaceholder], mockConnectionId),
      )[0];

      expect(mapResult).toEqual(originalMap);
      expect(setResult).toEqual(originalSet);
      expect(bigintResult).toBe(originalBigInt);
    });

    it("should recursively revive arrays and plain objects", () => {
      const placeholder = new Placeholder(
        PlaceholderType.RESOURCE,
        "res-xyz",
      ).toString();
      const arr = [1, "test", placeholder];
      const obj = { a: 1, b: "test", c: placeholder };
      const arrResult = unwrap(
        payloadProcessor.safeRevive([arr], mockConnectionId),
      )[0];
      const objResult = unwrap(
        payloadProcessor.safeRevive([obj], mockConnectionId),
      )[0];
      expect(arrResult).toEqual([1, "test", mockProxyObject]);
      expect(objResult).toEqual({ a: 1, b: "test", c: mockProxyObject });
    });
  });
});
