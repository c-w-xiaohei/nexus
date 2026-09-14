import { NexusError } from "./nexus-error.js";
import type { SerializedError } from "../types/message.js";
import type { NexusResourceError } from "./resource-errors.js";
import type { NexusServiceError } from "./service-errors.js";
import type { NexusProtocolError } from "./transport-errors.js";

export type NexusCallTimeoutErrorCode = "E_CALL_TIMEOUT";
export type NexusRemoteErrorCode = "E_REMOTE_EXCEPTION";
export type NexusDisconnectedErrorCode = "E_CONN_CLOSED";

/**
 * Represents a remote procedure call that has timed out.
 */
export class NexusCallTimeoutError extends NexusError {
  declare public readonly code: NexusCallTimeoutErrorCode;
  /** Reports local wait expiry without claiming that remote execution was cancelled. */
  constructor(
    message: string,
    code: NexusCallTimeoutErrorCode = "E_CALL_TIMEOUT",
    context?: Record<string, unknown>,
  ) {
    super(message, code, { context });
  }
}

/**
 * Represents an error that occurred within the business logic of the remote
 * endpoint. The original error is serialized and available in the context.
 */
export class NexusRemoteError extends NexusError {
  declare public readonly code: NexusRemoteErrorCode;
  /** Wraps a business exception without trusting its code as a framework classification. */
  constructor(
    message: string,
    code: NexusRemoteErrorCode = "E_REMOTE_EXCEPTION",
    context: { remoteError: SerializedError } & Record<string, unknown>,
  ) {
    super(message, code, { context, cause: context.remoteError });
  }
}

/**
 * Represents a call that failed because the connection to the target
 * was closed, either before the call could be sent or while it was pending.
 */
export class NexusDisconnectedError extends NexusError {
  declare public readonly code: NexusDisconnectedErrorCode;
  /** Reports the terminal session failure for a bound call or resource acquisition. */
  constructor(
    message: string,
    code: NexusDisconnectedErrorCode = "E_CONN_CLOSED",
    context?: Record<string, unknown>,
  ) {
    super(message, code, { context });
  }
}

/** Concrete failures observable while consuming one RPC operation. */
export type NexusCallError =
  | import("./connection-errors.js").NexusProtocolIncompatibleError
  | NexusRemoteError
  | NexusDisconnectedError
  | NexusCallTimeoutError
  | NexusResourceError
  | NexusServiceError<"E_SERVICE_UNAVAILABLE">
  | NexusProtocolError;
