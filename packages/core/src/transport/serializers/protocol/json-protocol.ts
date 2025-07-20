import * as Message from "@/types/message";
import type { IsEquivalent, MessageByType } from "@/types/message";

/**
 * A type-safe constructor function for the packet structure.
 * It validates at compile-time that for every message type, the provided array
 * of keys is an exact permutation of the keys of the message's interface.
 * If there is a mismatch, TypeScript will throw an error directly on the
 * misconfigured property, because its type will be inferred as `never`.
 *
 * @param structure The message structure definition, passed with `as const`.
 * @returns The validated, deeply readonly structure.
 */
const definePacketStructure = <
  T extends { readonly [K in Message.NexusMessageType]: readonly string[] },
>(
  structure: T & {
    [K in keyof T]: IsEquivalent<
      keyof MessageByType<K & Message.NexusMessageType>,
      T[K] extends readonly (infer E)[] ? E : never
    > extends true
      ? unknown // If keys match, allow any type (the original T[K] will pass).
      : never; // If they don't match, this property's type becomes `never`.
  }
): T => structure;

/**
 * A configuration table that defines the mapping between NexusMessage object
 * properties and their order in the serialized packet array.
 * It is wrapped in `definePacketStructure` to ensure compile-time safety.
 */
export const MESSAGE_PACKET_STRUCTURE = definePacketStructure({
  // Layer 3
  [Message.NexusMessageType.GET]: ["type", "id", "resourceId", "path"],
  [Message.NexusMessageType.SET]: ["type", "id", "resourceId", "path", "value"],
  [Message.NexusMessageType.APPLY]: [
    "type",
    "id",
    "resourceId",
    "path",
    "args",
  ],
  [Message.NexusMessageType.RES]: ["type", "id", "result"],
  [Message.NexusMessageType.ERR]: ["type", "id", "error"],
  [Message.NexusMessageType.RELEASE]: ["type", "id", "resourceId"],
  [Message.NexusMessageType.BATCH]: ["type", "id", "calls"],
  [Message.NexusMessageType.BATCH_RES]: ["type", "id", "results"],
  // Layer 2
  [Message.NexusMessageType.HANDSHAKE_REQ]: [
    "type",
    "id",
    "metadata",
    "assigns",
  ],
  [Message.NexusMessageType.HANDSHAKE_ACK]: ["type", "id", "metadata"],
  [Message.NexusMessageType.HANDSHAKE_REJECT]: ["type", "id", "error"],
  [Message.NexusMessageType.IDENTITY_UPDATE]: ["type", "id", "updates"],
  // Layer 1
  [Message.NexusMessageType.CHUNK_START]: [
    "type",
    "id",
    "totalChunks",
    "originalMessageId",
    "originalMessageType",
  ],
  [Message.NexusMessageType.CHUNK_DATA]: [
    "type",
    "id",
    "chunkIndex",
    "chunkData",
  ],
} as const);
