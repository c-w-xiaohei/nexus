import type { SerializedError } from "@/types/message";
import {
  NexusError,
  type NexusErrorCode,
  type NexusErrorOptions,
} from "@/errors/nexus-error";

/**
 * Creates a serializable representation of an error object.
 * This ensures that errors can be safely transmitted across different
 * JavaScript contexts (e.g., from a Web Worker to the main thread)
 * without losing information.
 *
 * @param error The error to serialize, can be of any type.
 * @returns A `SerializedError` object.
 */
export function toSerializedError(error: unknown): SerializedError {
  return toSerializedErrorInternal(error, new WeakSet<object>());
}

function toSerializedErrorInternal(
  error: unknown,
  seen: WeakSet<object>,
): SerializedError {
  if (isSerializedError(error)) {
    return error;
  }

  if (error instanceof NexusError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      stack: error.stack,
      cause: serializeCause(error.cause, seen),
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      code: "E_UNKNOWN",
      message: error.message,
      stack: error.stack,
      cause: serializeCause((error as Error & { cause?: unknown }).cause, seen),
    };
  }

  return {
    name: "UnknownError",
    code: "E_UNKNOWN",
    message: String(error),
  };
}

function isSerializedError(value: unknown): value is SerializedError {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SerializedError>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string"
  );
}

function serializeCause(
  cause: unknown,
  seen: WeakSet<object>,
): SerializedError | undefined {
  if (!cause) {
    return undefined;
  }

  if (typeof cause === "object") {
    if (seen.has(cause)) {
      return {
        name: "CircularCauseError",
        code: "E_UNKNOWN",
        message: "Circular error cause reference detected",
      };
    }
    seen.add(cause);
  }

  return toSerializedErrorInternal(cause, seen);
}

export function fromUnknownError(
  error: unknown,
  fallback: {
    code?: NexusErrorCode;
    message?: string;
    name?: string;
    context?: Record<string, unknown>;
  } = {},
): NexusError {
  if (error instanceof NexusError) {
    return error;
  }

  const code = fallback.code ?? "E_UNKNOWN";
  const options: NexusErrorOptions = {
    context: fallback.context,
  };

  if (error instanceof Error) {
    const wrapped = new NexusError(fallback.message ?? error.message, code, {
      ...options,
      stack: error.stack,
      cause: serializeCause(
        (error as Error & { cause?: unknown }).cause,
        new WeakSet<object>(),
      ),
    });
    wrapped.name = fallback.name ?? error.name;
    return wrapped;
  }

  const wrapped = new NexusError(
    fallback.message ?? String(error),
    code,
    options,
  );
  wrapped.name = fallback.name ?? "UnknownError";
  return wrapped;
}

export function wrapCause(
  message: string,
  code: NexusErrorCode,
  cause: unknown,
  context?: Record<string, unknown>,
): NexusError {
  return new NexusError(message, code, {
    context,
    cause: toSerializedError(cause),
  });
}

export const createSerializedError = toSerializedError;
