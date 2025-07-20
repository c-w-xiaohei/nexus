import { NexusError } from "./nexus-error";

/**
 * Base class for all Layer 1 (Transport & Protocol) errors.
 * These errors are related to physical connection establishment, data transmission,
 * or protocol handling (serialization/deserialization).
 */
export class NexusTransportError extends NexusError {}

/**
 * Indicates an error occurred when an IEndpoint implementation attempted to establish
 * a physical connection. Usually caused by underlying platform issues that prevent
 * connection establishment (e.g., target unreachable, platform-specific connection limits).
 * 
 * **Responsibility**: Should be thrown by user-provided IEndpoint implementations
 * when their connect() method fails to establish a connection with the underlying platform.
 */
export class NexusEndpointConnectError extends NexusTransportError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, "E_ENDPOINT_CONNECT_FAILED", context);
  }
}

/**
 * Indicates an error occurred when an IEndpoint implementation attempted to listen
 * for incoming connections. Usually caused by underlying platform issues that prevent
 * the listening mechanism from starting (e.g., port occupied, insufficient permissions).
 * 
 * **Responsibility**: Should be thrown by user-provided IEndpoint implementations
 * when their listen() method fails to start listening on the underlying platform.
 */
export class NexusEndpointListenError extends NexusTransportError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, "E_ENDPOINT_LISTEN_FAILED", context);
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
  constructor(message: string, context?: Record<string, any>) {
    super(message, "E_ENDPOINT_CAPABILITY_MISMATCH", context);
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
  constructor(message: string, context?: Record<string, any>) {
    super(message, "E_PROTOCOL_ERROR", context);
  }
}
