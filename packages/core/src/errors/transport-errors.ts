import { NexusError, type NexusErrorOptions } from "./nexus-error.js";

/** Preserves structured diagnostics while accepting the existing shorthand context input. */
const errorOptions = (
  contextOrOptions?: Record<string, unknown> | NexusErrorOptions,
): NexusErrorOptions =>
  contextOrOptions &&
  ("cause" in contextOrOptions || "context" in contextOrOptions)
    ? (contextOrOptions as NexusErrorOptions)
    : { context: contextOrOptions as Record<string, unknown> | undefined };

/**
 * Base class for all Layer 1 (Transport & Protocol) errors.
 * These errors are related to physical connection establishment, data transmission,
 * or protocol handling (serialization/deserialization).
 */
export class NexusTransportError extends NexusError {}

/**
 * Indicates an error occurred when an IEndpoint service attempted to establish
 * a physical connection. Usually caused by underlying platform issues that prevent
 * connection establishment (e.g., target unreachable, platform-specific connection limits).
 *
 * **Responsibility**: Should be thrown by user-provided IEndpoint implementations
 * when their connect() method fails to establish a connection with the underlying platform.
 */
export class NexusEndpointConnectError extends NexusTransportError {
  declare public readonly code: "E_ENDPOINT_CONNECT_FAILED";
  /** Records endpoint dial failure with adapter diagnostics and an optional cause. */
  constructor(
    message: string,
    contextOrOptions?: Record<string, unknown> | NexusErrorOptions,
  ) {
    super(message, "E_ENDPOINT_CONNECT_FAILED", errorOptions(contextOrOptions));
  }
}

/**
 * Indicates an error occurred when an IEndpoint service attempted to listen
 * for incoming connections. Usually caused by underlying platform issues that prevent
 * the listening mechanism from starting (e.g., port occupied, insufficient permissions).
 *
 * **Responsibility**: Should be thrown by user-provided IEndpoint implementations
 * when their listen() method fails to start listening on the underlying platform.
 */
export class NexusEndpointListenError extends NexusTransportError {
  declare public readonly code: "E_ENDPOINT_LISTEN_FAILED";
  /** Records a listener startup failure without treating it as an RPC business error. */
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "E_ENDPOINT_LISTEN_FAILED", { context });
  }
}

/**
 * Indicates that the requested operation cannot be performed because the configured
 * IEndpoint does not support the required functionality. For example, calling connect()
 * on an endpoint that only implements listen(), or attempting to use Transferable objects
 * when the IEndpoint has not declared support for them.
 *
 * **Responsibility**: Thrown by Nexus kernel (Transport class) when attempting to use
 * IEndpoint methods that are not implemented, or when ISerializer capabilities don't
 * match IEndpoint.capabilities.
 */
export class NexusEndpointCapabilityError extends NexusTransportError {
  declare public readonly code: "E_ENDPOINT_CAPABILITY_MISMATCH";
  /** Identifies a required transport capability missing from the configured endpoint. */
  constructor(
    message: string,
    contextOrOptions?: Record<string, unknown> | NexusErrorOptions,
  ) {
    super(
      message,
      "E_ENDPOINT_CAPABILITY_MISMATCH",
      errorOptions(contextOrOptions),
    );
  }
}

/**
 * Indicates a protocol error occurred during message serialization or deserialization.
 * This includes incorrect data formats, unsupported data types, or data corruption
 * during transmission.
 *
 * **Responsibility**: Thrown by Nexus kernel (PortProcessor class) when it cannot
 * properly serialize NexusMessage to byte stream or deserialize from byte stream.
 * Usually occurs when passing non-serializable data or receiving corrupted messages.
 */
export class NexusProtocolError extends NexusTransportError {
  declare public readonly code: "E_PROTOCOL_ERROR";

  /** Records a local or remote protocol-boundary failure with its original diagnostic cause. */
  constructor(
    message: string,
    contextOrOptions?: Record<string, unknown> | NexusErrorOptions,
  ) {
    super(message, "E_PROTOCOL_ERROR", errorOptions(contextOrOptions));
  }
}
