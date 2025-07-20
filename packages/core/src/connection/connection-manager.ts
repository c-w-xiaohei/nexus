import type { Transport } from "../transport/transport";
import type { PortProcessorHandlers } from "../transport/port-processor";
import type { NexusMessage, IdentityUpdateMessage } from "../types/message";
import { NexusMessageType } from "../types/message";
import type {
  UserMetadata,
  PlatformMetadata,
  ConnectionContext,
} from "../types/identity";
import { LogicalConnection } from "./logical-connection";
import type {
  ConnectionManagerConfig,
  ConnectionManagerHandlers,
  ResolveOptions,
  Descriptor,
  MessageTarget,
} from "./types";
import { Logger } from "@/logger";
import { NexusHandshakeError } from "@/errors";

let nextConnectionId = 1;

/**
 * Creates a deterministic, serializable key from a descriptor object.
 * Used to identify pending connection requests for the same target.
 */
function getDescriptorKey(descriptor: object): string {
  // A simple but effective way to create a consistent key for an object
  // by sorting its keys. This is not foolproof for deeply nested objects
  // but is sufficient for the flat metadata structures in Nexus.
  return JSON.stringify(
    Object.keys(descriptor)
      .sort()
      .reduce((acc, key) => {
        // @ts-expect-error - We are building the object dynamically
        acc[key] = descriptor[key];
        return acc;
      }, {})
  );
}

/**
 * Performs a deep partial match of a source object against a target object.
 * Returns true if all properties in `source` exist and match in `target`.
 */
