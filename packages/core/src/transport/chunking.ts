import type {
  MessageId,
  NexusMessage,
  NexusMessageType,
} from "../types/message";

export namespace ChunkReassembler {
  type ChunkSession = {
    chunks: (string | ArrayBuffer)[];
    totalChunks: number;
    receivedChunks: number;
    originalMessageId: MessageId | null;
    originalMessageType: NexusMessageType;
  };

  export interface Runtime {
    processChunk(chunk: NexusMessage): string | ArrayBuffer | null;
  }

  export const create = (): Runtime => {
    const chunkBuffer = new Map<MessageId, ChunkSession>();

    const processChunk = (
      _chunk: NexusMessage,
    ): string | ArrayBuffer | null => {
      void chunkBuffer;
      return null;
    };

    return { processChunk };
  };
}
