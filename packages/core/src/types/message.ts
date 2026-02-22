/**
 * If you update message types or structures here, you MUST also update the protocol serializers in @/transport/serializers/protocol.
 */

/**
 * The unique identifier for a request that expects a response.
 */
export type MessageId = string | number;

/**
 * Represents a standard format for serialized errors that can be safely
 * transmitted across contexts.
 */
export interface SerializedError {
  name: string;
  code: string;
  message: string;
  cause?: SerializedError;
  stack?: string;
}

/**
 * An enumeration of all possible message types within the Nexus framework.
 * The numeric values correspond to the protocol specification for efficient
 * network transport.
 */
export enum NexusMessageType {
  // === Layer 3: RPC & Service Proxy ===
  GET = 1,
  SET = 2,
  APPLY = 3,
  RES = 5,
  ERR = 6,
  RELEASE = 7,
  BATCH = 8,
  BATCH_RES = 9,
  // === Layer 2: Connection & Routing ===
  HANDSHAKE_REQ = 10,
  HANDSHAKE_ACK = 11,
  HANDSHAKE_REJECT = 12,
  IDENTITY_UPDATE = 13,
  // === Layer 1: Transport & Protocol ===
  CHUNK_START = 16,
  CHUNK_DATA = 17,
}

/**
 * The base interface for all Nexus messages, containing the type and a
 * potentially nullable message ID.
 */
interface NexusMessageBase {
  type: NexusMessageType;
  id: MessageId | null;
}

// =============================================================================
// Layer 3: RPC & Service Proxy Messages
// =============================================================================

/** A request to get a property from a remote resource. */
export interface GetMessage extends NexusMessageBase {
  type: NexusMessageType.GET;
  id: MessageId;
  resourceId: string | null;
  path: (string | number)[];
}

/** A request to set a property on a remote resource. */
export interface SetMessage extends NexusMessageBase {
  type: NexusMessageType.SET;
  id: MessageId;
  resourceId: string | null;
  path: (string | number)[];
  value: any;
}

/** A request to apply (call) a remote function or method. */
export interface ApplyMessage extends NexusMessageBase {
  type: NexusMessageType.APPLY;
  id: MessageId;
  resourceId: string | null;
  path: (string | number)[];
  args: any[];
}

/** A notification to release a remote resource, freeing memory. No response is expected. */
export interface ReleaseMessage extends NexusMessageBase {
  type: NexusMessageType.RELEASE;
  id: null;
  resourceId: string;
}

/** A batch of RPC requests to be executed together for performance. */
export interface BatchMessage extends NexusMessageBase {
  type: NexusMessageType.BATCH;
  id: MessageId;
  calls: (GetMessage | SetMessage | ApplyMessage)[];
}

/** A successful response to a request. */
export interface ResMessage extends NexusMessageBase {
  type: NexusMessageType.RES;
  id: MessageId;
  result: any;
}

/** An error response to a request. */
export interface ErrMessage extends NexusMessageBase {
  type: NexusMessageType.ERR;
  id: MessageId;
  error: SerializedError;
}

/** A batch of responses, corresponding to a BATCH request. */
export interface BatchResMessage extends NexusMessageBase {
  type: NexusMessageType.BATCH_RES;
  id: MessageId;
  results: ([0, any] | [1, SerializedError])[]; // [0, result] or [1, error]
}

// =============================================================================
// Layer 2: Connection & Routing Messages
// =============================================================================

/** A request to initiate a connection handshake and exchange metadata. */
export interface HandshakeReqMessage extends NexusMessageBase {
  type: NexusMessageType.HANDSHAKE_REQ;
  id: MessageId;
  metadata: any;
  /**
   * Optional metadata assigned by a parent context to a child context
   * during a "christening" handshake. Its presence signals a parent-child
   * connection type.
   */
  assigns?: any;
}

/** An acknowledgment to a handshake, confirming the connection. */
export interface HandshakeAckMessage extends NexusMessageBase {
  type: NexusMessageType.HANDSHAKE_ACK;
  id: MessageId;
  metadata: any;
}

/** A rejection of a handshake request due to policy or error. */
export interface HandshakeRejectMessage extends NexusMessageBase {
  type: NexusMessageType.HANDSHAKE_REJECT;
  id: MessageId;
  error: SerializedError;
}

/** A notification that an endpoint's metadata has been updated. */
export interface IdentityUpdateMessage extends NexusMessageBase {
  type: NexusMessageType.IDENTITY_UPDATE;
  id: null;
  updates: Partial<any>;
}

// =============================================================================
// Layer 1: Transport & Protocol Messages
// =============================================================================

/**
 * A control message indicating the start of a multi-chunk message transfer.
 * This is handled transparently by Layer 1.
 */
export interface ChunkStartMessage extends NexusMessageBase {
  type: NexusMessageType.CHUNK_START;
  id: MessageId; // Represents the chunk session ID
  totalChunks: number;
  originalMessageId: MessageId | null;
  originalMessageType: NexusMessageType;
}

/**
 * A message containing a single chunk of data for a large message.
 * This is handled transparently by Layer 1.
 */
export interface ChunkDataMessage extends NexusMessageBase {
  type: NexusMessageType.CHUNK_DATA;
  id: MessageId; // Represents the chunk session ID
  chunkIndex: number;
  chunkData: string | ArrayBuffer;
}

// =============================================================================
// Union Types for Type Safety
// =============================================================================

/** Represents any message that is a request and expects a response. */
export type RequestMessage =
  | GetMessage
  | SetMessage
  | ApplyMessage
  | BatchMessage
  | HandshakeReqMessage;

/** Represents any message that is a response to a request. */
export type ResponseMessage =
  | ResMessage
  | ErrMessage
  | BatchResMessage
  | HandshakeAckMessage
  | HandshakeRejectMessage;

/** Represents any message that does not expect a response. */
export type NotificationMessage = ReleaseMessage | IdentityUpdateMessage;

/**
 * A comprehensive union type representing any possible message that can be
 * processed by the Nexus core.
 */
export type NexusMessage =
  | RequestMessage
  | ResponseMessage
  | NotificationMessage
  | ChunkStartMessage
  | ChunkDataMessage;

// =============================================================================
// Type-level Validation for Protocol-Serializer Consistency
//
// The following type gymnastics ensure that MESSAGE_PACKET_STRUCTURE stays
// perfectly in sync with the message type definitions in `types/message.ts`.
// =============================================================================

/** Extracts a specific message interface from the NexusMessage union by its type. */
export type MessageByType<T extends NexusMessageType> = Extract<
  NexusMessage,
  { type: T }
>;

/**
 * Checks if two string literal unions are identical.
 * It verifies that A is a subset of B and B is a subset of A.
 */
export type IsEquivalent<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
