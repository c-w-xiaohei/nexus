import type { PlatformMetadata, UserMetadata } from "@/types/identity";
import type { NexusMessage } from "@/types/message";
import { getHandler } from "./handler-map";
import type { HandlerContext, MessageHandlerFn } from "./types";
import { Logger } from "@/logger";
import { ResultAsync, errAsync } from "neverthrow";

export namespace MessageHandler {
  type ErrorCode = "E_USAGE_INVALID";

  type ErrorOptions = {
    readonly context?: Record<string, unknown>;
  };

  class InvalidMessageError extends globalThis.Error {
    readonly code: ErrorCode = "E_USAGE_INVALID";
    readonly context?: Record<string, unknown>;

    constructor(message: string, options: ErrorOptions = {}) {
      super(message);
      this.name = "MessageHandlerInvalidMessageError";
      this.context = options.context;
    }
  }

  export const Error = {
    InvalidMessage: InvalidMessageError,
  } as const;

  export interface Runtime {
    safeHandleMessage(
      message: NexusMessage,
      sourceConnectionId: string,
    ): ResultAsync<void, globalThis.Error>;
  }

  export const create = <U extends UserMetadata, P extends PlatformMetadata>(
    context: HandlerContext<U, P>,
  ): Runtime => {
    const logger = new Logger("L3 <- MessageHandler");

    const safeHandleMessage = (
      message: NexusMessage,
      sourceConnectionId: string,
    ): ResultAsync<void, globalThis.Error> => {
      const handler = getHandler(message.type) as MessageHandlerFn<
        NexusMessage,
        U,
        P
      >;

      if (handler) {
        logger.debug(
          `Dispatching message #${message.id ?? "N/A"} to handler for type "${
            message.type
          }"`,
        );
        return ResultAsync.fromPromise(
          Promise.resolve(handler(context, message, sourceConnectionId)),
          (error) =>
            error instanceof globalThis.Error
              ? error
              : new Error.InvalidMessage(String(error), {
                  context: { messageType: message.type },
                }),
        );
      }

      logger.error(
        `No message handler found for message type "${message.type}"`,
      );

      return errAsync(
        new Error.InvalidMessage(
          `No message handler found for message type "${message.type}"`,
          { context: { messageType: message.type } },
        ),
      );
    };

    return {
      safeHandleMessage,
    };
  };
}
