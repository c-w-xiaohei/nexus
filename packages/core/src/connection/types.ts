import type {
  AdapterModel,
  ConnectionTargetOf,
  ConnectionWhere,
  ConnectionMetaOf,
  ContextMetaOf,
} from "../types/adapter-model";
import type { ConnectionContext } from "../types/identity";
import type { NexusMessage } from "../types/message";
import type { NexusAuthorizationPolicy } from "../api/types/config";

export enum ConnectionStatus {
  INITIALIZING,
  HANDSHAKING,
  CONNECTED,
  CLOSING,
  CLOSED,
}

export type ResolveOptions<M extends AdapterModel> = {
  target?: ConnectionTargetOf<M>;
  where?: ConnectionWhere<M>;
  assignmentMetadata?: ContextMetaOf<M>;
};

export type MessageTarget<M extends AdapterModel> =
  | { connectionId: string }
  | { connectionIds: readonly string[] }
  | { group: string }
  | {
      where: ConnectionWhere<M>;
    };

export type CallTarget<M extends AdapterModel> = MessageTarget<M>;

export interface LogicalConnectionHandlers<M extends AdapterModel> {
  onVerified(connInfo: {
    connectionId: string;
    identity: ContextMetaOf<M>;
  }): void;
  onClosed(connInfo: {
    connectionId: string;
    identity?: ContextMetaOf<M>;
  }): void;
  onMessage(message: NexusMessage, connectionId: string): void | Promise<void>;
  onIdentityUpdated(
    connectionId: string,
    newIdentity: ContextMetaOf<M>,
    oldIdentity: ContextMetaOf<M>,
    connectionMeta: ConnectionMetaOf<M>,
  ): void;
  onProviderCatalogUpdated?(
    connectionId: string,
    providers: readonly string[],
  ): void;
  verify(
    identity: ContextMetaOf<M>,
    context: ConnectionContext<ConnectionMetaOf<M>>,
  ): Promise<boolean>;
}

export interface ConnectionManagerConfig<M extends AdapterModel> {
  /** Internal test topology seed; ConnectionManager never consumes or prewarms it. */
  connectTo?: readonly ConnectionTargetOf<M>[];
  policy?: NexusAuthorizationPolicy<M>;
  handshakeTimeoutMs?: number;
}

export interface ConnectionManagerHandlers<M extends AdapterModel> {
  onMessage(
    message: NexusMessage,
    sourceConnectionId: string,
  ): void | Promise<void>;
  onDisconnect(connectionId: string, identity?: ContextMetaOf<M>): void;
  onIdentityUpdated?(
    connectionId: string,
    newIdentity: ContextMetaOf<M>,
    oldIdentity: ContextMetaOf<M>,
    connectionMeta: ConnectionMetaOf<M>,
  ): void;
}
