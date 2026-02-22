import type { NexusMessage } from "../../types/message";

/**
 * Configuration for the ConnectionManager.
 */
export interface ConnectionManagerConfig<U extends object, P extends object> {
  /** The security policy for incoming connections. */
  // policy: IAuthorizationPolicy<U, P>;
  /** A list of targets to connect to upon initialization. */
  connectTo?: ResolveOptions<U, P>[];
}

/**
 * Handlers provided by Layer 3 (RPC Engine) to the ConnectionManager
 * to process messages and lifecycle events.
 */
export interface ConnectionManagerHandlers<
  U extends object,
  _P extends object,
> {
  /**
   * Forwards a fully-formed message from a connection to Layer 3.
   * @param message The message to be processed by the RPC engine.
   * @param connectionId The ID of the connection from which the message originated.
   */
  onMessage: (
    message: NexusMessage,
    connectionId: string,
  ) => void | Promise<void>;

  /**
   * Notifies Layer 3 that a connection has been closed.
   * @param connectionId The ID of the closed connection.
   * @param identity The identity of the remote endpoint, if known.
   */
  onDisconnect: (connectionId: string, identity?: U) => void;
}

/**
 * Options for resolving a connection via `connectionManager.resolveConnection`.
 */
export interface ResolveOptions<U extends object, _P extends object> {
  /**
   * A predicate function to find an existing connection.
   * If provided without a descriptor, resolution will be find-only.
   */
  matcher?: (identity: U) => boolean;
  /**
   * A blueprint for creating a new connection if one is not found.
   */
  descriptor?: Partial<U>;
  /**
   * Metadata to be assigned to the remote endpoint upon connection.
   * This is used for "christening" child contexts like Workers or iframes.
   */
  assignmentMetadata?: U;
}
