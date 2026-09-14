import { NexusError, type NexusErrorOptions } from "./nexus-error.js";
import type { SerializedError } from "../types/message.js";
import type { NexusConfigurationError } from "./usage-errors.js";
import type {
  NexusEndpointCapabilityError,
  NexusEndpointConnectError,
} from "./transport-errors.js";
import type { NexusServiceError } from "./service-errors.js";

export type NexusConnectionErrorCode =
  | "E_CONN_CLOSED"
  | "E_HANDSHAKE_FAILED"
  | "E_HANDSHAKE_REJECTED"
  | "E_CONNECTION_CONSTRAINT_FAILED"
  | "E_PROTOCOL_INCOMPATIBLE";

export type NexusHandshakeErrorCode =
  | "E_HANDSHAKE_REJECTED"
  | "E_HANDSHAKE_FAILED";

/**
 * Represents an error related to the connection layer (L2), such as
 * failures in establishing or maintaining a logical connection.
 */
export class NexusConnectionError extends NexusError {
  declare public readonly code: NexusConnectionErrorCode;
  /** Preserves the connection-layer failure and its session diagnostics. */
  constructor(
    message: string,
    code: NexusConnectionErrorCode,
    context?: Record<string, unknown>,
    cause?: SerializedError,
  ) {
    super(message, code, { context, cause });
  }
}

/** A target was acquired but its additional connection constraint failed. */
export class NexusConnectionConstraintFailedError extends NexusConnectionError {
  declare public readonly code: "E_CONNECTION_CONSTRAINT_FAILED";
  /** Reports acquisition predicate mismatch without implying a failed business invocation. */
  constructor(
    message: string,
    context?: Record<string, unknown>,
    cause?: SerializedError,
  ) {
    super(message, "E_CONNECTION_CONSTRAINT_FAILED", context, cause);
  }
}

/** The remote peer does not implement a capability required by this protocol. */
export class NexusProtocolIncompatibleError extends NexusConnectionError {
  declare public readonly code: "E_PROTOCOL_INCOMPATIBLE";
  /** Reports a peer that lacks the protocol capabilities required for this session. */
  constructor(
    message: string,
    context?: Record<string, unknown>,
    cause?: SerializedError,
  ) {
    super(message, "E_PROTOCOL_INCOMPATIBLE", context, cause);
  }
}

/**
 * Represents an error that occurred during the handshake protocol.
 * This is typically thrown when a connection is rejected by the remote
 * endpoint due to policy or verification failure.
 */
export class NexusHandshakeError extends NexusConnectionError {
  declare public readonly code: NexusHandshakeErrorCode;
  /** Records handshake rejection or failure with the original cause and stack. */
  constructor(
    message: string,
    code: NexusHandshakeErrorCode = "E_HANDSHAKE_REJECTED",
    context?: Record<string, unknown>,
    options?: NexusErrorOptions,
  ) {
    super(message, code, context, options?.cause);
    if (options?.stack) this.stack = options.stack;
  }
}

/** Concrete failures observable while acquiring one or more connections. */
export type ConnectionAcquireError =
  | import("./usage-errors.js").NexusUsageError<"E_USAGE_INVALID">
  | NexusConfigurationError
  | NexusEndpointCapabilityError
  | NexusEndpointConnectError
  | NexusHandshakeError
  | NexusConnectionConstraintFailedError
  | NexusProtocolIncompatibleError
  | NexusServiceError;
