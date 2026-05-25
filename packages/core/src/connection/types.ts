import type {
  EndpointMeta,
  PlatformMeta,
  ConnectionContext,
} from "../types/identity";
import type { NexusMessage } from "../types/message";
import type { NexusAuthorizationPolicy } from "../api/types/config";

export enum ConnectionStatus {
  INITIALIZING,
  HANDSHAKING,
  CONNECTED,
  CLOSING,
  CLOSED,
}

export type Descriptor<U extends EndpointMeta> = Partial<U>;

export type ResolveOptions<
  U extends EndpointMeta,
  _P extends PlatformMeta,
> = {
  matcher?: (identity: U) => boolean;
  descriptor?: Descriptor<U>;
  assignmentMetadata?: U;
};

export type MessageTarget<U extends EndpointMeta> =
  | { connectionId: string }
  | { group: string }
  | { matcher: (identity: U) => boolean };

/**
 * A union type representing all possible ways to target a remote endpoint for a call.
 * It can be a direct target for sending a message (`MessageTarget`) or options
 * for finding/creating a connection first (`ResolveOptions`).
 */
export type CallTarget<U extends EndpointMeta, P extends PlatformMeta> =
  | MessageTarget<U>
  | ResolveOptions<U, P>;

export interface LogicalConnectionHandlers<
  U extends EndpointMeta,
  P extends PlatformMeta,
> {
  onVerified(connInfo: { connectionId: string; identity: U }): void;
  onClosed(connInfo: { connectionId: string; identity?: U }): void;
  onMessage(message: NexusMessage, connectionId: string): void | Promise<void>;
  onIdentityUpdated(connectionId: string, newIdentity: U, oldIdentity: U): void;
  verify(identity: U, context: ConnectionContext<P>): Promise<boolean>;
}

export type ConnectToTarget<U extends EndpointMeta> =
  | { descriptor: Descriptor<U> }
  | { matcher: (identity: U) => boolean; descriptor: Descriptor<U> };

export interface ConnectionManagerConfig<
  U extends EndpointMeta,
  P extends PlatformMeta,
> {
  connectTo?: ConnectToTarget<U>[];
  policy?: NexusAuthorizationPolicy<U, P>;
  handshakeTimeoutMs?: number;
}

export interface ConnectionManagerHandlers<
  U extends EndpointMeta,
  _P extends PlatformMeta,
> {
  onMessage(
    message: NexusMessage,
    sourceConnectionId: string,
  ): void | Promise<void>;
  onDisconnect(connectionId: string, identity?: U): void;
  onIdentityUpdated?(
    connectionId: string,
    newIdentity: U,
    oldIdentity: U,
  ): void;
}
