import { describe, expect, it } from "vitest";
import {
  NexusConnectionConstraintFailedError,
  NexusError,
  NexusProtocolError,
  NexusResourceError,
  reviveFrameworkError,
  serializeFrameworkError,
  toFrameworkProtocolError,
} from "@/errors";
import { toSerializedError } from "@/utils/error";

describe("error utils", () => {
  it("serializes NexusError with code and cause", () => {
    const cause = new NexusError("root cause", "E_PROTOCOL_ERROR");
    const error = new NexusError("top level", "E_REMOTE_EXCEPTION", {
      cause: toSerializedError(cause),
    });

    const serialized = toSerializedError(error);

    expect(serialized.name).toBe("NexusError");
    expect(serialized.code).toBe("E_REMOTE_EXCEPTION");
    expect(serialized.message).toBe("top level");
    expect(serialized.cause).toMatchObject({
      name: "NexusError",
      code: "E_PROTOCOL_ERROR",
      message: "root cause",
    });
  });

  it("revives only explicitly framework-originated errors", () => {
    const serialized = serializeFrameworkError(
      new NexusProtocolError("response payload was invalid"),
    );

    expect(reviveFrameworkError(serialized)).toBeInstanceOf(NexusProtocolError);
    expect(
      reviveFrameworkError({ ...serialized, origin: undefined }),
    ).toBeUndefined();
  });

  it("normalizes acquisition-only framework errors to protocol errors in calls", () => {
    const serialized = [
      serializeFrameworkError(
        new NexusConnectionConstraintFailedError("target mismatch"),
      ),
      {
        name: "NexusServiceError",
        code: "E_SERVICE_ACQUISITION_TIMEOUT",
        message: "acquisition timed out",
        origin: "framework" as const,
      },
    ];

    for (const error of serialized) {
      expect(reviveFrameworkError(error)).toBeInstanceOf(NexusProtocolError);
      expect(reviveFrameworkError(error)?.code).toBe("E_PROTOCOL_ERROR");
    }
  });

  it("copies plain serialized errors without accepting a framework origin", () => {
    const serialized = toSerializedError({
      name: "Denied",
      code: "E_AUTH_CALL_DENIED",
      message: "business denied",
      origin: "framework",
    });

    expect(serialized).toEqual({
      name: "Denied",
      code: "E_AUTH_CALL_DENIED",
      message: "business denied",
    });
  });

  it("serializes hostile thrown values without reading throwing properties", () => {
    const hostile = Object.create(null, {
      message: {
        get: () => {
          throw new Error("message getter");
        },
      },
      toString: {
        value: () => {
          throw new Error("toString");
        },
      },
    });

    expect(toSerializedError(hostile)).toEqual({
      name: "UnknownError",
      code: "E_UNKNOWN",
      message: "Unknown error",
    });
  });

  it("retains framework routing diagnostics but strips business-provided context", () => {
    const path = ["profile", "read"];
    const error = new NexusResourceError("denied", "E_RESOURCE_ACCESS_DENIED", {
      resourceId: "resource",
      serviceName: "profile",
      path,
      connectionId: "peer",
      credentials: { secret: "not for the wire" },
    });
    const wire = serializeFrameworkError(error);
    path.push("mutated");
    expect(wire.context).toEqual({
      resourceId: "resource",
      serviceName: "profile",
      path: ["profile", "read"],
      connectionId: "peer",
    });
    expect(reviveFrameworkError(wire)?.context).toMatchObject({
      resourceId: "resource",
      path: ["profile", "read"],
    });
    const business = toSerializedError(error);
    expect(business.origin).toBeUndefined();
    expect(business.context).toBeUndefined();
  });

  it("normalizes hostile protocol failures without losing the error boundary", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostile = Object.defineProperty(new Error("hidden"), "message", {
      get() {
        throw new Error("unreadable");
      },
    });
    for (const value of [revoked.proxy, hostile]) {
      const error = toFrameworkProtocolError(value);
      expect(error.code).toBe("E_PROTOCOL_ERROR");
      expect(error.cause).toMatchObject({
        code: "E_UNKNOWN",
        message: "Unknown error",
      });
    }
    const existing = new NexusProtocolError("keep identity");
    expect(toFrameworkProtocolError(existing)).toBe(existing);
  });
});
