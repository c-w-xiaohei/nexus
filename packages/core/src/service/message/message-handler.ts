import type { PlatformMeta, EndpointMeta } from "../../types/identity.js";
import type { NexusMessage } from "../../types/message.js";
import { getHandler } from "./handler-map.js";
import type { HandlerContext, MessageHandlerFn } from "./types/index.js";
import { Logger } from "../../logger.js";
import { Result } from "better-result";
const { err } = Result;

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
    ): Promise<Result<void, globalThis.Error>>;
  }

  export const create = <U extends EndpointMeta, P extends PlatformMeta>(
    context: HandlerContext<U, P>,
  ): Runtime => {
    const logger = new Logger("L3 <- MessageHandler");

    const safeHandleMessage = (
      message: NexusMessage,
      sourceConnectionId: string,
    ): Promise<Result<void, globalThis.Error>> => {
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
        return Result.tryPromise({
          try: () =>
            Promise.resolve(handler(context, message, sourceConnectionId)),
          catch: (error) =>
            error instanceof globalThis.Error
              ? error
              : new Error.InvalidMessage(String(error), {
                  context: { messageType: message.type },
                }),
        });
      }

      logger.error(
        `No message handler found for message type "${message.type}"`,
      );

      return Promise.resolve(
        err(
          new Error.InvalidMessage(
            `No message handler found for message type "${message.type}"`,
            { context: { messageType: message.type } },
          ),
        ),
      );
    };

    return {
      safeHandleMessage,
    };
  };
}
