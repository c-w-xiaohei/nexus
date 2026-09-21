import * as Message from "../../types/message.js";
import type { ISerializer } from "./interface.js";
import { MESSAGE_PACKET_STRUCTURE } from "./protocol/json-protocol.js";
import { NexusProtocolError } from "../../errors/transport-errors.js";
import { toSerializedError } from "../../utils/error.js";
import { Result } from "better-result";
import { safeParse } from "valibot";
const { err, ok } = Result;

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

    const parsed = safeParse(Message.NexusMessageSchema, message);
    if (!parsed.success) {
      if (
        message.type === Message.NexusMessageType.BATCH &&
        Array.isArray(message.calls)
      ) {
        const invalidCall = message.calls.find(
          (call) => !call || typeof call !== "object",
        );
        if (invalidCall !== undefined) {
          return err(
            new NexusProtocolError(
              "Invalid Nexus-JSON batch message: call must be an object",
              { messageType: message.type, call: invalidCall },
            ),
          );
        }
      }
      return err(
        new NexusProtocolError("Invalid Nexus-JSON message shape", {
          messageType: message.type,
          message,
          issues: parsed.issues,
        }),
      );
    }

    if (
      message.type === Message.NexusMessageType.CHUNK_DATA &&
      message.chunkData instanceof ArrayBuffer
    ) {
      return err(
        new NexusProtocolError(
          "ArrayBuffer chunk data is not supported by JSON transport",
          { messageType: message.type },
        ),
      );
    }

    if (message.type === Message.NexusMessageType.BATCH) {
      return ok([
        message.type,
        message.id,
        message.calls.map(packMessageWithoutValidation),
      ]);
    }

    return ok(packMessageWithoutValidation(message));
  };

  const packMessageWithoutValidation = (
    message: Message.NexusMessage,
  ): any[] => {
    const structure = MESSAGE_PACKET_STRUCTURE[message.type];
    if (!structure) {
      throw new NexusProtocolError(
        `Unknown message type for serialization: ${message.type}`,
        { messageType: message.type, message },
      );
    }

    const packet = structure.map((key) => (message as any)[key]);
    if (!("invocationServiceName" in message)) {
      return toLegacyInvocationPacket(message.type, packet);
    }

    return packet;
  };

  const packetArrayToMessage = (
    packet: any[],
  ): Result<Message.NexusMessage, NexusProtocolError> => {
    if (packet.length === 0) {
      return err(
        new NexusProtocolError("Invalid Nexus-JSON packet: empty array", {
          packet,
        }),
      );
    }

    const messageType = packet[0];

    if (
      typeof messageType !== "number" ||
      !Object.prototype.hasOwnProperty.call(
        MESSAGE_PACKET_STRUCTURE,
        messageType,
      )
    ) {
      return err(
        new NexusProtocolError(
          `Unknown message type for deserialization: ${String(messageType)}`,
          { messageType, packet },
        ),
      );
    }

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

      const calls: Record<string, unknown>[] = [];
      for (const packedCall of packedCalls) {
        if (!Array.isArray(packedCall)) {
          return err(
            new NexusProtocolError(
              "Invalid Nexus-JSON batch packet: nested call must be an array",
              { packet, packedCall },
            ),
          );
        }
        const nestedType = packedCall[0];
        if (
          nestedType !== Message.NexusMessageType.GET &&
          nestedType !== Message.NexusMessageType.SET &&
          nestedType !== Message.NexusMessageType.APPLY
        ) {
          return err(
            new NexusProtocolError(
              "Invalid Nexus-JSON batch packet: nested call must be GET, SET, or APPLY",
              { packet, packedCall },
            ),
          );
        }
        calls.push(packetToLogicalMessage(packedCall, nestedType));
      }
      const batch = { type, id, calls };
      const parsed = safeParse(Message.BatchMessageSchema, batch);
      if (!parsed.success) {
        return err(
          new NexusProtocolError("Invalid Nexus-JSON batch packet", {
            packet,
            issues: parsed.issues,
          }),
        );
      }
      // Keep the reconstructed values, including opaque payloads and error extras.
      return ok(batch as Message.BatchMessage);
    }

    const logicalMessage = packetToLogicalMessage(packet, messageType);
    const parsed = safeParse(Message.NexusMessageSchema, logicalMessage);
    if (!parsed.success) {
      return err(
        new NexusProtocolError("Invalid Nexus-JSON packet shape", {
          messageType,
          packet,
          issues: parsed.issues,
        }),
      );
    }

    return ok(logicalMessage as Message.NexusMessage);
  };

  const packetToLogicalMessage = (
    packet: any[],
    messageType: Message.NexusMessageType,
  ): Record<string, unknown> => {
    const structure = MESSAGE_PACKET_STRUCTURE[messageType];
    const normalizedPacket = normalizeLegacyInvocationPacket(
      messageType,
      packet,
    );
    const logicalMessage: Record<string, unknown> = {};
    structure.forEach((key, index) => {
      const value = normalizedPacket[index];
      if (
        index >= normalizedPacket.length ||
        (key === "invocationServiceName" &&
          value === LEGACY_INVOCATION_SERVICE_NAME) ||
        (value === null && isNullablePaddingKey(key))
      )
        return;
      logicalMessage[key] = value;
    });

    return logicalMessage;
  };

  const LEGACY_INVOCATION_SERVICE_NAME = Symbol("legacyInvocationServiceName");

  const normalizeLegacyInvocationPacket = (
    messageType: Message.NexusMessageType,
    packet: any[],
  ): any[] => {
    if (messageType === Message.NexusMessageType.GET && packet.length === 4) {
      return [...packet, LEGACY_INVOCATION_SERVICE_NAME];
    }

    if (
      (messageType === Message.NexusMessageType.SET ||
        messageType === Message.NexusMessageType.APPLY) &&
      packet.length === 5
    ) {
      return [...packet.slice(0, 4), LEGACY_INVOCATION_SERVICE_NAME, packet[4]];
    }

    return packet;
  };

  const toLegacyInvocationPacket = (
    messageType: Message.NexusMessageType,
    packet: any[],
  ): any[] => {
    if (messageType === Message.NexusMessageType.GET) {
      return packet.slice(0, 4);
    }

    if (
      messageType === Message.NexusMessageType.SET ||
      messageType === Message.NexusMessageType.APPLY
    ) {
      return [...packet.slice(0, 4), packet[5]];
    }

    return packet;
  };

  const isNullablePaddingKey = (key: string): boolean =>
    key === "invocationServiceName" ||
    key === "assigns" ||
    key === "capabilities" ||
    key === "providers";

  export const safeSerialize = (
    logicalMessage: Message.NexusMessage,
  ): Result<string, NexusProtocolError> => {
    try {
      return messageToPacketArray(logicalMessage).andThen((packetArray) => {
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
    } catch (error) {
      return err(
        createThrownProtocolError("Failed to serialize JSON message", error),
      );
    }
  };

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

    try {
      return packetArrayToMessage(packetArray);
    } catch (error) {
      return err(
        createThrownProtocolError(
          "Failed to validate Nexus-JSON packet",
          error,
          {
            packet: packetArray,
          },
        ),
      );
    }
  };

  const createThrownProtocolError = (
    message: string,
    error: unknown,
    context: Record<string, unknown> = {},
  ): NexusProtocolError =>
    new NexusProtocolError(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: toSerializedError(error),
        context: { ...context, originalError: error },
      },
    );

  export const serializer: ISerializer = {
    packetType: "string",
    safeSerialize,
    safeDeserialize,
  };
}
