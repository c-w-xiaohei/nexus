import * as v from "valibot";

/**
 * If you update message types or structures here, you MUST also update the protocol serializers in @/transport/serializers/protocol.
 */

/**
 * The unique identifier for a request that expects a response.
 */
export const MessageIdSchema = v.union([
  v.string(),
  v.pipe(v.number(), v.finite()),
]);

export type MessageId = v.InferOutput<typeof MessageIdSchema>;

/**
 * Represents a standard format for serialized errors that can be safely
 * transmitted across contexts.
 */
const ErrorPathPartSchema = v.union([
  v.string(),
  v.pipe(v.number(), v.finite()),
]);

export type SerializedError = {
  name: string;
  code: string;
  message: string;
  origin?: "framework";
  cause?: SerializedError;
  context?: {
    originalError?: SerializedError;
    connectionId?: string;
    sourceConnectionId?: string;
    resourceId?: string | null;
    serviceName?: string;
    path?: (string | number)[];
  };
  stack?: string;
};

const SerializedErrorContextSchema = v.object({
  originalError: v.optional(v.lazy(() => SerializedErrorSchema)),
  connectionId: v.optional(v.string()),
  sourceConnectionId: v.optional(v.string()),
  resourceId: v.optional(v.nullable(v.string())),
  serviceName: v.optional(v.string()),
  path: v.optional(v.array(ErrorPathPartSchema)),
});

/** Runtime validation for the framework-owned, allowlisted error envelope. */
export const SerializedErrorSchema: v.GenericSchema<SerializedError> = v.object(
  {
    name: v.string(),
    code: v.string(),
    message: v.string(),
    origin: v.optional(v.literal("framework")),
    cause: v.optional(v.lazy(() => SerializedErrorSchema)),
    context: v.optional(SerializedErrorContextSchema),
    stack: v.optional(v.string()),
  },
);

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
  HANDSHAKE_READY = 14,
  PROVIDER_AVAILABLE = 15,
  // === Layer 1: Transport & Protocol ===
  CHUNK_START = 16,
  CHUNK_DATA = 17,
}

const AnyValueSchema: v.GenericSchema<any> = v.any();
const PathSchema = v.array(ErrorPathPartSchema);
const CapabilitiesSchema: v.GenericSchema<readonly string[]> = v.pipe(
  v.array(v.string()),
  v.readonly(),
);
// =============================================================================
// Layer 3: RPC & Service Proxy Messages
// =============================================================================

const ScopeIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const ScopeEntries = { scopeId: v.optional(ScopeIdSchema) };
const InvocationEntries = {
  id: MessageIdSchema,
  resourceId: v.nullable(v.string()),
  path: PathSchema,
  invocationServiceName: v.optional(v.string()),
  ...ScopeEntries,
  timeoutMs: v.optional(
    v.pipe(v.number(), v.finite(), v.minValue(Number.MIN_VALUE)),
  ),
  hops: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(64)),
  ),
};

/** A request to get a property from a remote resource. */
export const GetMessageSchema = v.object({
  type: v.literal(NexusMessageType.GET),
  ...InvocationEntries,
});

export type GetMessage = v.InferOutput<typeof GetMessageSchema>;

/** A request to set a property on a remote resource. */
export const SetMessageSchema = v.object({
  type: v.literal(NexusMessageType.SET),
  ...InvocationEntries,
  value: AnyValueSchema,
});

export type SetMessage = v.InferOutput<typeof SetMessageSchema>;

/** A request to apply (call) a remote function or method. */
export const ApplyMessageSchema = v.object({
  type: v.literal(NexusMessageType.APPLY),
  ...InvocationEntries,
  args: v.array(AnyValueSchema),
});

export type ApplyMessage = v.InferOutput<typeof ApplyMessageSchema>;

/** A single service or resource operation, excluding transport and batch envelopes. */
export type RpcRequest = GetMessage | SetMessage | ApplyMessage;

export function isRpcRequest(message: NexusMessage): message is RpcRequest {
  return (
    message.type === NexusMessageType.GET ||
    message.type === NexusMessageType.SET ||
    message.type === NexusMessageType.APPLY
  );
}

/** A notification to release a remote resource, freeing memory. No response is expected. */
export const ReleaseMessageSchema = v.union([
  v.object({
    type: v.literal(NexusMessageType.RELEASE),
    id: v.null_(),
    target: v.optional(v.literal("resource")),
    resourceId: v.string(),
    ...ScopeEntries,
  }),
  v.object({
    type: v.literal(NexusMessageType.RELEASE),
    id: v.null_(),
    target: v.literal("scope"),
    scopeId: ScopeIdSchema,
    resourceId: v.optional(v.never()),
  }),
]);

export type ReleaseMessage = v.InferOutput<typeof ReleaseMessageSchema>;

/** A batch of RPC requests to be executed together for performance. */
export const BatchMessageSchema = v.pipe(
  v.object({
    type: v.literal(NexusMessageType.BATCH),
    id: MessageIdSchema,
    ...ScopeEntries,
    calls: v.array(
      v.union([GetMessageSchema, SetMessageSchema, ApplyMessageSchema]),
    ),
  }),
  v.check(
    (batch) => batch.calls.every((call) => call.scopeId === batch.scopeId),
    "Batch calls must share their envelope scope.",
  ),
);

export type BatchMessage = v.InferOutput<typeof BatchMessageSchema>;

/** A successful response to a request. */
export const ResMessageSchema = v.object({
  type: v.literal(NexusMessageType.RES),
  id: MessageIdSchema,
  result: AnyValueSchema,
  ...ScopeEntries,
});

export type ResMessage = v.InferOutput<typeof ResMessageSchema>;

