import type { NexusMessage } from "../types/message";
import type { IPort } from "./types/port";
import type { ISerializer } from "./serializers/interface";
import { NexusProtocolError } from "../errors/transport-errors";
import { err, ok, type Result } from "neverthrow";

export interface PortProcessorHandlers {
  onLogicalMessage: (message: NexusMessage) => void;
  onDisconnect: () => void;
  onProtocolError?: (error: NexusProtocolError) => void;
}

export namespace PortProcessor {
  export interface Context {
    sendMessage(message: NexusMessage): Result<void, NexusProtocolError>;
    close(): Result<void, NexusProtocolError>;
  }

  export interface CreateOptions {
    chunkSize?: number;
    chunkTimeoutMs?: number;
  }

  export const create = (
    port: IPort,
    serializer: ISerializer,
    handlers: PortProcessorHandlers,
    _options: CreateOptions = {},
  ): Context => {
    const safePostMessage = (
      packet: string | ArrayBuffer,
    ): Result<void, NexusProtocolError> => {
      try {
        const transfer = packet instanceof ArrayBuffer ? [packet] : undefined;
        port.postMessage(packet, transfer);
        return ok(undefined);
      } catch (error) {
        return err(
          new NexusProtocolError(
            `Failed to post transport packet: ${error instanceof Error ? error.message : String(error)}`,
            { originalError: error },
          ),
        );
      }
    };

    const sendMessage = (
      message: NexusMessage,
    ): Result<void, NexusProtocolError> => {
      const packetResult = serializer.safeSerialize(message);
      if (packetResult.isErr()) {
        return err(packetResult.error);
      }

      return safePostMessage(packetResult.value);
    };

    const handleRawMessage = (rawMessage: any): void => {
      const deserialized = serializer.safeDeserialize(rawMessage);
      if (deserialized.isErr()) {
        handlers.onProtocolError?.(deserialized.error);
        return;
      }

      handlers.onLogicalMessage(deserialized.value);
    };

    port.onMessage(handleRawMessage);
    port.onDisconnect(handlers.onDisconnect);

    return {
      sendMessage,
      close: () => {
        try {
          port.close();
          return ok(undefined);
        } catch (error) {
          return err(
            new NexusProtocolError(
              `Failed to close transport port: ${error instanceof Error ? error.message : String(error)}`,
              { originalError: error },
            ),
          );
        }
      },
    };
  };
}
