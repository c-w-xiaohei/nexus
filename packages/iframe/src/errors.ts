export type IframeAdapterErrorCode =
  | "E_IFRAME_CONFIG_INVALID"
  | "E_IFRAME_TARGET_NOT_FOUND"
  | "E_IFRAME_CONNECT_FAILED";

/**
 * Error thrown by the iframe adapter for configuration, target resolution, and
 * postMessage connection failures. Use `code` for stable programmatic handling.
 */
export class IframeAdapterError extends Error {
  constructor(
    message: string,
    readonly code: IframeAdapterErrorCode,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "IframeAdapterError";
  }
}
