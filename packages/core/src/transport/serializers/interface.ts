import type { NexusMessage } from "../../types/message";
import type { NexusProtocolError } from "../../errors/transport-errors";
import type { Result } from "neverthrow";

/**
 * Defines the standard interface for a serializer, responsible for converting
 * high-level logical `NexusMessage` objects to and from low-level data packets
 * (string or binary) that can be sent over an `IPort`.
 */
export interface ISerializer {
  readonly packetType: "string" | "arraybuffer";

  safeSerialize(
    logicalMessage: NexusMessage,
  ): Result<string | ArrayBuffer, NexusProtocolError>;

  safeDeserialize(
    packet: string | ArrayBuffer,
  ): Result<NexusMessage, NexusProtocolError>;
}
