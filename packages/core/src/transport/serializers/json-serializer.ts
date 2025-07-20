import * as Message from "../../types/message";
import type { ISerializer } from "./interface";
import { MESSAGE_PACKET_STRUCTURE } from "./protocol/json-protocol";
import { NexusProtocolError } from "../../errors/transport-errors";

/**
 * Implements the `Nexus-JSON` serialization protocol.
 * This serializer is designed for environments where `Transferable` objects
 * are not supported (e.g., Chrome Extension content-script to background
 * communication). It encodes messages into a structured JSON array format,
 * driven by a declarative configuration table.
 *
 * NOTE: This serializer is only responsible for converting between the
 * `NexusMessage` object and its array representation. It does not handle
 * special value sanitization (e.g., functions, undefined), which is
 * a higher-level concern.
 */
export class JsonSerializer implements ISerializer {
  public serialize(logicalMessage: Message.NexusMessage): string {
    const packetArray = this.messageToPacketArray(logicalMessage);
    return JSON.stringify(packetArray);
  }

  public deserialize(packet: string): Message.NexusMessage {
    if (typeof packet !== "string") {
      throw new NexusProtocolError(
        "JsonSerializer can only process string packets",
        { packetType: typeof packet }
      );
    }

    let packetArray: any;
    try {
      packetArray = JSON.parse(packet);
    } catch (error) {
      throw new NexusProtocolError(
        `Invalid JSON in packet: ${error instanceof Error ? error.message : String(error)}`,
        { packet, originalError: error }
      );
    }

    if (!Array.isArray(packetArray)) {
      throw new NexusProtocolError("Invalid Nexus-JSON packet: not an array", {
        packet,
        packetArray,
      });
    }

    return this.packetArrayToMessage(packetArray);
  }

  /**
   * Converts a logical `NexusMessage` object into its packet array representation.
   * @param message The logical message to convert.
   * @returns The message represented as an array.
   */
  private messageToPacketArray(message: Message.NexusMessage): any[] {
    // BATCH messages are a special case with nested message structures.
    if (message.type === Message.NexusMessageType.BATCH) {
      const batchMessage = message as Message.BatchMessage;
      const packedCalls = batchMessage.calls.map((call) =>
        this.messageToPacketArray(call)
      );
      return [batchMessage.type, batchMessage.id, packedCalls];
    }

    const structure = MESSAGE_PACKET_STRUCTURE[message.type];
    if (!structure) {
      throw new NexusProtocolError(
        `Unknown message type for serialization: ${message.type}`,
        { messageType: message.type, message }
      );
    }

    return structure.map((key) => (message as any)[key]);
  }

  /**
   * Converts a packet array back into a logical `NexusMessage` object.
   * @param packet The packet array to convert.
   * @returns The logical message object.
   */
  private packetArrayToMessage(packet: any[]): Message.NexusMessage {
    const messageType = packet[0] as Message.NexusMessageType;

    // BATCH messages are a special case with nested message structures.
    if (messageType === Message.NexusMessageType.BATCH) {
      const [type, id, packedCalls] = packet;
      const calls = packedCalls.map((p: any[]) => this.packetArrayToMessage(p));
      return { type, id, calls } as Message.BatchMessage;
    }

    const structure = MESSAGE_PACKET_STRUCTURE[messageType];
    if (!structure) {
      throw new NexusProtocolError(
        `Unknown message type for deserialization: ${messageType}`,
        { messageType, packet }
      );
    }

    const logicalMessage: any = {};
    structure.forEach((key, index) => {
      if (index < packet.length) {
        logicalMessage[key] = packet[index];
      }
    });

    return logicalMessage as Message.NexusMessage;
  }
}
