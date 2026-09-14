import { NexusError, type NexusErrorOptions } from "./nexus-error.js";
import type { NexusDisconnectedError } from "./call-errors.js";

export type NexusServiceErrorCode =
  | "E_SERVICE_UNAVAILABLE"
  | "E_SERVICE_ACQUISITION_TIMEOUT"
  | "E_SERVICE_NO_MATCH"
  | "E_SERVICE_AMBIGUOUS"
  | "E_ABORTED";

export class NexusServiceError<
  C extends NexusServiceErrorCode = NexusServiceErrorCode,
> extends NexusError {
  declare public readonly code: C;
  /** Preserves a literal acquisition failure code with its routing and cause diagnostics. */
  constructor(message: string, code: C, options?: NexusErrorOptions) {
    super(message, code, options);
  }
}

/** Concrete failures observable while synchronously acquiring a connection resource. */
export type ResourceAcquireError =
  | NexusDisconnectedError
  | NexusServiceError<"E_SERVICE_UNAVAILABLE">
  | import("./usage-errors.js").NexusUsageError<"E_USAGE_INVALID">;
