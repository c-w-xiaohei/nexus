import type {
  MessageId,
  NexusMessage,
  NexusMessageType,
} from "../types/message";

// TODO: Define a configuration type for chunking, e.g., chunkSize, timeout.

/**
 * Manages the reassembly of chunked messages.
 * An instance of this class is created for each `PortProcessor` to handle
 * large messages that are split into multiple parts for transport.
 */
export class ChunkReassembler {
  // A buffer to store partial chunks for different chunk sessions.
  private readonly chunkBuffer = new Map<
    MessageId,
    {
      chunks: (string | ArrayBuffer)[];
      totalChunks: number;
      receivedChunks: number;
      originalMessageId: MessageId | null;
      originalMessageType: NexusMessageType;
      // TODO: Add a timeout handle.
    }
  >();

  /**
   * Processes an incoming data chunk. If the chunk completes a message,
   * it returns the fully reassembled message data.
   * @param chunk The incoming chunk message.
   * @returns The reassembled data packet (string or ArrayBuffer) if complete, otherwise null.
   */
  processChunk(chunk: NexusMessage): string | ArrayBuffer | null {
    // TODO: Implement the logic for handling CHUNK_START and CHUNK_DATA.
    // 1. On CHUNK_START, initialize a session in the buffer.
    // 2. On CHUNK_DATA, add the data to the session buffer.
    // 3. If all chunks are received, concatenate them, clear the session, and return the result.
    // 4. Implement a timeout to clear stale, incomplete sessions.
    throw new Error("Method not implemented.");
  }
}
