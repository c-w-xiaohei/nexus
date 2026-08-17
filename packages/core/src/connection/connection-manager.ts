import { Transport } from "../transport/transport";
import type {
  PortProcessor,
  PortProcessorHandlers,
} from "../transport/port-processor";
import type { IdentityUpdateMessage, NexusMessage } from "../types/message";
import { NexusMessageType } from "../types/message";
import type { ConnectionContext } from "../types/identity";
import type {
  AdapterModel,
  ConnectionTargetOf,
  ConnectionMetaOf,
  ContextMetaOf,
} from "../types/adapter-model";
import { LogicalConnection } from "./logical-connection";
import { NexusEndpointCapabilityError } from "../errors/transport-errors";
import { NexusProtocolIncompatibleError } from "../errors/connection-errors";
import type {
  ConnectionManagerConfig,
  ConnectionManagerHandlers,
  MessageTarget,
  ResolveOptions,
} from "./types";
import { Logger } from "@/logger";
import { Result } from "better-result";
const { err, ok } = Result;

type ConnectionManagerErrorCode =
  | "E_HANDSHAKE_FAILED"
  | "E_AUTH_CONNECT_DENIED"
  | "E_CONNECTION_CONSTRAINT_FAILED"
  | "E_USAGE_INVALID"
  | "E_ENDPOINT_CAPABILITY_MISMATCH"
  | "E_PROTOCOL_INCOMPATIBLE"
  | "E_UNKNOWN";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

type ConnectionManagerErrorOptions = {
  readonly context?: Record<string, unknown>;
  readonly cause?: unknown;
};

export class ConnectionManagerError extends globalThis.Error {
  readonly code: ConnectionManagerErrorCode;
  readonly context?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(
    message: string,
    code: ConnectionManagerErrorCode,
    options: ConnectionManagerErrorOptions = {},
  ) {
    super(message);
    this.name = "ConnectionManagerError";
    this.code = code;
    this.context = options.context;
    this.cause = options.cause;
  }
}

export class ConnectionManagerHandshakeFailedError extends ConnectionManagerError {
  constructor(message: string, options: ConnectionManagerErrorOptions = {}) {
    super(message, "E_HANDSHAKE_FAILED", options);
    this.name = "ConnectionManagerHandshakeFailedError";
  }
}

export class ConnectionManagerAuthorizationDeniedError extends ConnectionManagerError {
  constructor(message: string, options: ConnectionManagerErrorOptions = {}) {
    super(message, "E_AUTH_CONNECT_DENIED", options);
    this.name = "ConnectionManagerAuthorizationDeniedError";
  }
}

class ConnectionManagerConstraintFailedError extends ConnectionManagerError {
  constructor(message: string, options: ConnectionManagerErrorOptions = {}) {
    super(message, "E_CONNECTION_CONSTRAINT_FAILED", options);
    this.name = "ConnectionManagerConstraintFailedError";
  }
}

export class ConnectionManagerOperationFailedError extends ConnectionManagerError {
  constructor(
    message: string,
    options: ConnectionManagerErrorOptions = {},
    code: ConnectionManagerErrorCode = "E_UNKNOWN",
  ) {
    super(message, code, options);
    this.name = "ConnectionManagerOperationFailedError";
  }
}

export const connectionManagerErrorFromUnknown = (
  error: unknown,
  input: { message: string; context?: Record<string, unknown> },
): ConnectionManagerError => {
  if (error instanceof ConnectionManagerError) {
    return error;
  }

  if (error instanceof NexusEndpointCapabilityError) {
    return new ConnectionManagerOperationFailedError(
      input.message,
      {
        cause: error,
        context: input.context,
      },
      "E_ENDPOINT_CAPABILITY_MISMATCH",
    );
  }

  if (error instanceof NexusProtocolIncompatibleError) {
    return new ConnectionManagerOperationFailedError(
      error.message,
      { cause: error, context: error.context },
      "E_PROTOCOL_INCOMPATIBLE",
    );
  }

  if (error instanceof globalThis.Error) {
    const normalized = new ConnectionManagerOperationFailedError(
      input.message,
      {
        cause: error,
        context: input.context,
      },
    );
    normalized.stack = error.stack;
    return normalized;
  }

  return new ConnectionManagerOperationFailedError(input.message, {
    cause: error,
    context: input.context,
  });
};

