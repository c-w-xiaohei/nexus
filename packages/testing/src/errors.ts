export type NexusMockErrorCode =
  | "E_MOCK_SERVICE_NOT_FOUND"
  | "E_MOCK_UNSUPPORTED_OPERATION";

export class NexusMockError extends Error {
  readonly name = "NexusMockError";

  constructor(
    message: string,
    readonly code: NexusMockErrorCode,
    readonly context?: Record<string, unknown>,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}
