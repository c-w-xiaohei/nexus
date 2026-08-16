import { NexusError, type NexusErrorOptions } from "./nexus-error.js";

export type NexusServiceErrorCode =
  | "E_TARGET_REQUIRED"
  | "E_TARGET_CONSTRAINT_FAILED"
  | "E_SERVICE_UNAVAILABLE"
  | "E_SERVICE_ACQUISITION_TIMEOUT"
  | "E_SERVICE_NO_MATCH"
  | "E_SERVICE_AMBIGUOUS"
  | "E_SERVICE_WAIT_TIMEOUT"
  | "E_ABORTED";

export class NexusServiceError extends NexusError {
  constructor(
    message: string,
    code: NexusServiceErrorCode,
    options?: NexusErrorOptions,
  ) {
    super(message, code, options);
  }
}
