/**
 * These tests cover state error normalization and the shared error base.
 * They stay under `src/state` because they validate local error-shaping rules,
 * not cross-runtime integration scenarios.
 */
import { describe, expect, it } from "vitest";
import {
  NexusStoreActionError,
  NexusStoreDisconnectedError,
  NexusStoreError,
  NexusStoreProtocolError,
  normalizeNexusStoreError,
} from "./errors";

describe("state error normalization", () => {
  it("normalizeNexusStoreError preserves existing store errors", () => {
    const existing = new NexusStoreActionError("existing");
    const normalized = normalizeNexusStoreError(existing);

    expect(normalized).toBe(existing);
  });

  it("normalizeNexusStoreError adapts Error and unknown values", () => {
    const error = new Error("boom-normalize");
    const normalizedError = normalizeNexusStoreError(error);
    expect(normalizedError).toBeInstanceOf(NexusStoreProtocolError);
    expect(normalizedError.message).toBe("boom-normalize");
    expect(normalizedError.cause).toBe(error);

    const normalizedUnknown = normalizeNexusStoreError(42);
    expect(normalizedUnknown).toBeInstanceOf(NexusStoreProtocolError);
    expect(normalizedUnknown.message).toBe("Unknown store error");
    expect(normalizedUnknown.cause).toBe(42);
  });

  it("normalizeNexusStoreError maps core disconnect-coded errors", () => {
    const coreDisconnectLike = Object.assign(new Error("conn closed"), {
      code: "E_CONN_CLOSED",
    });

    const normalized = normalizeNexusStoreError(coreDisconnectLike);
    expect(normalized).toBeInstanceOf(NexusStoreDisconnectedError);
    expect(normalized.message).toBe("conn closed");
    expect(normalized.cause).toBe(coreDisconnectLike);
  });

  it("state error base carries code, context, and cause", () => {
    const cause = new Error("cause");
    const error = new NexusStoreError("store-error", "E_STORE_PROTOCOL", {
      cause,
      context: { operation: "subscribe" },
    });

    expect(error.code).toBe("E_STORE_PROTOCOL");
    expect(error.context).toEqual({ operation: "subscribe" });
    expect(error.cause).toBe(cause);
  });
});
