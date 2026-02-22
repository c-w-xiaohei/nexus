import type { SerializedError } from "@/types/message";

export type NexusErrorCode =
  | "E_UNKNOWN"
  | "E_CALL_TIMEOUT"
  | "E_CONN_CLOSED"
  | "E_HANDSHAKE_REJECTED"
  | "E_HANDSHAKE_FAILED"
  | "E_TARGET_NO_MATCH"
  | "E_TARGET_UNEXPECTED_COUNT"
  | "E_REMOTE_EXCEPTION"
  | "E_ENDPOINT_CONNECT_FAILED"
  | "E_ENDPOINT_LISTEN_FAILED"
  | "E_ENDPOINT_CAPABILITY_MISMATCH"
  | "E_PROTOCOL_ERROR"
  | "E_RESOURCE_NOT_FOUND"
  | "E_RESOURCE_ACCESS_DENIED"
  | "E_INVALID_SERVICE_PATH"
  | "E_TARGET_NOT_CALLABLE"
  | "E_SET_ON_ROOT"
  | "E_CONFIGURATION_INVALID"
  | "E_USAGE_INVALID";

export interface NexusErrorOptions {
  context?: Record<string, unknown>;
  cause?: SerializedError;
  stack?: string;
}

/**
 * The base class for all predictable exceptions thrown by the Nexus framework.
 * It provides a consistent structure for easier identification and handling.
 */
export class NexusError extends Error {
  /**
   * A machine-readable, unique error code.
   * This allows for programmatic handling and remains stable across framework versions.
   * e.g., 'E_CONN_TIMEOUT', 'E_TARGET_NOT_FOUND'
   */
  public readonly code: NexusErrorCode;

  /**
   * Provides additional contextual information about the error.
   * e.g., { connectionId: 'conn-123', serviceName: 'tasks' }
   */
  public readonly context?: Record<string, unknown>;

  public readonly cause?: SerializedError;

  constructor(
    message: string,
    code: NexusErrorCode,
    options: NexusErrorOptions = {},
  ) {
    super(message);
    this.name = this.constructor.name; // e.g., "NexusConnectionError"
    this.code = code;
    this.context = options.context;
    this.cause = options.cause;

    // Maintains proper stack trace in V8 environments (like Node.js and Chrome)
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
      if (options.stack) {
        this.stack = options.stack;
      }
    } else {
      this.stack = options.stack ?? new Error(message).stack;
    }
  }
}
