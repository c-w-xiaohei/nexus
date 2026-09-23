import type { SerializedError } from "../types/message.js";
import { toSerializedError } from "../utils/error.js";
import {
  NexusCallTimeoutError,
  NexusDisconnectedError,
  type NexusCallError,
} from "./call-errors.js";
import { NexusProtocolIncompatibleError } from "./connection-errors.js";
import { NexusError, type NexusErrorOptions } from "./nexus-error.js";
import { NexusResourceError } from "./resource-errors.js";
import { NexusServiceError } from "./service-errors.js";
import { NexusProtocolError } from "./transport-errors.js";

/** Marks a locally classified framework failure for concrete revival by the caller. */
export function serializeFrameworkError(
  error: NexusError,
): SerializedError & { origin: "framework" } {
  const serialized = toSerializedError(error);
  // Only framework boundaries may retain routing diagnostics. Never serialize
  // arbitrary context (identities, credentials or application objects).
  try {
    if (error.context) {
      const context: NonNullable<SerializedError["context"]> = {
        ...serialized.context,
      };
      for (const key of [
        "connectionId",
        "sourceConnectionId",
        "serviceName",
        "resourceId",
      ] as const) {
        const value = error.context[key];
        if (typeof value === "string") context[key] = value;
      }
      if (error.context.resourceId === null) context.resourceId = null;
      const path = error.context.path;
      if (
        Array.isArray(path) &&
        path.every(
          (part) =>
            typeof part === "string" ||
            (typeof part === "number" && Number.isFinite(part)),
        )
      ) {
        context.path = [...path];
      }
      serialized.context = context;
    }
  } catch {
    // Diagnostic getters must not prevent the original failure from being sent.
  }
  return { ...serialized, origin: "framework" };
}

/**
 * Revives an explicitly framework-originated wire error. Unmarked errors are
 * business exceptions and must become NexusRemoteError at the call boundary.
 */
export function reviveFrameworkError(
  error: SerializedError,
): NexusCallError | undefined {
  if (error.origin !== "framework") return undefined;
  const revived = createFrameworkError(error);
  // Constructors expose different convenience signatures, but wire diagnostics
  // must be restored consistently on every concrete error instance.
  Object.defineProperty(revived, "cause", {
    value: error.cause,
    configurable: true,
    writable: true,
  });
  if (error.stack !== undefined) revived.stack = error.stack;
  return revived;
}

/** Decodes only recognized RPC failure codes; unknown or acquisition-only codes are protocol errors. */
function createFrameworkError(error: SerializedError): NexusCallError {
  const options: NexusErrorOptions = {
    context: { ...error.context, remoteError: error },
    cause: error.cause,
    stack: error.stack,
  };
  switch (error.code) {
    case "E_CALL_TIMEOUT":
      return new NexusCallTimeoutError(
        error.message,
        undefined,
        options.context,
      );
    case "E_CONN_CLOSED":
      return new NexusDisconnectedError(
        error.message,
        undefined,
        options.context,
      );
    case "E_PROTOCOL_INCOMPATIBLE":
      return new NexusProtocolIncompatibleError(
        error.message,
        options.context,
        error.cause,
      );
    case "E_PROTOCOL_ERROR":
      return new NexusProtocolError(error.message, options);
    case "E_RESOURCE_NOT_FOUND":
    case "E_RESOURCE_SCOPE_CLOSED":
    case "E_RESOURCE_ACCESS_DENIED":
    case "E_INVALID_SERVICE_PATH":
    case "E_TARGET_NOT_CALLABLE":
    case "E_SET_ON_ROOT":
    case "E_AUTH_CALL_DENIED":
    case "E_INVOCATION_SERVICE_MISMATCH":
      return new NexusResourceError(error.message, error.code, options.context);
    case "E_SERVICE_UNAVAILABLE":
      return new NexusServiceError(error.message, error.code, options);
    default:
      return new NexusProtocolError(
        `Unrecognized framework error code "${error.code}": ${error.message}`,
        options,
      );
  }
}

/** Converts an internal decode/encode failure at a protocol boundary. */
export function toFrameworkProtocolError(error: unknown): NexusProtocolError {
  try {
    if (error instanceof NexusProtocolError) return error;
  } catch {
    // Revoked proxies can throw even during an instanceof check.
  }
  const cause = toSerializedError(error);
  return new NexusProtocolError(cause.message, { cause, stack: cause.stack });
}
