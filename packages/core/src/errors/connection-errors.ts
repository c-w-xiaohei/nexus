import { NexusError } from "./nexus-error";

/**
 * Represents an error related to the connection layer (L2), such as
 * failures in establishing or maintaining a logical connection.
 */
export class NexusConnectionError extends NexusError {}

/**
 * Represents an error that occurred during the handshake protocol.
 * This is typically thrown when a connection is rejected by the remote
 * endpoint due to policy or verification failure.
 */
export class NexusHandshakeError extends NexusConnectionError {}
