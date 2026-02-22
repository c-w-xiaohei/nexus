import * as Message from "../../types/message";
import type { ISerializer } from "./interface";
import { MESSAGE_PACKET_STRUCTURE } from "./protocol/json-protocol";
import { NexusProtocolError } from "../../errors/transport-errors";
import { err, ok, type Result } from "neverthrow";

export namespace JsonSerializer {
  const messageToPacketArray = (
    message: Message.NexusMessage,
  ): Result<any[], NexusProtocolError> => {
    if (!message || typeof message !== "object") {
      return err(
        new NexusProtocolError(
          "Invalid Nexus-JSON message: expected an object",
          {
            message,
          },
        ),
      );
    }

    if (message.type === Message.NexusMessageType.BATCH) {
      const batchMessage = message as Message.BatchMessage;
      if (!Array.isArray(batchMessage.calls)) {
        return err(
          new NexusProtocolError(
            "Invalid Nexus-JSON batch message: calls must be an array",
            {
              messageType: batchMessage.type,
              message: batchMessage,
            },
          ),
        );
      }

      return batchMessage.calls
        .reduce<Result<any[][], NexusProtocolError>>(
          (result, call) =>
            result.andThen((calls) => {
              if (!call || typeof call !== "object") {
                return err(
                  new NexusProtocolError(
                    "Invalid Nexus-JSON batch message: call must be an object",
                    {
                      messageType: batchMessage.type,
                      call,
                    },
                  ),
                );
              }

              return messageToPacketArray(call).map((packedCall) => [
                ...calls,
                packedCall,
              ]);
            }),
          ok([]),
        )
        .map((packedCalls) => [
          batchMessage.type,
          batchMessage.id,
          packedCalls,
        ]);
    }

    const structure = MESSAGE_PACKET_STRUCTURE[message.type];
    if (!structure) {
      return err(
        new NexusProtocolError(
          `Unknown message type for serialization: ${message.type}`,
          { messageType: message.type, message },
        ),
      );
    }

    return ok(structure.map((key) => (message as any)[key]));
  };

  const packetArrayToMessage = (
    packet: any[],
  ): Result<Message.NexusMessage, NexusProtocolError> => {
    const messageType = packet[0] as Message.NexusMessageType;

    if (messageType === Message.NexusMessageType.BATCH) {
      const [type, id, packedCalls] = packet;
      if (!Array.isArray(packedCalls)) {
        return err(
          new NexusProtocolError(
            "Invalid Nexus-JSON batch packet: calls must be an array",
            {
              packet,
            },
          ),
        );
      }

      return packedCalls
        .reduce<Result<any[], NexusProtocolError>>(
          (result, packedCall) =>
            result.andThen((calls) => {
              if (!Array.isArray(packedCall)) {
                return err(
                  new NexusProtocolError(
                    "Invalid Nexus-JSON batch packet: nested call must be an array",
                    {
                      packet,
                      packedCall,
                    },
                  ),
                );
              }

              return packetArrayToMessage(packedCall).map((call) => [
                ...calls,
                call,
              ]);
            }),
          ok([]),
        )
        .map((calls) => ({ type, id, calls }) as Message.BatchMessage);
    }

    const structure = MESSAGE_PACKET_STRUCTURE[messageType];
    if (!structure) {
      return err(
        new NexusProtocolError(
          `Unknown message type for deserialization: ${messageType}`,
          { messageType, packet },
        ),
      );
    }

    const logicalMessage: any = {};
    structure.forEach((key, index) => {
      if (index < packet.length) {
        logicalMessage[key] = packet[index];
      }
    });

    return ok(logicalMessage as Message.NexusMessage);
  };

  export const safeSerialize = (
    logicalMessage: Message.NexusMessage,
  ): Result<string | ArrayBuffer, NexusProtocolError> =>
    messageToPacketArray(logicalMessage).andThen((packetArray) => {
      try {
        return ok(JSON.stringify(packetArray));
      } catch (error) {
        return err(
          new NexusProtocolError(
            `Failed to serialize JSON packet: ${error instanceof Error ? error.message : String(error)}`,
            { messageType: logicalMessage.type, originalError: error },
          ),
        );
      }
    });

  export const safeDeserialize = (
    packet: string | ArrayBuffer,
  ): Result<Message.NexusMessage, NexusProtocolError> => {
    if (typeof packet !== "string") {
      return err(
        new NexusProtocolError(
          "JsonSerializer can only process string packets",
          {
            packetType: typeof packet,
          },
        ),
      );
    }

    let packetArray: any;
    try {
      packetArray = JSON.parse(packet);
    } catch (error) {
      return err(
        new NexusProtocolError(
          `Invalid JSON in packet: ${error instanceof Error ? error.message : String(error)}`,
          { packet, originalError: error },
        ),
      );
    }

    if (!Array.isArray(packetArray)) {
      return err(
        new NexusProtocolError("Invalid Nexus-JSON packet: not an array", {
          packet,
          packetArray,
        }),
      );
    }

    return packetArrayToMessage(packetArray);
  };

  export const serializer: ISerializer = {
    packetType: "string",
    safeSerialize,
    safeDeserialize,
  };
}
