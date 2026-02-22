import { NexusError } from "./nexus-error";

export type NexusResourceErrorCode =
  | "E_RESOURCE_NOT_FOUND"
  | "E_RESOURCE_ACCESS_DENIED"
  | "E_INVALID_SERVICE_PATH"
  | "E_TARGET_NOT_CALLABLE"
  | "E_SET_ON_ROOT";

/**
 * Represents an error where a requested local resource (e.g., a function
 * or object passed by reference) could not be found.
 */
export class NexusResourceError extends NexusError {
  constructor(
    message: string,
    code: NexusResourceErrorCode,
    context?: Record<string, unknown>,
  ) {
    super(message, code, { context });
  }
}
