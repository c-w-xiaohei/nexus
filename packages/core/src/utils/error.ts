import type { SerializedError } from "../types/message.js";

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
  try {
    return toSerializedErrorInternal(error, new WeakSet<object>());
  } catch {
    return unknownSerializedError();
  }
}

/** Serialize one error recursively while tracking circular cause references. */
function toSerializedErrorInternal(
  error: unknown,
  seen: WeakSet<object>,
): SerializedError {
  if (isSerializedError(error)) {
    return copySerializedError(error, seen);
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      code:
        typeof (error as Error & { code?: unknown }).code === "string"
          ? (error as Error & { code: string }).code
          : "E_UNKNOWN",
      message: error.message,
      stack: error.stack,
      context: serializeDiagnosticContext(
        (error as Error & { context?: unknown }).context,
        seen,
      ),
      cause: serializeCause((error as Error & { cause?: unknown }).cause, seen),
    };
  }

  return unknownSerializedError(error);
}

/** Recognize serialized error-shaped input without trusting property access. */
function isSerializedError(value: unknown): value is SerializedError {
  try {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<SerializedError>;
    return (
      typeof candidate.name === "string" &&
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    );
  } catch {
    return false;
  }
}

/** Copies data across an untrusted boundary without propagating framework trust. */
function copySerializedError(
  error: SerializedError,
  seen: WeakSet<object>,
): SerializedError {
  try {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      stack: typeof error.stack === "string" ? error.stack : undefined,
      context: serializeDiagnosticContext(error.context, seen),
      cause: serializeCause(error.cause, seen),
    };
  } catch {
    return unknownSerializedError();
  }
}

/** Copy only allowlisted nested error context across the wire boundary. */
function serializeDiagnosticContext(
  context: unknown,
  seen: WeakSet<object>,
): SerializedError["context"] | undefined {
  try {
    if (!context || typeof context !== "object") return undefined;
    const originalError = (context as { originalError?: unknown })
      .originalError;
    return originalError === undefined
      ? undefined
      : { originalError: serializeCause(originalError, seen) };
  } catch {
    return undefined;
  }
}

/** Produce a safe fallback when an arbitrary thrown value cannot be inspected. */
function unknownSerializedError(error?: unknown): SerializedError {
  if (error === undefined) {
    return {
      name: "UnknownError",
      code: "E_UNKNOWN",
      message: "Unknown error",
    };
  }
  try {
    return { name: "UnknownError", code: "E_UNKNOWN", message: String(error) };
  } catch {
    return {
      name: "UnknownError",
      code: "E_UNKNOWN",
      message: "Unknown error",
    };
  }
}

/** Serialize an error cause while converting cycles into a bounded diagnostic. */
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
