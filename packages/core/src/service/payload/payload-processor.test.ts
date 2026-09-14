import { describe, it, expect, beforeEach, vi } from "vitest";
import { Result } from "better-result";
import { PayloadProcessor } from "./payload-processor";
import { ResourceManager } from "../resource-manager";
import { ProxyFactory } from "../proxy-factory";
import { REF_WRAPPER_SYMBOL } from "@/types/ref-wrapper";
import { Placeholder } from "./placeholder";
import { ESCAPE_CHAR, PlaceholderType } from "./protocol";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";

vi.mock("../proxy-factory");

const unwrap = <T>(result: Result<T, globalThis.Error>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

describe("PayloadProcessor", () => {
  let resourceManager: ResourceManager;
  let proxyFactory: ProxyFactory;
  let payloadProcessor: PayloadProcessor;

  const mockConnectionId = "conn-1";
  const mockProxyObject = { __isProxy: true };

  beforeEach(() => {
    vi.clearAllMocks();

    resourceManager = new ResourceManager();
    proxyFactory = new (ProxyFactory as any)();

    vi.spyOn(resourceManager, "registerLocalResource").mockReturnValue(
      "res-123",
    );
    vi.spyOn(proxyFactory, "createRemoteResourceProxy").mockReturnValue(
      mockProxyObject,
    );

    payloadProcessor = new PayloadProcessor(resourceManager, proxyFactory);
  });

  describe("safeSanitize", () => {
    it("preserves __proto__ as ordinary data through encode and revive", () => {
      const input = JSON.parse('{"__proto__":{"inherited":true},"value":1}');
      const encoded = unwrap(
        payloadProcessor.safeSanitize([input], mockConnectionId),
      );
      const [revived] = unwrap(
        payloadProcessor.safeRevive(encoded, mockConnectionId),
      );
      expect(Object.hasOwn(encoded[0], "__proto__")).toBe(true);
      expect(Object.hasOwn(revived, "__proto__")).toBe(true);
      expect(revived.inherited).toBeUndefined();
      expect(revived.value).toBe(1);
    });
    it("rolls back capabilities even when a getter throws an unserializable value", () => {
      vi.mocked(resourceManager.registerLocalResource).mockRestore();
      const hostile = {
        toString() {
          throw new Error("unreadable");
        },
      };
      const result = payloadProcessor.safeSanitize(
        [
          () => {},
          {
            get value() {
              throw hostile;
            },
          },
        ],
        mockConnectionId,
      );
      expect(result).toMatchObject({ error: { code: "E_PROTOCOL_ERROR" } });
      expect(resourceManager.countLocalResources()).toBe(0);
    });
    it("rolls back resources registered before a later value fails to sanitize", () => {
      vi.mocked(resourceManager.registerLocalResource).mockRestore();
      const existingResourceId = resourceManager.registerLocalResource(
        {},
        "existing-conn",
      );
      const failingValue = {
        get failure() {
          throw new Error("cannot serialize");
        },
      };

      const result = payloadProcessor.safeSanitize(
        [() => {}, failingValue],
        mockConnectionId,
      );

      expect(result.isErr()).toBe(true);
      expect(resourceManager.countLocalResources()).toBe(1);
      expect(resourceManager.hasLocalResource(existingResourceId)).toBe(true);
    });

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
      const expected = Placeholder.encode(PlaceholderType.UNDEFINED);
      const result = unwrap(
        payloadProcessor.safeSanitize([undefined], mockConnectionId),
      );
      expect(result).toEqual([expected]);
    });

    it("should escape strings that start with placeholder/escape prefix", () => {
      const placeholderStr = Placeholder.encode(PlaceholderType.UNDEFINED);
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
        undefined,
        undefined,
      );
      expect(result[0]).toBe(
        Placeholder.encode(PlaceholderType.RESOURCE, "res-123"),
      );
    });

    it("should preserve service policy when sanitizing a Function returned from a service", () => {
      const myFunc = () => {};
      const servicePolicy = { canCall: vi.fn(() => false) };
      resourceManager.registerExposedService(
        "vault",
        { getCallback: () => myFunc },
        servicePolicy,
      );

      const result = unwrap(
        payloadProcessor.safeSanitizeFromService(
          [myFunc],
          mockConnectionId,
          "vault",
          servicePolicy,
        ),
      );

      expect(resourceManager.registerLocalResource).toHaveBeenCalledWith(
        myFunc,
        mockConnectionId,
        "vault",
        servicePolicy,
      );
      expect(result[0]).toBe(
        Placeholder.encode(PlaceholderType.RESOURCE, "res-123"),
      );
    });

    it("should preserve an explicit undefined service policy snapshot", () => {
      const myFunc = () => {};
      const laterPolicy = { canCall: vi.fn(() => false) };
      resourceManager.registerExposedService("vault", {
        getCallback: () => myFunc,
      });

      const result = unwrap(
        payloadProcessor.safeSanitizeFromService(
          [myFunc],
          mockConnectionId,
          "vault",
          undefined,
        ),
      );

      resourceManager.registerExposedService(
        "vault",
        { getCallback: () => myFunc },
        laterPolicy,
      );
      expect(resourceManager.registerLocalResource).toHaveBeenCalledWith(
        myFunc,
        mockConnectionId,
        "vault",
        undefined,
      );
      expect(result[0]).toBe(
        Placeholder.encode(PlaceholderType.RESOURCE, "res-123"),
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
        undefined,
        undefined,
      );
      expect(result[0]).toBe(
        Placeholder.encode(PlaceholderType.RESOURCE, "res-123"),
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
        Placeholder.encode(
          PlaceholderType.MAP,
          JSON.stringify(Array.from(myMap.entries())),
        ),
      );
      expect(setResult[0]).toBe(
        Placeholder.encode(
          PlaceholderType.SET,
          JSON.stringify(Array.from(mySet.values())),
        ),
      );
      expect(bigintResult[0]).toBe(
        Placeholder.encode(PlaceholderType.BIGINT, myBigInt.toString()),
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
        Placeholder.encode(PlaceholderType.RESOURCE, "res-123"),
      ]);
      expect(objResult).toEqual({
        a: 1,
        b: "test",
        c: Placeholder.encode(PlaceholderType.RESOURCE, "res-123"),
      });
    });
  });

  describe("safeRevive", () => {
    it.each(["\u0003R", "\u0003R:"])(
      "rejects a resource without an ID: %j",
      (wire) => {
        expect(
          payloadProcessor.safeRevive([wire], mockConnectionId),
        ).toMatchObject({ error: { code: "E_PROTOCOL_ERROR" } });
        expect(proxyFactory.createRemoteResourceProxy).not.toHaveBeenCalled();
      },
    );
    it("preserves unknown tags and escaped resource-looking strings", () => {
      const unknown = "\u0003X:future";
      const escaped = "\u0004\u0003R";
      expect(
        unwrap(
          payloadProcessor.safeRevive([unknown, escaped], mockConnectionId),
        ),
      ).toEqual([unknown, "\u0003R"]);
      expect(proxyFactory.createRemoteResourceProxy).not.toHaveBeenCalled();
    });
    it("should keep primitives and unescape escaped strings", () => {
      const placeholderStr = Placeholder.encode(PlaceholderType.UNDEFINED);
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
      const undefinedPlaceholder = Placeholder.encode(
        PlaceholderType.UNDEFINED,
      );
      const resourcePlaceholder = Placeholder.encode(
        PlaceholderType.RESOURCE,
        "res-456",
      );
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
        undefined,
      );
      expect(result[0]).toBe(mockProxyObject);
    });

    it("passes a call timeout to resources revived from that call's response", () => {
      const resourcePlaceholder = Placeholder.encode(
        PlaceholderType.RESOURCE,
        "res-456",
      );

      unwrap(
        payloadProcessor.safeRevive(
          [resourcePlaceholder],
          mockConnectionId,
          1_234,
        ),
      );

      expect(
        proxyFactory.createRemoteResourceProxy as any,
      ).toHaveBeenCalledWith("res-456", mockConnectionId, 1_234);
    });

    it("should revive MAP/SET/BIGINT placeholders", () => {
      const originalMap = new Map([["a", 1]]);
      const originalSet = new Set(["a", 1]);
      const originalBigInt = BigInt(9007199254740991);
      const mapPlaceholder = Placeholder.encode(
        PlaceholderType.MAP,
        JSON.stringify(Array.from(originalMap.entries())),
      );
      const setPlaceholder = Placeholder.encode(
        PlaceholderType.SET,
        JSON.stringify(Array.from(originalSet.values())),
      );
      const bigintPlaceholder = Placeholder.encode(
        PlaceholderType.BIGINT,
        originalBigInt.toString(),
      );

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
      const placeholder = Placeholder.encode(
        PlaceholderType.RESOURCE,
        "res-xyz",
      );
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

    it("should not let revived __proto__ payload create inherited properties", () => {
      const payload = JSON.parse(
        '{"safe":true,"__proto__":{"polluted":"owned"}}',
      );

      const result = unwrap(
        payloadProcessor.safeRevive([payload], mockConnectionId),
      )[0];

      expect(result.safe).toBe(true);
      expect(result.polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(
        true,
      );
      expect(Object.getPrototypeOf(result)).toBeNull();
    });

    it("releases resources created before a later placeholder fails to revive", () => {
      const released = vi.fn();
      vi.mocked(proxyFactory.createRemoteResourceProxy)
        .mockReturnValueOnce({ [RELEASE_PROXY_SYMBOL]: released })
        .mockImplementationOnce(() => {
          throw new Error("cannot revive");
        });
      const resource = (id: string) =>
        Placeholder.encode(PlaceholderType.RESOURCE, id);

      const result = payloadProcessor.safeRevive(
        [resource("res-first"), resource("res-second")],
        mockConnectionId,
      );

      expect(result.isErr()).toBe(true);
      expect(released).toHaveBeenCalledOnce();
    });

    it("does not release an identity that existed before a failed revive", () => {
      const existingRelease = vi.fn();
      const newRelease = vi.fn();
      vi.mocked(proxyFactory.createRemoteResourceProxy)
        .mockReturnValueOnce({ [RELEASE_PROXY_SYMBOL]: existingRelease })
        .mockReturnValueOnce({ [RELEASE_PROXY_SYMBOL]: newRelease })
        .mockImplementationOnce(() => {
          throw new Error("cannot revive");
        });
      vi.spyOn(resourceManager, "hasRemoteProxy").mockImplementation(
        (resourceId, sourceConnectionId) =>
          resourceId === "res-existing" &&
          sourceConnectionId === mockConnectionId,
      );
      const resource = (id: string) =>
        Placeholder.encode(PlaceholderType.RESOURCE, id);

      const result = payloadProcessor.safeRevive(
        [resource("res-existing"), resource("res-new"), resource("res-bad")],
        mockConnectionId,
      );

      expect(result.isErr()).toBe(true);
      expect(existingRelease).not.toHaveBeenCalled();
      expect(newRelease).toHaveBeenCalledOnce();
    });
  });
});
