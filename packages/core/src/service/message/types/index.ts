import type { NexusMessage } from "../../../types/message.js";
import type { PlatformMeta, EndpointMeta } from "../../../types/identity.js";
import type { MessageHandlerCallbacks } from "../../engine.js";
import type { PayloadProcessor } from "../../payload/payload-processor.js";
import type { ResourceManager } from "../../resource-manager.js";
import type { NexusAuthorizationPolicy } from "../../../api/types/config.js";

/**
 * The shared context object available to all message handlers.
 * It provides access to all the core L3 managers.
 */
export interface HandlerContext<
  U extends EndpointMeta,
  P extends PlatformMeta,
> {
  readonly engine: MessageHandlerCallbacks<U>;
  readonly resourceManager: ResourceManager.Runtime;
  readonly payloadProcessor: PayloadProcessor.Runtime<U, P>;
  policy?: NexusAuthorizationPolicy<U, P>;
  getConnectionAuthContext?: (connectionId: string) =>
    | {
        readonly localIdentity: U;
        readonly remoteIdentity: U;
        readonly platform: P;
      }
    | undefined;
}

/**
 * Defines the signature for a function that handles a specific Nexus message type.
 * @param context The shared handler context.
 * @param message The specific message to handle.
 * @param sourceConnectionId The ID of the connection the message came from.
 */
export type MessageHandlerFn<
  T extends NexusMessage,
  U extends EndpointMeta = EndpointMeta,
  P extends PlatformMeta = PlatformMeta,
> = (
  context: HandlerContext<U, P>,
  message: T,
  sourceConnectionId: string,
) => Promise<void> | void;