export class ConnectionManager<M extends AdapterModel> {
  private readonly logger = new Logger("L2 --- ConnectionManager");
  private readonly connectionsMap = new Map<string, LogicalConnection<M>>();
  private readonly sessionsMap = new Map<string, LogicalConnection<M>>();
  private readonly serviceGroupsMap = new Map<string, Set<string>>();
  private readonly pendingCreations = new Map<
    string,
    Promise<LogicalConnection<M>>
  >();
  private nextConnectionOrdinal = 1;
  private nextMessageOrdinal = 1;
  private initialized = false;
  private readonly localProviders = new Set<string>();
  private readonly availabilityListeners = new Set<() => void>();
  private initializationInFlight: Promise<
    Result<void, ConnectionManagerError>
  > | null = null;

  constructor(
    private readonly config: ConnectionManagerConfig<M>,
    private readonly transport: Transport.Context<M>,
    private readonly handlers: ConnectionManagerHandlers<M>,
    private localEndpointMeta: ContextMetaOf<M>,
  ) {}

  public get connections(): ReadonlyMap<string, LogicalConnection<M>> {
    return new Map(this.connectionsMap);
  }

  public get serviceGroups(): ReadonlyMap<string, ReadonlySet<string>> {
    return new Map(
      Array.from(this.serviceGroupsMap, ([group, connectionIds]) => [
        group,
        new Set(connectionIds),
      ]),
    );
  }

  public safePublishProviders(
    providers: readonly string[],
  ): Result<void, Error> {
    for (const provider of providers) this.localProviders.add(provider);
    for (const connection of this.sessionsMap.values()) {
      connection.publishProviders(providers).match({
        ok: () => undefined,
        err: () => undefined,
      });
    }
    this.notifyAvailabilityChanged();
    return ok(undefined);
  }

  public getReadyProviderConnectionIds(provider: string): readonly string[] {
    return Array.from(this.connectionsMap.values())
      .filter(
        (connection) =>
          connection.isReady() && connection.remoteProviders.has(provider),
      )
      .map((connection) => connection.connectionId);
  }

  public getReadyProviderConnections(
    provider: string,
    where?: ResolveOptions<M>["where"],
  ): readonly LogicalConnection<M>[] {
    return this.findReadyConnections(where).filter((connection) =>
      connection.remoteProviders.has(provider),
    );
  }

  public getReadyTargetConnections(
    target: ConnectionTargetOf<M>,
    where?: ResolveOptions<M>["where"],
  ): readonly LogicalConnection<M>[] {
    return this.applyWhere(this.findReadyTargetConnections(target), where);
  }

