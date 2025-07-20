import type { NexusMessage } from "@/types/message";
import type { PlatformMetadata, UserMetadata } from "@/types/identity";
import type { Engine } from "../../engine";
import type { PayloadProcessor } from "../../payload/payload-processor";
import type { ResourceManager } from "../../resource-manager";

/**
 * The shared context object available to all message handlers.
 * It provides access to all the core L3 managers.
 */
export interface HandlerContext<
  U extends UserMetadata,
  P extends PlatformMetadata,
> {
  readonly engine: Engine<U, P>;
  readonly resourceManager: ResourceManager;
  readonly payloadProcessor: PayloadProcessor<U, P>;
}

/**
 * Defines the signature for a function that handles a specific Nexus message type.
 * @param context The shared handler context.
 * @param message The specific message to handle.
 * @param sourceConnectionId The ID of the connection the message came from.
 */
export type MessageHandlerFn<
  T extends NexusMessage,
  U extends UserMetadata = UserMetadata,
  P extends PlatformMetadata = PlatformMetadata,
> = (
  context: HandlerContext<U, P>,
  message: T,
  sourceConnectionId: string
) => Promise<void> | void;
