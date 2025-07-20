import { describe, it, expect } from "vitest";
import { Placeholder } from "./placeholder";
import {
  PLACEHOLDER_PREFIX,
  PAYLOAD_SEPARATOR,
  PlaceholderType,
} from "./protocol";

describe("Placeholder", () => {
  describe("toString()", () => {
    it("should create a string with payload", () => {
      const p = new Placeholder(PlaceholderType.RESOURCE, "res-123");
      expect(p.toString()).toBe(
        `${PLACEHOLDER_PREFIX}${PlaceholderType.RESOURCE}${PAYLOAD_SEPARATOR}res-123`
      );
    });

    it("should create a string without payload", () => {
      const p = new Placeholder(PlaceholderType.UNDEFINED);
      expect(p.toString()).toBe(
        `${PLACEHOLDER_PREFIX}${PlaceholderType.UNDEFINED}`
      );
    });
  });

  describe("fromString()", () => {
    it("should parse a string with payload", () => {
      const str = `${PLACEHOLDER_PREFIX}${PlaceholderType.RESOURCE}${PAYLOAD_SEPARATOR}res-123`;
      const p = Placeholder.fromString(str);
      expect(p).toBeInstanceOf(Placeholder);
      expect(p?.type).toBe(PlaceholderType.RESOURCE);
      expect(p?.payload).toBe("res-123");
    });

    it("should parse a string without payload", () => {
      const str = `${PLACEHOLDER_PREFIX}${PlaceholderType.UNDEFINED}`;
      const p = Placeholder.fromString(str);
      expect(p).toBeInstanceOf(Placeholder);
      expect(p?.type).toBe(PlaceholderType.UNDEFINED);
      expect(p?.payload).toBeUndefined();
    });

    it("should return null for non-string values", () => {
      expect(Placeholder.fromString(null)).toBeNull();
      expect(Placeholder.fromString(undefined)).toBeNull();
      expect(Placeholder.fromString(123)).toBeNull();
      expect(Placeholder.fromString({})).toBeNull();
    });

    it("should return null for strings that do not start with the prefix", () => {
      expect(Placeholder.fromString("R:res-123")).toBeNull();
    });

    it("should parse correctly even if payload contains separator", () => {
      const str = `${PLACEHOLDER_PREFIX}${PlaceholderType.MAP}${PAYLOAD_SEPARATOR}{"key":"val:ue"}`;
      const p = Placeholder.fromString(str);
      expect(p).toBeInstanceOf(Placeholder);
      expect(p?.type).toBe(PlaceholderType.MAP);
      expect(p?.payload).toBe('{"key":"val:ue"}');
    });
  });
});
