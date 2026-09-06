import { Result } from "better-result";
import { Logger } from "@/logger";
import { NexusError } from "../errors/nexus-error";
import {
  NexusConnectionConstraintFailedError,
  NexusConnectionError,
  NexusHandshakeError,
} from "../errors/connection-errors";
import { NexusUsageError } from "../errors/usage-errors";
import { Transport } from "../transport/transport";
import type {
  AdapterModel,
  ConnectionTargetOf,
  ContextMetaOf,
  ConnectionMetaOf,
} from "../types/adapter-model";
import { NexusMessageType, type NexusMessage } from "../types/message";
import { toSerializedError } from "../utils/error";
import {
  LogicalConnection,
  type ConnectionOpenOptions,
} from "./logical-connection";
import type {
  ConnectionManagerConfig,
  ConnectionManagerHandlers,
  LogicalConnectionHandlers,
  MessageTarget,
  ResolveOptions,
} from "./types";

const { ok, err } = Result;

/**
 * Own the cross-session view: attachment, publication, target acquisition and
 * routing. LogicalConnection owns each peer's protocol, deadline and disposal.
 * Queries and sends only see published sessions; catalog announcements also
 * reach handshaking sessions. No query or send performs provider discovery.
 */
export class ConnectionManager<M extends AdapterModel> {
  private readonly logger = new Logger("L2 --- ConnectionManager");
  private readonly sessionsMap = new Map<string, LogicalConnection<M>>();
  // Protocol readiness precedes manager publication, so this is a separate index,
  // not a filtered view of sessionsMap. Map order is publication order.
  private readonly connectionsMap = new Map<string, LogicalConnection<M>>();
  private readonly serviceGroupsMap = new Map<string, Set<string>>();
  private readonly pendingCreations = new Map<
    string,
    Promise<Result<LogicalConnection<M>, NexusError>>
  >();
  private readonly localProviders = new Set<string>();
  private readonly availabilityListeners = new Set<() => void>();
  private nextConnectionOrdinal = 1;
  private nextMessageOrdinal = 1;
  private initialized = false;
  private initialization: Promise<Result<void, NexusError>> | undefined;

  /** Construct without listening or dialing. Call safeInitialize before demand operations. */
  constructor(
    private readonly config: ConnectionManagerConfig<M>,
    private readonly transport: Transport.Context<M>,
    private readonly handlers: ConnectionManagerHandlers<M>,
    private localEndpointMeta: ContextMetaOf<M>,
  ) {}

  // ===== Published Session Queries =====

  /** Detached map of published sessions; contained connection objects remain live. */
  public get connections(): ReadonlyMap<string, LogicalConnection<M>> {
    return new Map(this.connectionsMap);
  }

  /** Detached membership snapshot; mutating it cannot change routing indexes. */
  public get serviceGroups(): ReadonlyMap<string, ReadonlySet<string>> {
    return new Map(
      Array.from(this.serviceGroupsMap, ([group, ids]) => [
        group,
        new Set(ids),
      ]),
    );
  }

  /** Select advertised providers without discovering or connecting. */
  public getReadyProviderConnectionIds(provider: string): readonly string[] {
    return this.getReadyProviderConnections(provider).map(
      (connection) => connection.connectionId,
    );
  }

  /** Apply where to authorized identity and local adapter facts, then match the catalog. */
  public getReadyProviderConnections(
    provider: string,
    where?: ResolveOptions<M>["where"],
  ): readonly LogicalConnection<M>[] {
    return this.findReadyConnections(where).filter((connection) =>
      connection.hasProvider(provider),
    );
  }

  /** Match the adapter target before applying where; never dial. */
  public getReadyTargetConnections(
    target: ConnectionTargetOf<M>,
    where?: ResolveOptions<M>["where"],
  ): readonly LogicalConnection<M>[] {
    const matchesTarget = this.transport.endpoint.matchesTarget;
    if (!matchesTarget) return [];
    const candidates = this.findReadyConnections((identity, meta) =>
      matchesTarget(target, identity, meta),
    );
    return candidates.filter((connection) => matchesWhere(connection, where));
  }

