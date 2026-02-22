import { NexusError } from "./nexus-error";

export type NexusConnectionErrorCode =
  | "E_CONN_CLOSED"
  | "E_HANDSHAKE_FAILED"
  | "E_HANDSHAKE_REJECTED";

export type NexusHandshakeErrorCode =
  | "E_HANDSHAKE_REJECTED"
  | "E_HANDSHAKE_FAILED";

/**
 * Represents an error related to the connection layer (L2), such as
 * failures in establishing or maintaining a logical connection.
 */
export class NexusConnectionError extends NexusError {
  constructor(
    message: string,
    code: NexusConnectionErrorCode,
    context?: Record<string, unknown>,
  ) {
    super(message, code, { context });
  }
}

/**
 * Represents an error that occurred during the handshake protocol.
 * This is typically thrown when a connection is rejected by the remote
 * endpoint due to policy or verification failure.
 */
export class NexusHandshakeError extends NexusConnectionError {
  constructor(
    message: string,
    code: NexusHandshakeErrorCode = "E_HANDSHAKE_REJECTED",
    context?: Record<string, unknown>,
  ) {
    super(message, code, context);
  }
}
