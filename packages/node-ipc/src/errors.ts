export type NodeIpcErrorCode =
  | "E_IPC_ADDRESS_INVALID"
  | "E_IPC_ADDRESS_IN_USE"
  | "E_IPC_PATH_TOO_LONG"
  | "E_IPC_CONNECT_FAILED"
  | "E_IPC_AUTH_FAILED"
  | "E_IPC_PROTOCOL_ERROR"
  | "E_IPC_STALE_SOCKET_CLEANUP_FAILED";

export class NodeIpcError extends Error {
  readonly name = "NodeIpcError";

  constructor(
    message: string,
    readonly code: NodeIpcErrorCode,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}
