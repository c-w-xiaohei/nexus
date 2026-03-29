export type NexusStoreErrorCode =
  | "E_STORE_CONNECT"
  | "E_STORE_DISCONNECTED"
  | "E_STORE_ACTION"
  | "E_STORE_PROTOCOL";

export interface NexusStoreErrorOptions {
  cause?: unknown;
  context?: Record<string, unknown>;
}

export class NexusStoreError extends Error {
  public readonly code: NexusStoreErrorCode;
  public readonly context?: Record<string, unknown>;
  public readonly cause?: unknown;

  constructor(
    message: string,
    code: NexusStoreErrorCode,
    options: NexusStoreErrorOptions = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.context = options.context;
    this.cause = options.cause;

    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class NexusStoreConnectError extends NexusStoreError {
  constructor(message: string, options: NexusStoreErrorOptions = {}) {
    super(message, "E_STORE_CONNECT", options);
  }
}

export class NexusStoreDisconnectedError extends NexusStoreError {
  constructor(message: string, options: NexusStoreErrorOptions = {}) {
    super(message, "E_STORE_DISCONNECTED", options);
  }
}

export class NexusStoreActionError extends NexusStoreError {
  constructor(message: string, options: NexusStoreErrorOptions = {}) {
    super(message, "E_STORE_ACTION", options);
  }
}

export class NexusStoreProtocolError extends NexusStoreError {
  constructor(message: string, options: NexusStoreErrorOptions = {}) {
    super(message, "E_STORE_PROTOCOL", options);
  }
}

export const normalizeNexusStoreError = (error: unknown): NexusStoreError => {
  if (error instanceof NexusStoreError) {
    return error;
  }

  if (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "E_CONN_CLOSED"
  ) {
    return new NexusStoreDisconnectedError(error.message, { cause: error });
  }

  if (error instanceof Error) {
    return new NexusStoreProtocolError(error.message, { cause: error });
  }

  return new NexusStoreProtocolError("Unknown store error", {
    cause: error,
  });
};
