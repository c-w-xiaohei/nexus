import type { NexusMessage } from "../../types/message";

/**
 * Defines the standard interface for a serializer, responsible for converting
 * high-level logical `NexusMessage` objects to and from low-level data packets
 * (string or binary) that can be sent over an `IPort`.
 */
export interface ISerializer {
  /**
   * Serializes a logical Nexus message into a format suitable for transport.
   * @param logicalMessage The `NexusMessage` object to serialize.
   * @returns A `string` or `ArrayBuffer` representing the serialized message.
   */
  serialize(logicalMessage: NexusMessage): string | ArrayBuffer;

  /**
   * Deserializes a raw data packet received from an `IPort` back into a
   * logical `NexusMessage` object.
   * @param packet The `string` or `ArrayBuffer` packet to deserialize.
   * @returns The deserialized `NexusMessage` object.
   */
  deserialize(packet: string | ArrayBuffer): NexusMessage;
}