  public subscribeAvailabilityChanged(listener: () => void): () => void {
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  public safeInitialize(): Promise<Result<void, ConnectionManagerError>> {
    if (this.initialized) {
      return Promise.resolve(ok(undefined));
    }
    if (this.initializationInFlight) {
      return this.initializationInFlight;
    }

    this.initializationInFlight = Transport.safeListen(
      this.transport,
      (createProcessor, connectionMeta) => {
        const connectionId = this.allocateConnectionId();
        void Result.tryPromise({
          try: () =>
            this.acceptIncomingConnection({
              connectionId,
              connectionMeta: connectionMeta ?? ({} as ConnectionMetaOf<M>),
              createProcessor,
            }),
          catch: (error) =>
            connectionManagerErrorFromUnknown(error, {
              message: `Unexpected error accepting incoming connection #${connectionId}`,
              context: { connectionId },
            }),
        }).then((result) =>
          result.match({
            ok: () => undefined,
            err: (error) =>
              this.logger.error(
                `Unexpected error accepting incoming connection #${connectionId}`,
                error,
              ),
          }),
        );
      },
    ).then((result) => {
      const mapped = result
        .mapError((error) =>
          connectionManagerErrorFromUnknown(error, {
            message: "Failed to start connection manager listener",
          }),
        )
        .map(() => {
          this.initialized = true;
        });
      this.initializationInFlight = null;
      return mapped;
    });

    return this.initializationInFlight;
  }

  public safeResolveConnection(
    options: ResolveOptions<M>,
  ): Promise<Result<LogicalConnection<M> | null, ConnectionManagerError>> {
    const initializedCheck = this.ensureInitialized("safeResolveConnection");
    if (initializedCheck.isErr()) {
      return Promise.resolve(err(initializedCheck.error));
    }

    return Result.tryPromise({
      try: () => this.resolveConnectionUnsafe(options),
      catch: (e) =>
        connectionManagerErrorFromUnknown(e, {
          message: "Failed to resolve connection",
          context: { options },
        }),
    });
  }

  public safeResolveConnections(
    options: ResolveOptions<M>,
  ): Promise<Result<readonly LogicalConnection<M>[], ConnectionManagerError>> {
    const initializedCheck = this.ensureInitialized("safeResolveConnections");
    if (initializedCheck.isErr()) {
      return Promise.resolve(err(initializedCheck.error));
    }

    return Result.tryPromise({
      try: () => this.resolveConnectionsUnsafe(options),
      catch: (e) =>
        connectionManagerErrorFromUnknown(e, {
          message: "Failed to resolve connections",
          context: { options },
        }),
    });
  }

  public safeSendMessage(
    target: MessageTarget<M>,
    message: NexusMessage,
  ): Result<string[], ConnectionManagerError> {
    const initializedCheck = this.ensureInitialized("safeSendMessage");
    if (initializedCheck.isErr()) {
      return err(initializedCheck.error);
    }

    try {
      return routeMessage(
        this.connectionsMap,
        this.serviceGroupsMap,
        target,
        message,
        this.logger,
      );
    } catch (error) {
      return err(
        connectionManagerErrorFromUnknown(error, {
          message: `Failed to route message #${message.id ?? "N/A"}`,
          context: {
            target,
            messageType: message.type,
            messageId: message.id,
          },
        }),
      );
    }
  }

  public safeGetReadyConnectionIds(
    target: MessageTarget<M>,
  ): Result<string[], ConnectionManagerError> {
    const initializedCheck = this.ensureInitialized(
      "safeGetReadyConnectionIds",
    );
    if (initializedCheck.isErr()) return err(initializedCheck.error);

    if ("connectionId" in target) {
      return ok(
        this.connectionsMap.get(target.connectionId)?.isReady()
          ? [target.connectionId]
          : [],
      );
    }
    if ("connectionIds" in target) {
      return ok(
        target.connectionIds.filter((connectionId) =>
          this.connectionsMap.get(connectionId)?.isReady(),
        ),
      );
    }
    if ("group" in target) {
      return ok(
        Array.from(this.serviceGroupsMap.get(target.group) ?? []).filter(
          (connectionId) => this.connectionsMap.get(connectionId)?.isReady(),
        ),
      );
    }
    return ok(
      this.findReadyConnections(target.where).map(
        (connection) => connection.connectionId,
      ),
    );
  }

  public safeUpdateLocalIdentity(
    updates: Partial<ContextMetaOf<M>>,
  ): Result<void, ConnectionManagerError> {
    const initializedCheck = this.ensureInitialized("safeUpdateLocalIdentity");
    if (initializedCheck.isErr()) {
      return err(initializedCheck.error);
    }

    try {
      this.localEndpointMeta = { ...this.localEndpointMeta, ...updates };
      for (const connection of this.connectionsMap.values()) {
        connection.updateLocalIdentity(updates);
      }
      const broadcastResult = broadcastIdentityUpdate(
        this.connectionsMap,
        updates,
      );
      if (broadcastResult.isErr()) {
        return err(broadcastResult.error);
      }
      return ok(undefined);
    } catch (error) {
      return err(
        connectionManagerErrorFromUnknown(error, {
          message: "Failed to update local identity",
          context: { updates },
        }),
      );
    }
  }

  private allocateConnectionId(): string {
    const id = `conn-${this.nextConnectionOrdinal}`;
    this.nextConnectionOrdinal += 1;
    return id;
  }

  private nextMessageId = (): number => {
    const id = this.nextMessageOrdinal;
    this.nextMessageOrdinal += 1;
    return id;
  };

  private ensureInitialized(
    operation: string,
  ): Result<void, ConnectionManagerError> {
    if (!this.initialized) {
      return err(
        new ConnectionManagerError(
          "ConnectionManager is not initialized. Call safeInitialize() first.",
          "E_USAGE_INVALID",
          { context: { operation } },
        ),
      );
    }

    return ok(undefined);
  }

  private findReadyConnections(
    where?: ResolveOptions<M>["where"],
  ): readonly LogicalConnection<M>[] {
    const matches: LogicalConnection<M>[] = [];

    for (const connection of this.connectionsMap.values()) {
      if (!connection.isReady() || !connection.remoteIdentity) continue;

      if (
        !where ||
        where(connection.remoteIdentity, connection.context.connection)
      ) {
        matches.push(connection);
      }
    }

    return matches;
  }

  private findReadyTargetConnections(
    target: ConnectionTargetOf<M>,
  ): readonly LogicalConnection<M>[] {
    const matchesTarget = this.transport.endpoint.matchesTarget;
    if (!matchesTarget) {
      return [];
    }

    return Array.from(this.connectionsMap.values()).filter(
      (connection) =>
        connection.isReady() &&
        connection.remoteIdentity &&
        matchesTarget(
          target,
          connection.remoteIdentity,
          connection.context.connection,
        ),
    );
  }

  private applyWhere(
    connections: readonly LogicalConnection<M>[],
    where?: ResolveOptions<M>["where"],
  ): readonly LogicalConnection<M>[] {
    if (!where) {
      return connections;
    }

    return connections.filter(
      (connection) =>
        connection.remoteIdentity !== undefined &&
        where(connection.remoteIdentity, connection.context.connection),
    );
  }

  private async resolveConnectionUnsafe(
    options: ResolveOptions<M>,
  ): Promise<LogicalConnection<M> | null> {
    this.logger.debug("Attempting to resolve connection.", options);

    if (!options.target) {
      return null;
    }

    const targetMatches = this.findReadyTargetConnections(options.target);
    if (targetMatches.length > 0) {
      const constrained = this.applyWhere(targetMatches, options.where);
      if (constrained.length === 0 && options.where) {
        throw new ConnectionManagerConstraintFailedError(
          "A ready connection matched the target but failed its constraint.",
          { context: { target: options.target } },
        );
      }
      return constrained[0] ?? null;
    }

    const created = await this.createConnectionForTarget(
      options.target,
      options.assignmentMetadata,
    );
    const remoteIdentity = created.remoteIdentity;
    if (
      !remoteIdentity ||
      (options.where &&
        !options.where(remoteIdentity, created.context.connection))
    ) {
      throw new ConnectionManagerConstraintFailedError(
        "The newly connected target failed its constraint.",
        { context: { target: options.target } },
      );
    }

    return created;
  }

  private async resolveConnectionsUnsafe(
    options: ResolveOptions<M>,
  ): Promise<readonly LogicalConnection<M>[]> {
    this.logger.debug("Attempting to resolve connection candidates.", options);

    if (!options.target) {
      return this.findReadyConnections(options.where);
    }

    const targetMatches = this.findReadyTargetConnections(options.target);
    if (targetMatches.length > 0) {
      const constrained = this.applyWhere(targetMatches, options.where);
      if (constrained.length === 0 && options.where) {
        throw new ConnectionManagerConstraintFailedError(
          "A ready connection matched the target but failed its constraint.",
          { context: { target: options.target } },
        );
      }
      return constrained;
    }

    const created = await this.createConnectionForTarget(
      options.target,
      options.assignmentMetadata,
    );
    const remoteIdentity = created.remoteIdentity;
    if (
      !remoteIdentity ||
      (options.where &&
        !options.where(remoteIdentity, created.context.connection))
    ) {
      throw new ConnectionManagerConstraintFailedError(
        "The newly connected target failed its constraint.",
        { context: { target: options.target } },
      );
    }

    return [created];
  }

  private async createConnectionForTarget(
    target: ConnectionTargetOf<M>,
    assignmentMetadata?: ContextMetaOf<M>,
  ): Promise<LogicalConnection<M>> {
    const key =
      this.transport.endpoint.targetKey?.(target) ?? getTargetKey(target);
    const pendingExisting = this.pendingCreations.get(key);
    if (pendingExisting) {
      this.logger.debug(
        "Connection creation already pending for target, returning existing promise.",
        target,
      );
      return pendingExisting;
    }

    this.logger.debug(
      "No existing connection found. Proceeding to create phase.",
      target,
    );

    const pending = this.createConnectionFromTarget(target, assignmentMetadata);
    this.pendingCreations.set(key, pending);
    pending.then(
      () => {
        this.pendingCreations.delete(key);
      },
      () => {
        this.pendingCreations.delete(key);
      },
    );

    return pending;
  }

  private async acceptIncomingConnection(input: {
    connectionId: string;
    connectionMeta: ConnectionMetaOf<M>;
    createProcessor: (handlers: PortProcessorHandlers) => PortProcessor.Context;
  }): Promise<void> {
    this.logger.info(
      `Accepting incoming connection #${input.connectionId}`,
      input.connectionMeta,
    );

    const connectionRef: { current: LogicalConnection<M> | null } = {
      current: null,
    };
    const pendingMessages: NexusMessage[] = [];
    let disconnectedBeforeReady = false;
    let protocolErrorBeforeReady: unknown = null;

    const logicalHandlers = this.createLogicalHandlers(
      connectionRef,
      "incoming",
    );
    const portHandlers = this.createPortHandlers({
      connectionId: input.connectionId,
      direction: "incoming",
      connectionRef,
      pendingMessages,
      onDisconnectBeforeReady: () => {
        disconnectedBeforeReady = true;
      },
      onProtocolErrorBeforeReady: (error) => {
        protocolErrorBeforeReady = error;
      },
    });

    const portProcessor = input.createProcessor(portHandlers);
    const connection = this.createLogicalConnection(
      input.connectionId,
      input.connectionMeta,
      "incoming",
      portProcessor,
      logicalHandlers,
    );
    const handshakeTimeout = setTimeout(() => {
      if (!connection.isReady()) {
        connection.close();
      }
    }, this.config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);

    connectionRef.current = connection;
    const clearIncomingHandshakeTimeout = () => clearTimeout(handshakeTimeout);
    const originalOnVerified = logicalHandlers.onVerified;
    logicalHandlers.onVerified = (connInfo) => {
      clearIncomingHandshakeTimeout();
      originalOnVerified(connInfo);
    };
    const originalOnClosed = logicalHandlers.onClosed;
    logicalHandlers.onClosed = (connInfo) => {
      clearIncomingHandshakeTimeout();
      originalOnClosed(connInfo);
    };

    if (protocolErrorBeforeReady) {
      this.logger.error(
        `Protocol error on incoming connection #${input.connectionId}`,
        protocolErrorBeforeReady,
      );
      connection.close();
      return;
    }

    void flushBufferedMessages(
      this.logger,
      input.connectionId,
      connection,
      pendingMessages,
    ).then((result) =>
      result.match({ ok: () => undefined, err: () => undefined }),
    );

    if (disconnectedBeforeReady) {
      connection.handleDisconnect();
    }
  }

  private async createConnectionFromTarget(
    target: ConnectionTargetOf<M>,
    assignmentMetadata?: ContextMetaOf<M>,
  ): Promise<LogicalConnection<M>> {
    const connectionId = this.allocateConnectionId();
    this.logger.info(`Creating new outgoing connection #${connectionId}`);

    const connectionRef: { current: LogicalConnection<M> | null } = {
      current: null,
    };
    const pendingMessages: NexusMessage[] = [];
    let disconnectedBeforeReady = false;
    let protocolErrorBeforeReady: unknown = null;
    const handshake = createDeferred<LogicalConnection<M>>();
    const handshakeTimeout = setTimeout(() => {
      connectionRef.current?.close();
      handshake.reject(
        new ConnectionManagerHandshakeFailedError(
          `Connection ${connectionId} timed out during handshake.`,
          { context: { connectionId } },
        ),
      );
    }, this.config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    handshake.promise.then(
      () => clearTimeout(handshakeTimeout),
      () => clearTimeout(handshakeTimeout),
    );

    const logicalHandlers = this.createLogicalHandlers(
      connectionRef,
      "outgoing",
      {
        onVerified: (connection) => {
          handshake.resolve(connection);
        },
        onClosed: (connInfo) => {
          if (!connInfo.identity) {
            const rejection = connectionRef.current?.handshakeRejectionError;
            handshake.reject(
              (rejection as (Error & { code?: string }) | undefined)?.code ===
                "E_AUTH_CONNECT_DENIED"
                ? new ConnectionManagerAuthorizationDeniedError(
                    "Connection rejected by authorization policy.",
                    {
                      context: { connectionId: connInfo.connectionId },
                      cause: rejection,
                    },
                  )
                : (rejection as (Error & { code?: string }) | undefined)
                      ?.code === "E_PROTOCOL_INCOMPATIBLE"
                  ? new ConnectionManagerOperationFailedError(
                      "Connection rejected because the peer does not support the required protocol capability.",
                      {
                        context: { connectionId: connInfo.connectionId },
                        cause: rejection,
                      },
                      "E_PROTOCOL_INCOMPATIBLE",
                    )
                  : new ConnectionManagerHandshakeFailedError(
                      `Connection ${connInfo.connectionId} failed to establish. The remote endpoint may have rejected the connection or is unavailable.`,
                      {
                        context: { connectionId: connInfo.connectionId },
                        cause: rejection,
                      },
                    ),
            );
          }
        },
      },
    );

    const portHandlers = this.createPortHandlers({
      connectionId,
      direction: "outgoing",
      connectionRef,
      pendingMessages,
      onDisconnectBeforeReady: () => {
        disconnectedBeforeReady = true;
      },
      onProtocolErrorBeforeReady: (error) => {
        protocolErrorBeforeReady = error;
      },
    });

    const connectResult = await Transport.safeConnect(
      this.transport,
      target,
      portHandlers,
    );

    if (connectResult.isErr()) {
      handshake.reject(connectResult.error);
      return handshake.promise;
    }

    const { portProcessor, connectionMeta } = connectResult.value;
    const hasBufferedHandshakeRequest = pendingMessages.some(
      (message) => message.type === NexusMessageType.HANDSHAKE_REQ,
    );

    const connection = this.createLogicalConnection(
      connectionId,
      connectionMeta,
      "outgoing",
      portProcessor,
      logicalHandlers,
    );

    connectionRef.current = connection;

    if (protocolErrorBeforeReady) {
      this.logger.error(
        `Protocol error on outgoing connection #${connectionId}`,
        protocolErrorBeforeReady,
      );
      connection.close();
      return handshake.promise;
    }

    const flushResult = await flushBufferedMessages(
      this.logger,
      connectionId,
      connection,
      pendingMessages,
    );
    if (flushResult.isErr()) {
      return handshake.promise;
    }

    if (disconnectedBeforeReady) {
      connection.handleDisconnect();
      return handshake.promise;
    }

    if (hasBufferedHandshakeRequest || connection.isReady()) {
      return handshake.promise;
    }

    const handshakeStartResult = connection.initiateHandshake(
      this.localEndpointMeta,
      assignmentMetadata,
    );
    if (handshakeStartResult.isErr()) {
      handshake.reject(handshakeStartResult.error);
    }
    return handshake.promise;
  }

  private createLogicalConnection(
    connectionId: string,
    connectionMeta: ConnectionMetaOf<M>,
    direction: "incoming" | "outgoing",
    portProcessor: PortProcessor.Context,
    handlers: ReturnType<ConnectionManager<M>["createLogicalHandlers"]>,
  ): LogicalConnection<M> {
    const connection = new LogicalConnection<M>(portProcessor, handlers, {
      connectionId,
      connectionMeta,
      direction,
      localEndpointMeta: this.localEndpointMeta,
      nextMessageId: this.nextMessageId,
      localProviders: () => Array.from(this.localProviders),
    });
    this.sessionsMap.set(connectionId, connection);
    return connection;
  }

  private createLogicalHandlers(
    connectionRef: { current: LogicalConnection<M> | null },
    direction: "incoming" | "outgoing",
    overrides: LogicalHandlersOverrides<M> = {},
  ) {
    return {
      onVerified: (connInfo: { identity: ContextMetaOf<M> }) => {
        const connection = connectionRef.current;
        if (!connection) {
          return;
        }

        this.onConnectionVerified(connection, connInfo.identity);
        overrides.onVerified?.(connection, connInfo.identity);
      },
      onClosed: (connInfo: {
        connectionId: string;
        identity?: ContextMetaOf<M>;
      }) => {
        this.onConnectionClosed(connInfo);
        overrides.onClosed?.(connInfo);
      },
      onMessage: (message: NexusMessage, id: string) =>
        this.handlers.onMessage(message, id),
      onIdentityUpdated: (
        connectionId: string,
        newIdentity: ContextMetaOf<M>,
        oldIdentity: ContextMetaOf<M>,
        connectionMeta: ConnectionMetaOf<M>,
      ) =>
        this.onIdentityUpdated(
          connectionId,
          newIdentity,
          oldIdentity,
          connectionMeta,
        ),
      onProviderCatalogUpdated: () => this.notifyAvailabilityChanged(),
      verify: async (
        identity: ContextMetaOf<M>,
        context: ConnectionContext<ConnectionMetaOf<M>>,
      ) => {
        const canConnect = this.config.policy?.canConnect;
        if (!canConnect) {
          return true;
        }

        try {
          const allowed = await canConnect({
            localIdentity:
              connectionRef.current?.localIdentity ?? this.localEndpointMeta,
            remoteIdentity: identity,
            connection: context.connection,
            direction,
          });
          return allowed === true;
        } catch {
          return false;
        }
      },
    };
  }

  private createPortHandlers(options: {
    readonly connectionId: string;
    readonly direction: "incoming" | "outgoing";
    readonly connectionRef: { current: LogicalConnection<M> | null };
    readonly pendingMessages: NexusMessage[];
    onDisconnectBeforeReady: () => void;
    onProtocolErrorBeforeReady: (error: unknown) => void;
  }): PortProcessorHandlers {
    return {
      onLogicalMessage: (message: NexusMessage) => {
        const connection = options.connectionRef.current;
        if (!connection) {
          options.pendingMessages.push(message);
          return;
        }

        void connection.safeHandleMessage(message).then((result) =>
          result.match({
            ok: () => undefined,
            err: (error) => {
              this.logger.error(
                `Unhandled error while processing incoming message on #${options.connectionId}`,
                error,
              );
              connection.close();
            },
          }),
        );
      },
      onDisconnect: () => {
        const connection = options.connectionRef.current;
        if (!connection) {
          options.onDisconnectBeforeReady();
          return;
        }
        connection.handleDisconnect();
      },
      onProtocolError: (error) => {
        const connection = options.connectionRef.current;
        if (!connection) {
          options.onProtocolErrorBeforeReady(error);
          return;
        }

        this.logger.error(
          `Protocol error on ${options.direction} connection #${options.connectionId}`,
          error,
        );
        connection.close();
      },
    };
  }

  private onConnectionVerified(
    connection: LogicalConnection<M>,
    identity: ContextMetaOf<M>,
  ): void {
    const { connectionId } = connection;
    this.logger.info(
      `Connection #${connectionId} verified. Remote identity:`,
      identity,
    );

    registerGroups(
      this.serviceGroupsMap,
      connectionId,
      (identity as { groups?: string[] }).groups ?? [],
    );
    this.connectionsMap.set(connectionId, connection);
    this.notifyAvailabilityChanged();
  }

  public getConnectionAuthSnapshot(connectionId: string):
    | {
        readonly localIdentity: ContextMetaOf<M>;
        readonly remoteIdentity: ContextMetaOf<M>;
        readonly connection: ConnectionMetaOf<M>;
      }
    | undefined {
    const connection = this.connectionsMap.get(connectionId);
    if (!connection?.remoteIdentity) {
      return undefined;
    }

    return {
      localIdentity: connection.localIdentity,
      remoteIdentity: connection.remoteIdentity,
      connection: connection.context.connection,
    };
  }

  private onConnectionClosed(connInfo: {
    connectionId: string;
    identity?: ContextMetaOf<M>;
  }): void {
    const { connectionId, identity } = connInfo;
    this.logger.info(`Connection #${connectionId} closed.`, { identity });

    if (identity) {
      updateServiceGroups(this.serviceGroupsMap, connectionId, identity, null);
    }

    this.connectionsMap.delete(connectionId);
    this.sessionsMap.delete(connectionId);
    this.notifyAvailabilityChanged();
    this.handlers.onDisconnect(connectionId, identity);
  }

  private onIdentityUpdated(
    connectionId: string,
    newIdentity: ContextMetaOf<M>,
    oldIdentity: ContextMetaOf<M>,
    connectionMeta: ConnectionMetaOf<M>,
  ): void {
    if (!this.connectionsMap.has(connectionId)) {
      return;
    }

    this.logger.debug(
      `Remote identity for #${connectionId} updated.`,
      newIdentity,
    );
    updateServiceGroups(
      this.serviceGroupsMap,
      connectionId,
      oldIdentity,
      newIdentity,
    );
    this.handlers.onIdentityUpdated?.(
      connectionId,
      newIdentity,
      oldIdentity,
      connectionMeta,
    );
    this.notifyAvailabilityChanged();
  }

  private notifyAvailabilityChanged(): void {
    for (const listener of this.availabilityListeners) listener();
  }
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
};

type LogicalHandlersOverrides<M extends AdapterModel> = {
  onVerified?: (
    connection: LogicalConnection<M>,
    identity: ContextMetaOf<M>,
  ) => void;
  onClosed?: (connInfo: {
    connectionId: string;
    identity?: ContextMetaOf<M>;
  }) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      res(value);
    };
    reject = (error) => {
      if (settled) return;
      settled = true;
      rej(error);
    };
  });
  return { promise, resolve, reject };
}