function isDeepMatch(target: any, source: any): boolean {
  if (target === source) return true;
  if (
    source === null ||
    typeof source !== "object" ||
    target === null ||
    typeof target !== "object"
  ) {
    return target === source;
  }

  for (const key of Object.keys(source)) {
    if (
      !Object.prototype.hasOwnProperty.call(target, key) ||
      !isDeepMatch(target[key], source[key])
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The main entry point and facade for Layer 2 (Connection & Routing).
 * It orchestrates the entire lifecycle of connections, from discovery and
 * handshake to routing and termination. It acts as the single point of contact
 * between Layer 1 (Transport) and Layer 3 (RPC Engine).
 *
 * @todo [RACE_CONDITION_MEDIUM] Handle "crossed" connections. If two endpoints
 * simultaneously try to connect to each other, they might establish two separate
 * connections instead of one. A tie-breaking mechanism (e.g., using a unique
 * instance ID and comparing them) is needed to resolve this and ensure only
 * one connection persists.
 */
export class ConnectionManager<
  U extends UserMetadata & { groups?: string[] },
  P extends PlatformMetadata,
> {
  private readonly logger = new Logger("L2 --- ConnectionManager");
  private readonly connections = new Map<string, LogicalConnection<U, P>>();
  private readonly serviceGroups = new Map<string, Set<string>>();
  private readonly pendingCreations = new Map<
    string,
    Promise<LogicalConnection<U, P>>
  >();

  constructor(
    private readonly config: ConnectionManagerConfig<U, P>,
    private readonly transport: Transport<U, P>,
    private readonly handlers: ConnectionManagerHandlers<U, P>,
    private localUserMetadata: U
  ) {}

  public initialize(): void {
    // Implement `connectTo` logic from config.
    if (Array.isArray(this.config.connectTo)) {
      for (const target of this.config.connectTo) {
        // `resolveConnection` already handles find-or-create and pending states.
        // We "fire and forget" here, letting it run in the background.
        this.logger.info("Initiating pre-warmed connection.", target);
        this.resolveConnection(target).catch((err) => {
          // For pre-warmed connections, we shouldn't block the main flow
          // or throw. Logging the error is the best approach for debugging.
          console.error(
            `Nexus DEV: Failed to establish pre-warmed connection for target:`,
            target,
            err
          );
          this.logger.error(
            "Failed to establish pre-warmed connection.",
            target,
            err
          );
        });
      }
    }

    // Start listening for incoming connections.
    this.transport.listen((createProcessor, platformMetadata) => {
      const connectionId = `conn-${nextConnectionId++}`;
      let connection: LogicalConnection<U, P> | null = null;

      this.logger.info(
        `Accepting incoming connection #${connectionId}`,
        platformMetadata
      );

      const logicalConnectionHandlers = {
        onVerified: (connInfo: { identity: U }) =>
          this.handleConnectionVerified(connection!, connInfo.identity),
        onClosed: (connInfo: { connectionId: string; identity?: U }) =>
          this.handleConnectionClosed(connInfo),
        onMessage: (msg: NexusMessage, id: string) =>
          this.handlers.onMessage(msg, id),
        onIdentityUpdated: (
          connectionId: string,
          newIdentity: U,
          oldIdentity: U
        ) => this.handleIdentityUpdated(connectionId, newIdentity, oldIdentity),
        verify: (identity: U, context: ConnectionContext<P>) =>
          // Promise.resolve(this.config.policy.canConnect(identity, context)),
          Promise.resolve(true), // TODO: Re-enable policy check
      };

      const portProcessor = createProcessor({
        onLogicalMessage: (message: NexusMessage) => {
          connection?.handleMessage(message);
        },
        onDisconnect: () => {
          connection?.handleDisconnect();
        },
      } as PortProcessorHandlers);

      connection = new LogicalConnection<U, P>(
        portProcessor,
        logicalConnectionHandlers,
        {
          connectionId,
          platformMetadata: platformMetadata ?? ({} as P),
          localUserMetadata: this.localUserMetadata,
        }
      );

      this.connections.set(connectionId, connection);
    });
  }

  /**
   * The primary method for acquiring a connection to a remote endpoint.
   * It implements the "Find or Create" logic based on the provided options.
   * @param options The options for resolving the connection.
   * @returns A promise that resolves to a LogicalConnection, or null if not found.
   */
  public async resolveConnection(
    options: ResolveOptions<U, P>
  ): Promise<LogicalConnection<U, P> | null> {
    // --- 1. Find Phase ---
    const { matcher, descriptor } = options;
    this.logger.debug("Attempting to resolve connection.", options);

    for (const conn of this.connections.values()) {
      if (!conn.isReady() || !conn.remoteIdentity) continue;

      if (matcher) {
        if (matcher(conn.remoteIdentity)) {
          return conn; // Found by matcher
        }
      } else if (descriptor) {
        if (isDeepMatch(conn.remoteIdentity, descriptor)) {
          return conn; // Found by descriptor match
        }
      }
    }

    // If a matcher was provided but no connection was found, do not create.
    if (matcher && !descriptor) {
      return null;
    }

    // --- 2. Create Phase ---
    if (descriptor) {
      // TODO: [RACE_CONDITION_HIGH] There is a race condition here.
      // 1. Code checks for an existing connection in the "Find Phase" above and finds none.
      // 2. An incoming connection from the target is established *after* the check but *before* a new one is created below.
      // 3. This code proceeds to the "Create Phase" and creates a redundant, second connection.
      // To fix, the check for existence and the "pending" placeholder creation
      // need to be a more atomic operation.
      const key = getDescriptorKey(descriptor);
      if (this.pendingCreations.has(key)) {
        this.logger.debug(
          "Connection creation already pending for descriptor, returning existing promise.",
          descriptor
        );
        return this.pendingCreations.get(key)!;
      }

      this.logger.debug(
        "No existing connection found. Proceeding to create phase.",
        descriptor
      );
      const newConnectionPromise = this.createConnectionFromDescriptor(
        descriptor,
        options.assignmentMetadata
      );
      this.pendingCreations.set(key, newConnectionPromise);

      // Clean up the map once the promise is settled.
      newConnectionPromise.finally(() => {
        this.pendingCreations.delete(key);
      });

      return newConnectionPromise;
    }

    return null; // No target specified, and no default connection configured.
  }

  /**
   * Routes a message to one or more connections based on the target specifier.
   * This is the primary entry point for Layer 3 to send messages.
   * @param target The specifier for the destination (a single connection, a group, or an ad-hoc matcher).
   * @param message The NexusMessage to send.
   * @returns The number of connections the message was sent to.
   */
  public sendMessage(
    target: MessageTarget<U>,
    message: NexusMessage
  ): string[] {
    const sentConnectionIds: string[] = [];
    this.logger.debug(
      `Routing message #${message.id ?? "N/A"} to target:`,
      target
    );
    if ("connectionId" in target) {
      // 1. Unicast to a specific connection
      const conn = this.connections.get(target.connectionId);
      if (conn?.isReady()) {
        conn.sendMessage(message);
        sentConnectionIds.push(target.connectionId);
      }
    } else if ("groupName" in target) {
      // 2. Multicast to a pre-defined service group
      const groupMembers = this.serviceGroups.get(target.groupName);
      if (!groupMembers) return [];

      for (const connId of groupMembers) {
        const conn = this.connections.get(connId);
        if (conn?.isReady()) {
          conn.sendMessage(message);
          sentConnectionIds.push(connId);
        }
      }
    } else if ("matcher" in target) {
      // 3. Broadcast to all connections matching the predicate
      for (const conn of this.connections.values()) {
        if (
          conn.isReady() &&
          conn.remoteIdentity &&
          target.matcher(conn.remoteIdentity)
        ) {
          conn.sendMessage(message);
          sentConnectionIds.push(conn.connectionId);
        }
      }
    }
    return sentConnectionIds;
  }

  /**
   * Updates the local endpoint's metadata and broadcasts the changes to all
   * connected peers.
   * @param updates A partial object of the user metadata to update.
   */
  public updateLocalIdentity(updates: Partial<U>): void {
    this.logger.info("Updating local identity and broadcasting.", updates);
    // 1. Update local state immediately for future handshakes.
    // A shallow merge is sufficient here.
    this.localUserMetadata = { ...this.localUserMetadata, ...updates };

    // 2. Create the notification message.
    const message: IdentityUpdateMessage = {
      type: NexusMessageType.IDENTITY_UPDATE,
      id: null,
      updates,
    };

    // 3. Broadcast to all currently connected and ready peers.
    for (const conn of this.connections.values()) {
      if (conn.isReady()) {
        conn.sendMessage(message);
      }
    }
  }

  private async createConnectionFromDescriptor(
    descriptor: Descriptor<U>,
    assignmentMetadata?: U
  ): Promise<LogicalConnection<U, P>> {
    const connectionId = `conn-${nextConnectionId++}`;
    this.logger.info(`Creating new outgoing connection #${connectionId}`);
    // The connection object is declared here so it can be captured in closures.
    let connection: LogicalConnection<U, P>;

    // This promise specifically waits for the HANDSHAKE to complete or fail.
    const handshakePromise = new Promise<LogicalConnection<U, P>>(
      (resolve, reject) => {
        const logicalConnectionHandlers = {
          onVerified: (connInfo: { identity: U }) => {
            this.handleConnectionVerified(connection, connInfo.identity);
            resolve(connection);
          },
          onClosed: (connInfo: { connectionId: string; identity?: U }) => {
            this.handleConnectionClosed(connInfo);
            // Only reject if the connection was never verified.
            if (!connInfo.identity) {
              reject(
                new NexusHandshakeError(
                  `Connection ${connInfo.connectionId} failed to establish. The remote endpoint may have rejected the connection or is unavailable.`,
                  "E_HANDSHAKE_FAILED",
                  { connectionId: connInfo.connectionId }
                )
              );
            }
          },
          onMessage: (msg: NexusMessage, id: string) =>
            this.handlers.onMessage(msg, id),
          onIdentityUpdated: (
            connectionId: string,
            newIdentity: U,
            oldIdentity: U
          ) =>
            this.handleIdentityUpdated(connectionId, newIdentity, oldIdentity),
          verify: (identity: U, context: ConnectionContext<P>) =>
            // Promise.resolve(this.config.policy.canConnect(identity, context)),
            Promise.resolve(true), // TODO: Re-enable policy check
        };

        const portProcessorHandlers: PortProcessorHandlers = {
          onLogicalMessage: (message: NexusMessage) => {
            // By the time a message can be received, `connection` is assigned.
            connection.handleMessage(message);
          },
          onDisconnect: () => {
            // By the time a disconnect can happen, `connection` is assigned.
            connection.handleDisconnect();
          },
        };

        // We wrap the connection attempt in an IIFE to handle async errors
        // and link them to the promise's rejection.
        (async () => {
          try {
            const [portProcessor, platformMetadata] =
              await this.transport.connect(descriptor, portProcessorHandlers);

            connection = new LogicalConnection(
              portProcessor,
              logicalConnectionHandlers,
              {
                connectionId,
                platformMetadata,
                localUserMetadata: this.localUserMetadata,
              }
            );

            this.connections.set(connectionId, connection);
            connection.initiateHandshake(
              this.localUserMetadata,
              assignmentMetadata
            );
          } catch (err) {
            // If transport.connect fails, we reject the handshake promise.
            reject(err);
          }
        })();
      }
    );

    return handshakePromise;
  }

  // ===========================================================================
  // Handlers for LogicalConnection Events
  // ===========================================================================

  private handleConnectionVerified(
    connection: LogicalConnection<U, P>,
    identity: U
  ): void {
    const { connectionId } = connection;
    this.logger.info(
      `Connection #${connectionId} verified. Remote identity:`,
      identity
    );

    // Add to service groups if specified
    const groups = identity.groups;
    if (Array.isArray(groups)) {
      for (const groupName of groups) {
        if (!this.serviceGroups.has(groupName)) {
          this.serviceGroups.set(groupName, new Set());
        }
        this.serviceGroups.get(groupName)!.add(connectionId);
      }
    }

    // The promise resolution is now handled by the callback that calls this.
    // The old `pendingConnections` logic is no longer needed here.
  }

  private handleConnectionClosed(connectionInfo: {
    connectionId: string;
    identity?: U;
  }): void {
    const { connectionId, identity } = connectionInfo;
    this.logger.info(`Connection #${connectionId} closed.`, { identity });

    // The promise rejection is now handled by the callback that calls this.
    // The old `pendingConnections` logic is no longer needed here.

    // Remove from all service groups
    if (identity) {
      this.updateServiceGroups(connectionId, identity, null);
    }

    // Remove from the main connection pool
    this.connections.delete(connectionId);

    // Notify Layer 3
    this.handlers.onDisconnect(connectionId, identity);
  }

  private handleIdentityUpdated(
    connectionId: string,
    newIdentity: U,
    oldIdentity: U
  ): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    this.logger.debug(
      `Remote identity for #${connectionId} updated.`,
      newIdentity
    );

    // The LogicalConnection has already updated its own remoteIdentity.
    // We just need to update the service groups based on the identity change.
    this.updateServiceGroups(connectionId, oldIdentity, newIdentity);
  }

  /** Helper to diff group memberships and update the serviceGroups map. */
  private updateServiceGroups(
    connectionId: string,
    oldIdentity: U | null,
    newIdentity: U | null
  ) {
    const oldGroups = oldIdentity?.groups ?? [];
    const newGroups = newIdentity?.groups ?? [];

    const added = newGroups.filter((g) => !oldGroups.includes(g));
    const removed = oldGroups.filter((g) => !newGroups.includes(g));

    for (const groupName of removed) {
      this.serviceGroups.get(groupName)?.delete(connectionId);
    }
    for (const groupName of added) {
      if (!this.serviceGroups.has(groupName)) {
        this.serviceGroups.set(groupName, new Set());
      }
      this.serviceGroups.get(groupName)!.add(connectionId);
    }
  }
}
