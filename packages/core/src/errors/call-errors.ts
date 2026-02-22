import { NexusError } from "./nexus-error";
import type { SerializedError } from "@/types/message";

export type NexusTargetingErrorCode =
  | "E_TARGET_NO_MATCH"
  | "E_TARGET_UNEXPECTED_COUNT";

export type NexusCallTimeoutErrorCode = "E_CALL_TIMEOUT";
export type NexusRemoteErrorCode = "E_REMOTE_EXCEPTION";
export type NexusDisconnectedErrorCode = "E_CONN_CLOSED";

/**
 * Represents an error in targeting a remote endpoint for a call.
 * This can happen if a target cannot be resolved, or if the wrong number
 * of targets are found for a given strategy (e.g., 'one').
 */
export class NexusTargetingError extends NexusError {
  constructor(
    message: string,
    code: NexusTargetingErrorCode,
    context?: Record<string, unknown>,
  ) {
    super(message, code, { context });
  }
}

/**
 * Represents a call that failed because no active connection matched the
 * provided `matcher`.
 */
export class NexusNoMatchingConnectionError extends NexusError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "E_TARGET_NO_MATCH", { context });
  }
}

/**
 * Represents a remote procedure call that has timed out.
 */
export class NexusCallTimeoutError extends NexusError {
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
  constructor(
    message: string,
    code: NexusDisconnectedErrorCode = "E_CONN_CLOSED",
    context?: Record<string, unknown>,
  ) {
    super(message, code, { context });
  }
}
