import type { NexusMessage } from "../../types/message";
import type { ISerializer } from "./interface";
import { NexusProtocolError } from "../../errors/transport-errors";
import { JsonSerializer } from "./json-serializer";
import { err, ok, type Result } from "neverthrow";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export namespace BinarySerializer {
  export const safeSerialize = (
    logicalMessage: NexusMessage,
  ): Result<string | ArrayBuffer, NexusProtocolError> =>
    JsonSerializer.safeSerialize(logicalMessage).andThen((jsonPacket) => {
      if (typeof jsonPacket !== "string") {
        return err(
          new NexusProtocolError(
            "BinarySerializer expects string JSON packets",
            {
              packetType: typeof jsonPacket,
            },
          ),
        );
      }

      try {
        const encoded = textEncoder.encode(jsonPacket);
        const buffer = encoded.buffer.slice(
          encoded.byteOffset,
          encoded.byteOffset + encoded.byteLength,
        );
        return ok(buffer);
      } catch (error) {
        return err(
          new NexusProtocolError(
            `Failed to binary-serialize packet: ${error instanceof Error ? error.message : String(error)}`,
            {
              messageType: logicalMessage.type,
              originalError: error,
            },
          ),
        );
      }
    });

  export const safeDeserialize = (
    packet: string | ArrayBuffer,
  ): Result<NexusMessage, NexusProtocolError> => {
    if (!(packet instanceof ArrayBuffer)) {
      return err(
        new NexusProtocolError(
          "BinarySerializer can only process ArrayBuffer packets",
          {
            packetType: typeof packet,
          },
        ),
      );
    }

    try {
      const jsonPacket = textDecoder.decode(packet);
      return JsonSerializer.safeDeserialize(jsonPacket);
    } catch (error) {
      return err(
        new NexusProtocolError(
          `Failed to binary-deserialize packet: ${error instanceof Error ? error.message : String(error)}`,
          {
            packetSize: packet.byteLength,
            originalError: error,
          },
        ),
      );
    }
  };

  export const serializer: ISerializer = {
    packetType: "arraybuffer",
    safeSerialize,
    safeDeserialize,
  };
}