/** An error response to a request. */
export const ErrMessageSchema = v.object({
  type: v.literal(NexusMessageType.ERR),
  id: MessageIdSchema,
  error: SerializedErrorSchema,
  ...ScopeEntries,
});

export type ErrMessage = v.InferOutput<typeof ErrMessageSchema>;

/** A batch of responses, corresponding to a BATCH request. */
export const BatchResMessageSchema = v.object({
  type: v.literal(NexusMessageType.BATCH_RES),
  id: MessageIdSchema,
  ...ScopeEntries,
  results: v.array(
    v.union([
      v.tuple([v.literal(0), AnyValueSchema]),
      v.tuple([v.literal(1), SerializedErrorSchema]),
    ]),
  ),
});

export type BatchResMessage = v.InferOutput<typeof BatchResMessageSchema>;

// =============================================================================
// Layer 2: Connection & Routing Messages
// =============================================================================

/** A request to initiate a connection handshake and exchange metadata. */
export const HandshakeReqMessageSchema = v.object({
  type: v.literal(NexusMessageType.HANDSHAKE_REQ),
  id: MessageIdSchema,
  metadata: AnyValueSchema,
  /**
   * Optional metadata assigned by a parent context to a child context
   * during a "christening" handshake. Its presence signals a parent-child
   * connection type.
   */
  assigns: v.optional(AnyValueSchema),
  capabilities: v.optional(CapabilitiesSchema),
});

export type HandshakeReqMessage = v.InferOutput<
  typeof HandshakeReqMessageSchema
>;

/** An acknowledgment to a handshake, confirming the connection. */
export const HandshakeAckMessageSchema = v.object({
  type: v.literal(NexusMessageType.HANDSHAKE_ACK),
  id: MessageIdSchema,
  metadata: AnyValueSchema,
  capabilities: v.optional(CapabilitiesSchema),
  providers: v.optional(CapabilitiesSchema),
});

export type HandshakeAckMessage = v.InferOutput<
  typeof HandshakeAckMessageSchema
>;

/** A final confirmation that both sides accepted the handshake. */
export const HandshakeReadyMessageSchema = v.object({
  type: v.literal(NexusMessageType.HANDSHAKE_READY),
  id: MessageIdSchema,
  capabilities: v.optional(CapabilitiesSchema),
  providers: v.optional(CapabilitiesSchema),
});

export type HandshakeReadyMessage = v.InferOutput<
  typeof HandshakeReadyMessageSchema
>;

/** A rejection of a handshake request due to policy or error. */
export const HandshakeRejectMessageSchema = v.object({
  type: v.literal(NexusMessageType.HANDSHAKE_REJECT),
  id: MessageIdSchema,
  error: SerializedErrorSchema,
});

export type HandshakeRejectMessage = v.InferOutput<
  typeof HandshakeRejectMessageSchema
>;

/** A notification that an endpoint's metadata has been updated. */
export const IdentityUpdateMessageSchema = v.object({
  type: v.literal(NexusMessageType.IDENTITY_UPDATE),
  id: v.null_(),
  updates: AnyValueSchema,
});

export type IdentityUpdateMessage = v.InferOutput<
  typeof IdentityUpdateMessageSchema
>;

/** Announces a newly available service on an already negotiated session. */
export const ProviderAvailableMessageSchema = v.object({
  type: v.literal(NexusMessageType.PROVIDER_AVAILABLE),
  id: v.null_(),
  providers: CapabilitiesSchema,
  removed: v.optional(CapabilitiesSchema),
});

export type ProviderAvailableMessage = v.InferOutput<
  typeof ProviderAvailableMessageSchema
>;

// =============================================================================
// Layer 1: Transport & Protocol Messages
// =============================================================================

/**
 * A control message indicating the start of a multi-chunk message transfer.
 * This is handled transparently by Layer 1.
 */
export const ChunkStartMessageSchema = v.object({
  type: v.literal(NexusMessageType.CHUNK_START),
  id: MessageIdSchema,
  totalChunks: v.pipe(v.number(), v.finite()),
  originalMessageId: v.nullable(MessageIdSchema),
  originalMessageType: v.enum(NexusMessageType),
});

export type ChunkStartMessage = v.InferOutput<typeof ChunkStartMessageSchema>;

/** A message containing a single chunk of data for a large message. */
export const ChunkDataMessageSchema = v.object({
  type: v.literal(NexusMessageType.CHUNK_DATA),
  id: MessageIdSchema,
  chunkIndex: v.pipe(v.number(), v.finite()),
  chunkData: v.union([v.string(), v.instance(ArrayBuffer)]),
});

export type ChunkDataMessage = v.InferOutput<typeof ChunkDataMessageSchema>;

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
  | HandshakeReadyMessage
  | HandshakeRejectMessage;

/** Represents any message that does not expect a response. */
export type NotificationMessage =
  | ReleaseMessage
  | IdentityUpdateMessage
  | ProviderAvailableMessage;

/** The single runtime contract for all sixteen framework message variants. */
export const NexusMessageSchema = v.union([
  GetMessageSchema,
  SetMessageSchema,
  ApplyMessageSchema,
  ResMessageSchema,
  ErrMessageSchema,
  ReleaseMessageSchema,
  BatchMessageSchema,
  BatchResMessageSchema,
  HandshakeReqMessageSchema,
  HandshakeAckMessageSchema,
  HandshakeRejectMessageSchema,
  HandshakeReadyMessageSchema,
  IdentityUpdateMessageSchema,
  ProviderAvailableMessageSchema,
  ChunkStartMessageSchema,
  ChunkDataMessageSchema,
]);

export type NexusMessage = v.InferOutput<typeof NexusMessageSchema>;

/** Layer 3 envelopes that can carry a resource scope. */
export type RpcMessage = Extract<NexusMessage, { scopeId?: string }>;

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
