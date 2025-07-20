import type { NexusMessage } from "../types/message";
import type { IPort } from "./types/port";
import type { ISerializer } from "./serializers/interface";
import { ChunkReassembler } from "./chunking";
import { NexusProtocolError } from "../errors/transport-errors";

/**
 * Handlers for the logical events of a PortProcessor.
 * These are provided by Layer 2 to process incoming data and lifecycle events.
 */
export interface PortProcessorHandlers {
  onLogicalMessage: (message: NexusMessage) => void;
  onDisconnect: () => void;
}

/**
 * A "logical data port" that wraps a raw `IPort`.
 * It's the core workhorse of Layer 1, responsible for orchestrating
 * serialization, chunking, and deserialization for a single connection.
 * It ensures that Layer 2 interacts only with clean, logical `NexusMessage`
 * objects, completely hiding the complexities of the transport protocol.
 */
export class PortProcessor {
  private readonly reassembler = new ChunkReassembler();

  constructor(
    private readonly port: IPort,
    private readonly serializer: ISerializer,
    handlers: PortProcessorHandlers,
    // TODO: Add chunking configuration.
    private readonly chunkSize = Infinity
  ) {
    this.port.onMessage((msg) =>
      this.handleRawMessage(msg, handlers.onLogicalMessage)
    );
    this.port.onDisconnect(handlers.onDisconnect);
  }

  /**
   * Sends a logical message over the port, handling serialization and chunking.
   * @param message The `NexusMessage` to send.
   */
  public sendMessage(message: NexusMessage): void {
    try {
      const packet = this.serializer.serialize(message);
      const packetSize =
        packet instanceof ArrayBuffer ? packet.byteLength : packet.length;

      if (packetSize > this.chunkSize) {
        // TODO: Implement chunking logic.
        // 1. Generate a chunk session ID.
        // 2. Send a CHUNK_START message.
        // 3. Split the packet into chunks and send CHUNK_DATA messages.
        this.port.postMessage(packet); // Placeholder
      } else {
        this.port.postMessage(packet);
      }
    } catch (error) {
      throw new NexusProtocolError(
        `Failed to serialize message: ${error instanceof Error ? error.message : String(error)}`,
        {
          messageType: message.type,
          messageId: message.id,
          originalError: error,
        }
      );
    }
  }

  /**
   * Closes the underlying port.
   */
  public close(): void {
    this.port.close();
  }

  private handleRawMessage(
    rawMessage: any,
    onLogicalMessage: (message: NexusMessage) => void
  ): void {
    // This is the entry point for all incoming data from the raw port.
    // The logic here is simplified and needs to be expanded to handle chunks.
    // 1. Attempt to deserialize. If it's a chunk control message, pass to reassembler.
    // 2. If reassembler returns a full packet, deserialize *that* packet.
    // 3. If it's not a chunk message, deserialize directly.
    try {
      const logicalMessage = this.serializer.deserialize(rawMessage);
      onLogicalMessage(logicalMessage);
    } catch (error) {
      throw new NexusProtocolError(
        `Failed to deserialize message: ${error instanceof Error ? error.message : String(error)}`,
        { rawMessage, originalError: error }
      );
    }
  }
}