function getTargetKey(target: object): string {
  return JSON.stringify(
    Object.keys(target)
      .sort()
      .reduce((acc, key) => {
        // @ts-expect-error dynamic object build
        acc[key] = target[key];
        return acc;
      }, {}),
  );
}

function routeMessage<M extends AdapterModel>(
  connections: ReadonlyMap<string, LogicalConnection<M>>,
  serviceGroups: ReadonlyMap<string, ReadonlySet<string>>,
  target: MessageTarget<M>,
  message: NexusMessage,
  logger: Logger,
): Result<string[], ConnectionManagerError> {
  const sentConnectionIds: string[] = [];
  logger.debug(`Routing message #${message.id ?? "N/A"} to target:`, target);

  const recordSendError = (error: unknown, connectionId: string) =>
    connectionManagerErrorFromUnknown(error, {
      message: `Failed to send message #${message.id ?? "N/A"} to connection ${connectionId}`,
      context: {
        connectionId,
        messageType: message.type,
        messageId: message.id,
      },
    });

  if ("connectionId" in target) {
    const connection = connections.get(target.connectionId);
    if (connection?.isReady()) {
      const sendResult = connection.sendMessage(message);
      if (sendResult.isOk()) {
        sentConnectionIds.push(target.connectionId);
      } else {
        return err(recordSendError(sendResult.error, target.connectionId));
      }
    }
    return ok(sentConnectionIds);
  }

  if ("connectionIds" in target) {
    for (const connectionId of target.connectionIds) {
      const connection = connections.get(connectionId);
      if (!connection?.isReady()) continue;
      const sendResult = connection.sendMessage(message);
      if (sendResult.isErr()) {
        return err(recordSendError(sendResult.error, connectionId));
      }
      sentConnectionIds.push(connectionId);
    }
    return ok(sentConnectionIds);
  }

  if ("group" in target) {
    const groupMembers = serviceGroups.get(target.group);
    if (!groupMembers) {
      return ok([]);
    }

    for (const connectionId of groupMembers) {
      const connection = connections.get(connectionId);
      if (connection?.isReady()) {
        const sendResult = connection.sendMessage(message);
        if (sendResult.isOk()) {
          sentConnectionIds.push(connectionId);
        } else {
          return err(recordSendError(sendResult.error, connectionId));
        }
      }
    }

    return ok(sentConnectionIds);
  }

  for (const connection of connections.values()) {
    if (
      connection.isReady() &&
      connection.remoteIdentity &&
      target.where?.(
        connection.remoteIdentity,
        connection.context.connection,
      ) !== false
    ) {
      const sendResult = connection.sendMessage(message);
      if (sendResult.isOk()) {
        sentConnectionIds.push(connection.connectionId);
      } else {
        return err(recordSendError(sendResult.error, connection.connectionId));
      }
    }
  }

  return ok(sentConnectionIds);
}

