import type { NexusMessage } from "../../types/message";
import type { ConnectionContext } from "../../types/identity";

/**
 * Represents the status of a logical connection.
 */
export enum ConnectionStatus {
  /** The connection object is created but the handshake has not started. */
  INITIALIZING,
  /** Handshake is in progress. */
  HANDSHAKING,
  /** Handshake is complete, and the connection is verified and active. */
  CONNECTED,
  /** The connection is in the process of being closed. */
  CLOSING,
  /** The connection is fully closed and resources are released. */
  CLOSED,
}

/**
 * A serializable object that provides the necessary information for an
 * IEndpoint to establish a new connection. It is a partial representation
 * of the target's UserMetadata.
 * e.g., `{ context: 'background' }`
 */
export type Descriptor<U extends object> = Partial<U>;

/**
 * A predicate function used to find a connection among existing ones based on
 * its identity.
 * e.g., `(identity) => identity.context === 'content-script'`
 */
export type Matcher<U extends object> = (identity: U) => boolean;

/**
 * A specifier for the destination of a message sent via the ConnectionManager.
 */
export type MessageTarget<U extends object> =
  | { readonly connectionId: string }
  | { readonly groupName: string }
  | { readonly matcher: Matcher<U> };

/**
 * Callbacks provided by the ConnectionManager to a LogicalConnection instance
 * so it can report its lifecycle events back to its owner.
 *
 * These handlers form the upward communication path from a connection to the manager.
 */
export interface LogicalConnectionHandlers<U extends object, P extends object> {
  /**
   * Called when the connection's identity has been successfully verified.
   * @param info An object containing the connectionId and the verified identity.
   */
  onVerified: (info: { connectionId: string; identity: U }) => void;

  /**
   * Called when the connection is permanently closed, either gracefully or due
   * to an error.
   * @param info An object containing the connectionId and the remote identity
   *             if the connection was fully established before closing.
   */
  onClosed: (info: { connectionId: string; identity?: U }) => void;

  /**
   * Called when a business logic message (non-handshake) is received.
   * @param message The `NexusMessage` received from the remote endpoint.
   * @param connectionId The ID of the connection that received the message.
   */
  onMessage: (
    message: NexusMessage,
    connectionId: string,
  ) => void | Promise<void>;

  /**
   * Called when a connected peer updates its identity metadata.
   * This allows the manager to react to changes, like group membership updates.
   * @param connectionId The ID of the connection whose identity was updated.
   * @param newIdentity The complete, new identity of the remote peer.
   * @param oldIdentity The complete identity of the remote peer before the update.
   */
  onIdentityUpdated?: (
    connectionId: string,
    newIdentity: U,
    oldIdentity: U,
  ) => void;

  /**
   * A function provided by the manager for the connection to call to verify
   * the remote identity against the security policy.
   * @param identity The remote identity to verify.
   * @param context The connection context of the remote endpoint.
   * @returns A promise that resolves to `true` if the connection is allowed.
   */
  verify: (identity: U, context: ConnectionContext<P>) => Promise<boolean>;
}

export type {
  ConnectionManagerConfig,
  ConnectionManagerHandlers,
  ResolveOptions,
} from "./manager";
