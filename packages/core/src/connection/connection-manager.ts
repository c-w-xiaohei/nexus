import { Result } from "better-result";
import { Logger } from "@/logger";
import { createEvtChannel } from "@/utils/evt-channel";
import { NexusError } from "../errors/nexus-error";
import {
  NexusConnectionError,
  NexusHandshakeError,
} from "../errors/connection-errors";
import { NexusProtocolError } from "../errors/transport-errors";
import { NexusUsageError } from "../errors/usage-errors";
import { Transport } from "../transport/transport";
import type {
  AdapterModel,
  ConnectionTargetOf,
  ContextMetaOf,
  ConnectionMetaOf,
  ConnectionWhere,
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

  // Session indexes and shared acquisition work.
  private readonly sessionsMap = new Map<string, LogicalConnection<M>>();
  // Protocol readiness precedes manager publication, so this is a separate index,
  // not a filtered view of sessionsMap. Map order is publication order.
  private readonly connectionsMap = new Map<string, LogicalConnection<M>>();
  private readonly pendingCreations = new Map<
    string,
    Promise<Result<LogicalConnection<M>, NexusError>>
  >();
  private nextConnectionOrdinal = 1;
  private nextMessageOrdinal = 1;

  // Local publication and listener initialization.
  private readonly localProviders = new Set<string>();
  private initialized = false;
  private initialization: Promise<Result<void, NexusError>> | undefined;

  // Collection observation and session-owner callbacks.
  private readonly availabilityChanel =
    createEvtChannel<LogicalConnection<M>>();
  /** Observes publication and accepted identity updates; close and catalog changes do not wake acquisition. */
  public readonly subscribeAvailabilityChanged = this.availabilityChanel[0];

  // One owner interface serves every session. These callbacks maintain collection
  // indexes and dispatch direct commands upstream.
  private readonly sessionHandlers: LogicalConnectionHandlers<M> = {
    authorize: (context) => {
      const canConnect = this.config.policy?.canConnect;
      return canConnect ? canConnect(context) : true;
    },
    onAttached: (connection) => {
      this.sessionsMap.set(connection.connectionId, connection);
      return ok(undefined);
    },
    onReady: (connection) => {
      this.connectionsMap.set(connection.connectionId, connection);
      const notify = () => {
        this.availabilityChanel[1]
          .safeEmit(connection)
          .tapError((errors) =>
            this.logger.error("Availability observers failed", errors),
          );
      };
      connection.subscribeIdentity(notify);
      notify();
      return ok(undefined);
    },
    onClosed: (connection) => {
      const id = connection.connectionId;
      // Remove indexes before notifying L3 so cleanup cannot observe a live session.
      this.connectionsMap.delete(id);
      this.sessionsMap.delete(id);
      this.handlers.onDisconnect(id);
    },
    onMessage: (connection, message) =>
      this.handlers.onMessage(message, connection.connectionId),
  };

  /** Construct without listening or dialing. Call safeInitialize before demand operations. */
  constructor(
    private readonly config: ConnectionManagerConfig<M>,
    private readonly transport: Transport.Context<M>,
    private readonly handlers: ConnectionManagerHandlers,
    private localEndpointMeta: ContextMetaOf<M>,
  ) {}

  // ===== Published Session Queries =====

  /** Detached map of published sessions; contained connection objects remain live. */
  public get connections(): ReadonlyMap<string, LogicalConnection<M>> {
    return new Map(this.connectionsMap);
  }

  /** Looks up one published session without copying the entire index. */
  public getConnection(id: string): LogicalConnection<M> | undefined {
    return this.connectionsMap.get(id);
  }

  /** Check the published index without initiating connection work. */
  public isConnectionReady(connectionId: string): boolean {
    return this.connectionsMap.get(connectionId)?.isReady() ?? false;
  }

  /** Return live authorization inputs for one published session, if present. */
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

  /** Return currently published sessions satisfying the optional predicate. */
  public findReadyConnections(
    where?: ConnectionWhere<M>,
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
   * Start listening once, then launch configured startup dials without awaiting
   * them or any remote provider. Reserve shared startup before entering the adapter;
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
    if (result.isOk()) {
      // A child can publish services to its owner without acquiring an owner
      // service. Reuse the same exact-target in-flight slot as demand calls.
      for (const target of this.config.connectTo ?? []) {
        void this.safeResolveConnections({ target }).then((connected) => {
          if (connected.isErr())
            this.logger.error("Startup connection failed", {
              target,
              error: connected.error,
            });
        });
      }
    }
    return result;
  }

  /**
   * Reuse published target matches, or share one in-flight dial for a missing
   * target. Caller selection belongs to L4 and never controls shared dialing.
   * Dial failures release the coalescing slot; they are never cached for retry.
   */
  public async safeResolveConnections(
    options: ResolveOptions<M>,
  ): Promise<Result<readonly LogicalConnection<M>[], NexusError>> {
    const initialized = this.ensureInitialized("safeResolveConnections");
    if (initialized.isErr()) return initialized;
    try {
      const { target, assignmentMetadata } = options;
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
      return ok(candidates);
    } catch (error) {
      return err(
        connectionError(error, "Failed to resolve connections", { options }),
      );
    }
  }

  // ===== Routing And Local Updates =====

  /** Sends to one already-published connection; this never discovers or dials. */
  public safeSendMessage(
    message: NexusMessage,
    connectionId: string,
  ): Result<void, NexusError> {
    const initialized = this.ensureInitialized("safeSendMessage");
    if (initialized.isErr()) return initialized;
    try {
      const connection = this.connectionsMap.get(connectionId);
      if (!connection?.isReady())
        return err(
          new NexusConnectionError(
            `Connection ${connectionId} is not ready.`,
            "E_CONN_CLOSED",
            { connectionId, messageType: message.type, messageId: message.id },
          ),
        );
      const sent = connection.sendMessage(message);
      if (sent.isErr())
        return err(
          new NexusConnectionError(
            `Failed to send message #${message.id ?? "N/A"} to connection ${connectionId}`,
            "E_CONN_CLOSED",
            { connectionId, messageType: message.type, messageId: message.id },
            toSerializedError(sent.error),
          ),
        );
      return ok(undefined);
    } catch (error) {
      return err(
        connectionError(
          error,
          `Failed to route message #${message.id ?? "N/A"}`,
          {
            connectionId,
            messageType: message.type,
            messageId: message.id,
          },
        ),
      );
    }
  }

  /** Announce providers to all attached peers, even during handshake; peer failures do not roll back registration. */
  public publishProviders(providers: readonly string[]): void {
    for (const provider of providers) this.localProviders.add(provider);
    for (const connection of this.sessionsMap.values()) {
      // A failed peer closes itself; registration still succeeds for other peers.
      connection.publishProviders(providers).unwrapOr(undefined);
    }
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

  /** Reject manager operations that require listener initialization. */
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

  /** Open one incoming or outgoing session and map its failure to manager errors. */
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

  /** Match the adapter target before applying where; never dial. */
  private getReadyTargetConnections(
    target: ConnectionTargetOf<M>,
  ): readonly LogicalConnection<M>[] {
    const matchesTarget = this.transport.endpoint.matchesTarget;
    if (!matchesTarget) return [];
    return this.findReadyConnections((identity, meta) =>
      matchesTarget(target, identity, meta),
    );
  }
}

/** Apply an optional caller predicate to a session's committed peer identity. */
function matchesWhere<M extends AdapterModel>(
  connection: LogicalConnection<M>,
  where?: ConnectionWhere<M>,
): boolean {
  return (
    connection.remoteIdentity !== undefined &&
    (!where || where(connection.remoteIdentity, connection.context.connection))
  );
}

/** Serialize an adapter target into a stable key for coalescing concurrent dials. */
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
    catch: () => undefined,
  }).match({ ok: (value) => value, err: () => undefined });
  if (normalized instanceof NexusError) return normalized;
  if (!normalized) return new NexusProtocolError(message, { context });
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
  return new NexusProtocolError(message, {
    context,
    cause,
    stack: cause.stack,
  });
}
