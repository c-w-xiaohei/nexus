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
  public readonly code: string;

  /**
   * Provides additional contextual information about the error.
   * e.g., { connectionId: 'conn-123', serviceName: 'tasks' }
   */
  public readonly context?: Record<string, any>;

  constructor(message: string, code: string, context?: Record<string, any>) {
    super(message);
    this.name = this.constructor.name; // e.g., "NexusConnectionError"
    this.code = code;
    this.context = context;

    // Maintains proper stack trace in V8 environments (like Node.js and Chrome)
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = new Error(message).stack;
    }
  }
}
