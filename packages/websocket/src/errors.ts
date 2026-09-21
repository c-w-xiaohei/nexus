export type WebSocketErrorCode =
  | "E_WEBSOCKET_ENDPOINT_CLOSED"
  | "E_WEBSOCKET_NOT_LISTENING"
  | "E_WEBSOCKET_ATTACH_REJECTED"
  | "E_WEBSOCKET_CAPACITY"
  | "E_WEBSOCKET_CLIENT_UNAVAILABLE"
  | "E_WEBSOCKET_CONNECTION_FAILED";

/** Adapter failures omit native errors and request credentials. */
export class WebSocketAdapterError extends Error {
  readonly name = "WebSocketAdapterError";

  constructor(
    message: string,
    readonly code: WebSocketErrorCode,
  ) {
    super(message);
  }
}
