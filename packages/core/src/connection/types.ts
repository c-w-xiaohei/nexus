import type {
  UserMetadata,
  PlatformMetadata,
  ConnectionContext,
} from "../types/identity";
import type { NexusMessage } from "../types/message";

export enum ConnectionStatus {
  INITIALIZING,
  HANDSHAKING,
  CONNECTED,
  CLOSING,
  CLOSED,
}

export type Descriptor<U extends UserMetadata> = Partial<U>;

export type ResolveOptions<
  U extends UserMetadata,
  _P extends PlatformMetadata,
> = {
  matcher?: (identity: U) => boolean;
  descriptor?: Descriptor<U>;
  assignmentMetadata?: U;
};

export type MessageTarget<U extends UserMetadata> =
  | { connectionId: string }
  | { groupName: string }
  | { matcher: (identity: U) => boolean };

/**
 * A union type representing all possible ways to target a remote endpoint for a call.
 * It can be a direct target for sending a message (`MessageTarget`) or options
 * for finding/creating a connection first (`ResolveOptions`).
 */
export type CallTarget<U extends UserMetadata, P extends PlatformMetadata> =
  | MessageTarget<U>
  | ResolveOptions<U, P>;

export interface LogicalConnectionHandlers<
  U extends UserMetadata,
  P extends PlatformMetadata,
> {
  onVerified(connInfo: { connectionId: string; identity: U }): void;
  onClosed(connInfo: { connectionId: string; identity?: U }): void;
  onMessage(message: NexusMessage, connectionId: string): void | Promise<void>;
  onIdentityUpdated(connectionId: string, newIdentity: U, oldIdentity: U): void;
  verify(identity: U, context: ConnectionContext<P>): Promise<boolean>;
}

export type ConnectToTarget<U extends UserMetadata> =
  | { descriptor: Descriptor<U> }
  | { matcher: (identity: U) => boolean; descriptor: Descriptor<U> };

export interface ConnectionManagerConfig<
  U extends UserMetadata,
  _P extends PlatformMetadata,
> {
  connectTo?: ConnectToTarget<U>[];
  // policy: IConnectionPolicy<U, P>;
}

export interface ConnectionManagerHandlers<
  U extends UserMetadata,
  _P extends PlatformMetadata,
> {
  onMessage(
    message: NexusMessage,
    sourceConnectionId: string,
  ): void | Promise<void>;
  onDisconnect(connectionId: string, identity?: U): void;
}
