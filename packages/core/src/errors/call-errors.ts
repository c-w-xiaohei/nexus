import { NexusError } from "./nexus-error";
import type { SerializedError } from "@/types/message";

/**
 * Represents an error in targeting a remote endpoint for a call.
 * This can happen if a target cannot be resolved, or if the wrong number
 * of targets are found for a given strategy (e.g., 'one').
 */
export class NexusTargetingError extends NexusError {}

/**
 * Represents a call that failed because no active connection matched the
 * provided `matcher`.
 */
export class NexusNoMatchingConnectionError extends NexusError {}

/**
 * Represents a remote procedure call that has timed out.
 */
export class NexusCallTimeoutError extends NexusError {}

/**
 * Represents an error that occurred within the business logic of the remote
 * endpoint. The original error is serialized and available in the context.
 */
export class NexusRemoteError extends NexusError {
  constructor(
    message: string,
    code: string,
    context: { remoteError: SerializedError } & Record<string, any>
  ) {
    super(message, code, context);
  }
}

/**
 * Represents a call that failed because the connection to the target
 * was closed, either before the call could be sent or while it was pending.
 */
export class NexusDisconnectedError extends NexusError {}
