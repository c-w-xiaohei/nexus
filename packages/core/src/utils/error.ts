import type { SerializedError } from "@/types/message";

/**
 * Creates a serializable representation of an error object.
 * This ensures that errors can be safely transmitted across different
 * JavaScript contexts (e.g., from a Web Worker to the main thread)
 * without losing information.
 *
 * @param error The error to serialize, can be of any type.
 * @returns A `SerializedError` object.
 */
export function createSerializedError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: "UnknownError",
    message: String(error),
  };
}
