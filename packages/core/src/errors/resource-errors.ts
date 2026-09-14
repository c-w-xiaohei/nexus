import { NexusError } from "./nexus-error.js";

export type NexusResourceErrorCode =
  | "E_RESOURCE_NOT_FOUND"
  | "E_RESOURCE_ACCESS_DENIED"
  | "E_INVALID_SERVICE_PATH"
  | "E_TARGET_NOT_CALLABLE"
  | "E_SET_ON_ROOT"
  | "E_AUTH_CALL_DENIED"
  | "E_INVOCATION_SERVICE_MISMATCH";

/**
 * Represents an error where a requested local resource (e.g., a function
 * or object passed by reference) could not be found.
 */
export class NexusResourceError<
  C extends NexusResourceErrorCode = NexusResourceErrorCode,
> extends NexusError {
  declare public readonly code: C;

  /** Identifies a framework resource failure independently of remote business exceptions. */
  constructor(message: string, code: C, context?: Record<string, unknown>) {
    super(message, code, { context });
  }
}
