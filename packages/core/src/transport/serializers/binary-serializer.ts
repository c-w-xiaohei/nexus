import type { NexusMessage } from "../../types/message";
import type { ISerializer } from "./interface";
import { NexusProtocolError } from "../../errors/transport-errors";

/**
 * Implements the `Nexus-Binary` serialization protocol using MessagePack.
 * This serializer is optimized for performance in environments that support
 * `Transferable` objects (e.g., Web Workers, Iframes), enabling near-zero-cost
 * transfer of large data payloads.
 */
export class BinarySerializer implements ISerializer {
  serialize(logicalMessage: NexusMessage): ArrayBuffer {
    // TODO: Implement MessagePack serialization.
    // This will involve using a library like msgpack-lite or similar.
    throw new NexusProtocolError("BinarySerializer not yet implemented", {
      messageType: logicalMessage.type,
    });
  }

  deserialize(packet: ArrayBuffer | string): NexusMessage {
    // TODO: Implement MessagePack deserialization.
    if (!(packet instanceof ArrayBuffer)) {
      throw new NexusProtocolError(
        "BinarySerializer can only process ArrayBuffer packets",
        { packetType: typeof packet }
      );
    }
    throw new NexusProtocolError("BinarySerializer not yet implemented", {
      packetSize: packet.byteLength,
    });
  }
}
