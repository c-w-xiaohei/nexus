import type { PlatformMetadata, UserMetadata } from "@/types/identity";
import type { NexusMessage } from "@/types/message";
import { getHandler } from "./handler-map";
import type { HandlerContext, MessageHandlerFn } from "./types";
import { Logger } from "@/logger";

/**
 * The main entry point for processing all incoming Layer 3 messages.
 * It looks up the appropriate handler for a message type and executes it.
 */
export class MessageHandler<
  U extends UserMetadata,
  P extends PlatformMetadata,
> {
  private readonly logger = new Logger("L3 <- MessageHandler");
  constructor(private readonly context: HandlerContext<U, P>) {}

  /**
   * Finds and executes the handler for a given message.
   * @param message The message to handle.
   * @param sourceConnectionId The ID of the connection the message came from.
   */
  public handleMessage(
    message: NexusMessage,
    sourceConnectionId: string
  ): Promise<void> {
    const handler = getHandler(message.type) as MessageHandlerFn<
      NexusMessage,
      U,
      P
    >;

    if (handler) {
      this.logger.debug(
        `Dispatching message #${message.id ?? "N/A"} to handler for type "${
          message.type
        }"`
      );
      // Wrap the handler's result in Promise.resolve() to ensure a promise is always returned.
      // This handles both sync (void) and async (Promise<void>) handlers.
      return Promise.resolve(
        handler(this.context, message, sourceConnectionId)
      );
    }

    // Reject the promise if no handler is found.
    // The Engine's catch block will be responsible for logging this critical failure.
    this.logger.error(
      `No message handler found for message type "${message.type}"`
    );
    return Promise.reject(
      new Error(`No message handler found for message type "${message.type}"`)
    );
  }
}