function broadcastIdentityUpdate<M extends AdapterModel>(
  connections: ReadonlyMap<string, LogicalConnection<M>>,
  updates: Partial<ContextMetaOf<M>>,
): Result<void, ConnectionManagerError> {
  const message: IdentityUpdateMessage = {
    type: NexusMessageType.IDENTITY_UPDATE,
    id: null,
    updates,
  };

  for (const connection of connections.values()) {
    if (connection.isReady()) {
      const sendResult = connection.sendMessage(message);
      if (sendResult.isErr()) {
        return err(
          connectionManagerErrorFromUnknown(sendResult.error, {
            message: `Failed to broadcast identity update to ${connection.connectionId}`,
          }),
        );
      }
    }
  }

  return ok(undefined);
}

function flushBufferedMessages<M extends AdapterModel>(
  logger: Logger,
  connectionId: string,
  connection: LogicalConnection<M>,
  pendingMessages: NexusMessage[],
): Promise<Result<void, ConnectionManagerError>> {
  const messages = pendingMessages.splice(0);

  return (async () => {
    for (const message of messages) {
      const result = await connection.safeHandleMessage(message);
      if (result.isErr()) {
        const error = connectionManagerErrorFromUnknown(result.error, {
          message: `Unhandled error while processing queued message on #${connectionId}`,
          context: { connectionId, messageId: message.id ?? "N/A" },
        });
        logger.error(
          `Unhandled error while processing queued message on #${connectionId}`,
          error,
        );
        connection.close();
        return err(error);
      }
    }
    return ok(undefined);
  })();
}

function registerGroups(
  serviceGroups: Map<string, Set<string>>,
  connectionId: string,
  groups: string[],
): void {
  for (const group of groups) {
    if (!serviceGroups.has(group)) {
      serviceGroups.set(group, new Set());
    }
    serviceGroups.get(group)!.add(connectionId);
  }
}

function updateServiceGroups(
  serviceGroups: Map<string, Set<string>>,
  connectionId: string,
  oldIdentity: (object & { groups?: string[] }) | null,
  newIdentity: (object & { groups?: string[] }) | null,
): void {
  const oldGroups = oldIdentity?.groups ?? [];
  const newGroups = newIdentity?.groups ?? [];

  const removed = oldGroups.filter((group) => !newGroups.includes(group));
  const added = newGroups.filter((group) => !oldGroups.includes(group));

  for (const group of removed) {
    serviceGroups.get(group)?.delete(connectionId);
  }

  for (const group of added) {
    if (!serviceGroups.has(group)) {
      serviceGroups.set(group, new Set());
    }
    serviceGroups.get(group)!.add(connectionId);
  }
}