  /** Authorization inputs only exist after publication, and disappear before onDisconnect. */
  public getConnectionAuthSnapshot(connectionId: string):
    | {
        readonly localIdentity: ContextMetaOf<M>;
        readonly remoteIdentity: ContextMetaOf<M>;
        readonly connection: ConnectionMetaOf<M>;
      }
    | undefined {
    const connection = this.connectionsMap.get(connectionId);
    if (!connection?.remoteIdentity) return undefined;
    return {
      localIdentity: connection.localIdentity,
      remoteIdentity: connection.remoteIdentity,
      connection: connection.context.connection,
    };
  }

  /** Observe index/catalog changes; the returned function unsubscribes this listener. */
  public subscribeAvailabilityChanged(listener: () => void): () => void {
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  private findReadyConnections(
    where?: ResolveOptions<M>["where"],
  ): LogicalConnection<M>[] {
    const matches: LogicalConnection<M>[] = [];
    for (const connection of this.connectionsMap.values()) {
      // Native close may reenter queries before onClosed removes the index entry.
      if (connection.isReady() && matchesWhere(connection, where))
        matches.push(connection);
    }
    return matches;
  }

  // ===== Initialization And Acquisition =====

  /**
   * Start listening once. Reserve shared startup before entering the adapter;
   * the initiating call awaits and settles it, including unexpected rejection.
   * Concurrent callers share the outcome, not necessarily the Promise object.
   * Only failure releases startup so a later call can retry.
   */
  public async safeInitialize(): Promise<Result<void, NexusError>> {
    if (this.initialization) return this.initialization;
    // Reserve before calling listen, which may synchronously call back into us.
    let settle!: (result: Result<void, NexusError>) => void;
    this.initialization = new Promise((resolve) => {
      settle = resolve;
    });
    const attempt = await Result.tryPromise({
      try: () =>
        Transport.safeListen(
          this.transport,
          (createProcessor, connectionMeta) => {
            // Accepted ports attach synchronously, but their handshakes are independent
            // of listener startup. A bad peer must not fail the listener.
            void this.openConnection("incoming", (handlers) =>
              ok({
                portProcessor: createProcessor(handlers),
                connectionMeta,
              }),
            ).then((result) => {
              if (result.isErr())
                this.logger.debug(
                  "Incoming session failed to open",
                  result.error,
                );
            });
          },
        ),
      catch: (error) =>
        connectionError(error, "Failed to start connection manager listener"),
    });
    const result = attempt.andThen((listened) => listened);
    this.initialized = result.isOk();
    if (result.isErr()) this.initialization = undefined;
    settle(result);
    return result;
  }

  /** Acquire the first target match, or null without a target. Requires initialization. */
  public async safeResolveConnection(
    options: ResolveOptions<M>,
  ): Promise<Result<LogicalConnection<M> | null, NexusError>> {
    if (!options.target)
      return this.ensureInitialized("safeResolveConnection").map(() => null);
    return (await this.safeResolveConnections(options)).map(
      (connections) => connections[0] ?? null,
    );
  }

  /**
   * Reuse published target matches, or share one in-flight dial for a missing
   * target. Apply where only after choosing candidates: a constraint miss is not
   * permission to redial. Without a target, select existing sessions only.
   * Dial failures release the coalescing slot; they are never cached for retry.
   */
  public async safeResolveConnections(
    options: ResolveOptions<M>,
  ): Promise<Result<readonly LogicalConnection<M>[], NexusError>> {
    const initialized = this.ensureInitialized("safeResolveConnections");
    if (initialized.isErr()) return initialized;
    try {
      const { target, where, assignmentMetadata } = options;
      if (!target) return ok(this.findReadyConnections(where));
      let candidates = this.getReadyTargetConnections(target);
      const reused = candidates.length > 0;
      if (!reused) {
        const key =
          this.transport.endpoint.targetKey?.(target) ?? getTargetKey(target);
        let pending = this.pendingCreations.get(key);
        if (!pending) {
          // Reserve before entering the adapter: connect may synchronously reenter
          // acquisition. The session still starts immediately, not in a microtask.
          let settle!: (
            result: Result<LogicalConnection<M>, NexusError>,
          ) => void;
          pending = new Promise((resolve) => {
            settle = resolve;
          });
          this.pendingCreations.set(key, pending);
          const connected = await this.openConnection(
            "outgoing",
            (handlers) =>
              Transport.safeConnect(this.transport, target, handlers),
            assignmentMetadata,
          );
          // The initiating caller owns completion; joiners only await its result.
          this.pendingCreations.delete(key);
          settle(connected);
        }
        const connected = await pending;
        if (connected.isErr()) return connected;
        candidates = [connected.value];
      }
      const accepted = candidates.filter((connection) =>
        matchesWhere(connection, where),
      );
      return accepted.length > 0
        ? ok(accepted)
        : err(
            new NexusConnectionConstraintFailedError(
              reused
                ? "A ready connection matched the target but failed its constraint."
                : "The newly connected target failed its constraint.",
              { target },
            ),
          );
    } catch (error) {
      return err(
        connectionError(error, "Failed to resolve connections", { options }),
      );
    }
  }

  private ensureInitialized(operation: string): Result<void, NexusError> {
    return this.initialized
      ? ok(undefined)
      : err(
          new NexusUsageError(
            "ConnectionManager is not initialized. Call safeInitialize() first.",
            "E_USAGE_INVALID",
            { context: { operation } },
          ),
        );
  }

  // ===== Routing And Local Updates =====

  /** Snapshot recipients before registering RPC pending state; never send or dial. */
  public safeGetReadyConnectionIds(
    target: MessageTarget<M>,
  ): Result<string[], NexusError> {
    return this.ensureInitialized("safeGetReadyConnectionIds").andThen(() =>
      Result.try({
        try: () =>
          Array.from(
            this.readyRecipients(target),
            (connection) => connection.connectionId,
          ),
        catch: (error) =>
          connectionError(error, "Failed to select ready connections", {
            target,
          }),
      }),
    );
  }

  /**
   * Send in recipient order, preserving explicit duplicate IDs. Stop at the first
   * failure without rolling back earlier sends. Success means local acceptance,
   * not remote delivery; no recipient is connected implicitly.
   */
  public safeSendMessage(
    target: MessageTarget<M>,
    message: NexusMessage,
  ): Result<string[], NexusError> {
    const initialized = this.ensureInitialized("safeSendMessage");
    if (initialized.isErr()) return initialized;
    try {
      const sentIds: string[] = [];
      for (const connection of this.readyRecipients(target)) {
        const sent = connection.sendMessage(message);
        if (sent.isErr()) {
          // Conn closes before returning Err; only routing context belongs here.
          return err(
            new NexusConnectionError(
              `Failed to send message #${message.id ?? "N/A"} to connection ${connection.connectionId}`,
              "E_CONN_CLOSED",
              {
                connectionId: connection.connectionId,
                messageType: message.type,
                messageId: message.id,
              },
              toSerializedError(sent.error),
            ),
          );
        }
        sentIds.push(connection.connectionId);
      }
      return ok(sentIds);
    } catch (error) {
      return err(
        connectionError(
          error,
          `Failed to route message #${message.id ?? "N/A"}`,
          {
            target,
            messageType: message.type,
            messageId: message.id,
          },
        ),
      );
    }
  }

  private *readyRecipients(
    target: MessageTarget<M>,
  ): Generator<LogicalConnection<M>> {
    let ids: Iterable<string>;
    if ("connectionId" in target) ids = [target.connectionId];
    else if ("connectionIds" in target) ids = target.connectionIds;
    else if ("group" in target)
      ids = this.serviceGroupsMap.get(target.group) ?? [];
    else {
      for (const connection of this.connectionsMap.values()) {
        if (connection.isReady() && matchesWhere(connection, target.where))
          yield connection;
      }
      return;
    }
    // A previous send can synchronously close a later recipient. Do not replace
    // this traversal with a prefiltered snapshot or deduplicated ID set.
    for (const id of ids) {
      const connection = this.connectionsMap.get(id);
      if (connection?.isReady()) yield connection;
    }
  }

  /** Announce providers to all attached peers, even during handshake; peer failures do not roll back registration. */
  public safePublishProviders(
    providers: readonly string[],
  ): Result<void, Error> {
    for (const provider of providers) this.localProviders.add(provider);
    for (const connection of this.sessionsMap.values()) {
      // A failed peer closes itself; registration still succeeds for other peers.
      connection.publishProviders(providers).unwrapOr(undefined);
    }
    this.notifyAvailabilityChanged();
    return ok(undefined);
  }

  /** Update every published local identity before broadcasting. Partial sends are not rolled back. */
  public safeUpdateLocalIdentity(
    updates: Partial<ContextMetaOf<M>>,
  ): Result<void, NexusError> {
    const initialized = this.ensureInitialized("safeUpdateLocalIdentity");
    if (initialized.isErr()) return initialized;
    try {
      this.localEndpointMeta = { ...this.localEndpointMeta, ...updates };
      for (const connection of this.connectionsMap.values())
        connection.updateLocalIdentity(updates);
      // Separate passes are intentional: transport sends can synchronously reenter policy.
      for (const connection of this.connectionsMap.values()) {
        if (!connection.isReady()) continue;
        const sent = connection.sendMessage({
          type: NexusMessageType.IDENTITY_UPDATE,
          id: null,
          updates,
        });
        if (sent.isErr())
          return err(
            connectionError(
              sent.error,
              `Failed to broadcast identity update to ${connection.connectionId}`,
            ),
          );
      }
      return ok(undefined);
    } catch (error) {
      return err(
        connectionError(error, "Failed to update local identity", { updates }),
      );
    }
  }

  // ===== Session Integration =====

  /** Supply per-attempt inputs; shared owner callbacks maintain the session indexes. */
  private async openConnection(
    direction: "incoming" | "outgoing",
    acquire: ConnectionOpenOptions<M>["acquire"],
    assignmentMetadata?: ContextMetaOf<M>,
  ): Promise<Result<LogicalConnection<M>, NexusError>> {
    const connectionId = `conn-${this.nextConnectionOrdinal++}`;
    const attempt = await Result.tryPromise({
      try: () =>
        LogicalConnection.open(
          {
            connectionId,
            direction,
            acquire,
            assignmentMetadata,
            localIdentity: () => this.localEndpointMeta,
            localProviders: () => Array.from(this.localProviders),
            nextMessageId: () => this.nextMessageOrdinal++,
            timeoutMs: this.config.handshakeTimeoutMs ?? 30_000,
          },
          this.sessionHandlers,
        ),
      catch: (error) => error,
    });
    return attempt
      .andThen((opened) => opened)
      .mapError((error) =>
        connectionError(
          error,
          `Failed to establish connection ${connectionId}`,
          { connectionId },
        ),
      );
  }

  // One owner interface serves every session. Conn supplies its own transition
  // data; these callbacks maintain only collection indexes and upstream observers.
  private readonly sessionHandlers: LogicalConnectionHandlers<M> = {
    authorize: (context) => {
      const canConnect = this.config.policy?.canConnect;
      return canConnect ? canConnect(context) : true;
    },
    onAttached: (connection) => {
      this.sessionsMap.set(connection.connectionId, connection);
      return ok(undefined);
    },
    onReady: (connection, identity) => {
      this.updateGroups(connection.connectionId, null, identity);
      this.connectionsMap.set(connection.connectionId, connection);
      this.notifyAvailabilityChanged();
      return ok(undefined);
    },
    onClosed: (connection, identity) => {
      const id = connection.connectionId;
      // Read publication from our own index, not the protocol-ready close identity.
      if (this.connectionsMap.delete(id)) this.updateGroups(id, identity, null);
      this.sessionsMap.delete(id);
      this.notifyAvailabilityChanged();
      this.handlers.onDisconnect(id, identity);
    },
    onIdentityUpdated: (connection, next, previous) => {
      const id = connection.connectionId;
      if (!this.connectionsMap.has(id)) return;
      this.updateGroups(id, previous, next);
      try {
        this.handlers.onIdentityUpdated?.(
          id,
          next,
          previous,
          connection.context.connection,
        );
      } finally {
        this.notifyAvailabilityChanged();
      }
    },
    onMessage: (connection, message) =>
      this.handlers.onMessage(message, connection.connectionId),
    onProviderCatalogUpdated: (connection) => {
      if (this.connectionsMap.has(connection.connectionId))
        this.notifyAvailabilityChanged();
    },
  };

  private updateGroups(
    connectionId: string,
    previous: (object & { groups?: string[] }) | null | undefined,
    next: (object & { groups?: string[] }) | null,
  ): void {
    const oldGroups = previous?.groups ?? [];
    const newGroups = next?.groups ?? [];
    // Keep unchanged memberships in place to preserve group routing order.
    for (const group of oldGroups) {
      if (!newGroups.includes(group))
        this.serviceGroupsMap.get(group)?.delete(connectionId);
    }
    for (const group of newGroups) {
      if (oldGroups.includes(group)) continue;
      let members = this.serviceGroupsMap.get(group);
      if (!members) this.serviceGroupsMap.set(group, (members = new Set()));
      members.add(connectionId);
    }
  }

  private notifyAvailabilityChanged(): void {
    // Observer errors must not interrupt publication or startup settlement.
    for (const listener of this.availabilityListeners) {
      Result.try({ try: listener, catch: (error) => error }).match({
        ok: () => undefined,
        err: (error) =>
          this.logger.error("Availability observer failed", error),
      });
    }
  }
}

function matchesWhere<M extends AdapterModel>(
  connection: LogicalConnection<M>,
  where?: ResolveOptions<M>["where"],
): boolean {
  return (
    connection.remoteIdentity !== undefined &&
    (!where || where(connection.remoteIdentity, connection.context.connection))
  );
}

function getTargetKey(target: object): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(target).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
}

/** Preserve domain errors. Only raw protocol failures and unexpected exceptions need normalization. */
function connectionError(
  error: unknown,
  message: string,
  context?: Record<string, unknown>,
): NexusError {
  // Normalization is itself a boundary: arbitrary thrown values may have hostile
  // getters or no string conversion. Never let diagnostics reject a safe operation.
  const normalized = Result.try({
    try: () => (error instanceof NexusError ? error : toSerializedError(error)),
    catch: () => new NexusError(message, "E_UNKNOWN", { context }),
  }).match({ ok: (value) => value, err: (value) => value });
  if (normalized instanceof NexusError) return normalized;
  const cause = normalized;
  if (
    cause.code === "E_HANDSHAKE_FAILED" ||
    cause.code === "E_AUTH_CONNECT_DENIED"
  ) {
    return new NexusHandshakeError(
      cause.message,
      cause.code === "E_HANDSHAKE_FAILED"
        ? "E_HANDSHAKE_FAILED"
        : "E_HANDSHAKE_REJECTED",
      context,
      { cause, stack: cause.stack },
    );
  }
  return new NexusError(message, "E_UNKNOWN", {
    context,
    cause,
    stack: cause.stack,
  });
}
