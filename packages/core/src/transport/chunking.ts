import {
  CHUNKABLE_PACKET_TYPES,
  NexusMessageType,
  type ChunkStartMessage,
  type ChunkControlMessage,
  type NexusMessage,
} from "../types/message.js";
export const CHUNK_WINDOW = 4;

export const isChunkControl = (
  message: NexusMessage,
): message is ChunkControlMessage =>
  message.type === NexusMessageType.CHUNK_START ||
  message.type === NexusMessageType.CHUNK_DATA ||
  message.type === NexusMessageType.CHUNK_ACK ||
  message.type === NexusMessageType.CHUNK_CANCEL;

export const isApplicationPacketKind = (
  message: NexusMessage,
): message is Extract<
  NexusMessage,
  { type: ChunkStartMessage["packetKind"] }
> =>
  CHUNKABLE_PACKET_TYPES.includes(
    message.type as ChunkStartMessage["packetKind"],
  );

export interface Reassembly {
  readonly id: number;
  readonly packetKind: number;
  readonly totalBytes: number;
  readonly reservedBytes: number;
  readonly chunks: Uint8Array[];
  receivedBytes: number;
  receivedFrames: number;
}

export function concatChunks(
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== total)
    throw new TypeError("Reassembled packet size mismatch.");
  return output;
}
