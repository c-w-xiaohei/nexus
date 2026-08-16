import type { NexusMessage } from "@/types/message";
import type {
  AdapterModel,
  ConnectionMetaOf,
  ContextMetaOf,
} from "@/types/adapter-model";
import type { MessageHandlerCallbacks } from "../../engine";
import type { PayloadProcessor } from "../../payload/payload-processor";
import type { ResourceManager } from "../../resource-manager";
import type { NexusAuthorizationPolicy } from "@/api/types/config";

/**
 * The shared context object available to all message handlers.
 * It provides access to all the core L3 managers.
 */
export interface HandlerContext<M extends AdapterModel> {
  readonly engine: MessageHandlerCallbacks<M>;
  readonly resourceManager: ResourceManager.Runtime;
  readonly payloadProcessor: PayloadProcessor.Runtime<M>;
  policy?: NexusAuthorizationPolicy<M>;
  getConnectionAuthContext?: (connectionId: string) =>
    | {
        readonly localIdentity: ContextMetaOf<M>;
        readonly remoteIdentity: ContextMetaOf<M>;
        readonly connection: ConnectionMetaOf<M>;
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
  M extends AdapterModel = AdapterModel,
> = (
  context: HandlerContext<M>,
  message: T,
  sourceConnectionId: string,
) => Promise<void> | void;
