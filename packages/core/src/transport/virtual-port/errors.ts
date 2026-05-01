export class VirtualPortProtocolError extends Error {
  readonly name = "VirtualPortProtocolError";
  readonly code = "VIRTUAL_PORT_PROTOCOL_INVALID";

  constructor(
    message: string,
    readonly context?: unknown,
  ) {
    super(message);
  }
}

export class VirtualPortConnectError extends Error {
  readonly name = "VirtualPortConnectError";
  readonly code = "VIRTUAL_PORT_CONNECT_FAILED";

  constructor(
    message: string,
    readonly context?: unknown,
  ) {
    super(message);
  }
}

export class VirtualPortListenError extends Error {
  readonly name = "VirtualPortListenError";
  readonly code = "VIRTUAL_PORT_LISTEN_FAILED";

  constructor(
    message: string,
    readonly context?: unknown,
  ) {
    super(message);
  }
}

export class VirtualPortCloseError extends Error {
  readonly name = "VirtualPortCloseError";
  readonly code = "VIRTUAL_PORT_CLOSE_FAILED";

  constructor(
    message: string,
    readonly context?: unknown,
  ) {
    super(message);
  }
}
