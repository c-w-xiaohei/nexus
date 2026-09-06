import type { NexusMessage } from "../types/message.js";
import type { IPort } from "./types/port.js";
import type { ISerializer } from "./serializers/interface.js";
import { NexusProtocolError } from "../errors/transport-errors.js";
import { Result } from "better-result";
const { err, ok } = Result;

export interface PortProcessorHandlers {
  /** Receive a decoded packet; registration may synchronously replay buffered data. */
  onLogicalMessage: (message: NexusMessage) => void;
  /** Handle native disconnect; session owners must tolerate repeated notifications. */
  onDisconnect: () => void;
  /** Handle malformed packets; the session owner decides whether to close. */
  onProtocolError?: (error: NexusProtocolError) => void;
}

export namespace PortProcessor {
  export interface Context {
    /** Serialize and hand a packet to the native port; Ok does not acknowledge delivery. */
    sendMessage(message: NexusMessage): Result<void, NexusProtocolError>;
    /** Close the native port, returning any native exception as a protocol error. */
    close(): Result<void, NexusProtocolError>;
  }

  export interface CreateOptions {
    /** TODO: Chunking is not implemented; packets currently pass through whole. */
    chunkSize?: number;
    chunkTimeoutMs?: number;
  }

  /**
   * Bind codec and native events to a port. Subscribes synchronously and takes
   * ownership of cleanup if subscription fails; rethrows the original setup error.
   * Chunking options are reserved and have no effect.
   */
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
      return serializer.safeSerialize(message).andThen(safePostMessage);
    };

    const handleRawMessage = (rawMessage: any): void => {
      const deserialized = serializer.safeDeserialize(rawMessage);
      if (deserialized.isErr()) {
        handlers.onProtocolError?.(deserialized.error);
        return;
      }

      handlers.onLogicalMessage(deserialized.value);
    };

    // Subscribe to disconnect first: onMessage may synchronously replay data.
    // Until both subscriptions succeed, this factory still owns the raw port.
    const subscribed = Result.try({
      try: () => {
        port.onDisconnect(handlers.onDisconnect);
        port.onMessage(handleRawMessage);
      },
      catch: (error) => error,
    });
    if (subscribed.isErr()) {
      Result.try({ try: () => port.close(), catch: (error) => error }).match({
        ok: () => undefined,
        err: (error) =>
          console.error(
            "Nexus DEV: failed to close partially subscribed port",
            error,
          ),
      });
      // Preserve the original setup failure at this throw-style factory boundary.
      throw subscribed.error;
    }

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
