import { Transport } from "../transport/transport.js";
import type {
  PortProcessor,
  PortProcessorHandlers,
} from "../transport/port-processor.js";
import type { IdentityUpdateMessage, NexusMessage } from "../types/message.js";
import { NexusMessageType } from "../types/message.js";
import type {
  ConnectionContext,
  PlatformMeta,
  EndpointMeta,
} from "../types/identity.js";
import { LogicalConnection } from "./logical-connection.js";
import type {
  ConnectionManagerConfig,
  ConnectionManagerHandlers,
  Descriptor,
  MessageTarget,
  ResolveOptions,
} from "./types.js";
import { Logger } from "../logger.js";
import { Result } from "better-result";
const { err, ok } = Result;

type ConnectionManagerErrorCode =
  | "E_HANDSHAKE_FAILED"
  | "E_AUTH_CONNECT_DENIED"
  | "E_USAGE_INVALID"
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

export class ConnectionManagerOperationFailedError extends ConnectionManagerError {
  constructor(message: string, options: ConnectionManagerErrorOptions = {}) {
    super(message, "E_UNKNOWN", options);
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

export class ConnectionManager<
  U extends EndpointMeta & { groups?: string[] },
  P extends PlatformMeta,
> {
  private readonly logger = new Logger("L2 --- ConnectionManager");
  private readonly connectionsMap = new Map<string, LogicalConnection<U, P>>();
  private readonly serviceGroupsMap = new Map<string, Set<string>>();
  private readonly pendingCreations = new Map<
    string,
    Promise<LogicalConnection<U, P>>
  >();
  private nextConnectionOrdinal = 1;
  private nextMessageOrdinal = 1;
  private initialized = false;
  private initializationInFlight: Promise<
    Result<void, ConnectionManagerError>
  > | null = null;

  constructor(
    private readonly config: ConnectionManagerConfig<U, P>,
    private readonly transport: Transport.Context<U, P>,
    private readonly handlers: ConnectionManagerHandlers<U, P>,
    private localEndpointMeta: U,
  ) {}

  public get connections(): ReadonlyMap<string, LogicalConnection<U, P>> {
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

  public async safeInitialize(): Promise<Result<void, ConnectionManagerError>> {
    if (this.initialized) {
      return ok(undefined);
    }
    if (this.initializationInFlight) {
      return this.initializationInFlight;
    }

    const initialization = Transport.safeListen(
      this.transport,
      (createProcessor, platformMetadata) => {
        const connectionId = this.allocateConnectionId();
        void Result.tryPromise({
          try: () =>
            this.acceptIncomingConnection({
              connectionId,
              platformMetadata: (platformMetadata ?? {}) as P,
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
            err: (error) => {
              this.logger.error(
                `Unexpected error accepting incoming connection #${connectionId}`,
                error,
              );
            },
          }),
        );
      },
    ).then((listenResult) =>
      listenResult
        .mapError((error) =>
          connectionManagerErrorFromUnknown(error, {
            message: "Failed to start connection manager listener",
          }),
        )
        .map(() => {
          this.initialized = true;
          // Pre-warm is asynchronous fire-and-forget. This method returns once
          // listener activation succeeds (or fails with Result error).
          this.preWarmConnections();
        }),
    );
    this.initializationInFlight = initialization.then((value) => {
      this.initializationInFlight = null;
      return value;
    });
    return this.initializationInFlight;
  }

  public safeResolveConnection(
    options: ResolveOptions<U, P>,
  ): Promise<Result<LogicalConnection<U, P> | null, ConnectionManagerError>> {
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
    options: ResolveOptions<U, P>,
  ): Promise<
    Result<readonly LogicalConnection<U, P>[], ConnectionManagerError>
  > {
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
    target: MessageTarget<U>,
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

  public safeUpdateLocalIdentity(
    updates: Partial<U>,
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

  private preWarmConnections(): void {
    if (!Array.isArray(this.config.connectTo)) {
      return;
    }

    for (const target of this.config.connectTo) {
      this.logger.info("Initiating pre-warmed connection.", target);
      void this.safeResolveConnection(target).then((result) =>
        result.match({
          ok: () => undefined,
          err: (error) => {
            console.error(
              "Nexus DEV: Failed to establish pre-warmed connection for target:",
              target,
              error,
            );
            this.logger.error(
              "Failed to establish pre-warmed connection.",
              target,
              error,
            );
          },
        }),
      );
    }
  }

  private async resolveConnectionUnsafe(
    options: ResolveOptions<U, P>,
  ): Promise<LogicalConnection<U, P> | null> {
    this.logger.debug("Attempting to resolve connection.", options);

    const found = findReadyConnections(this.connectionsMap, options);
    if (found.length > 0) {
      return found[0];
    }

    return this.createConnectionForDescriptor(options);
  }

  private async resolveConnectionsUnsafe(
    options: ResolveOptions<U, P>,
  ): Promise<readonly LogicalConnection<U, P>[]> {
    this.logger.debug("Attempting to resolve connection candidates.", options);

    const found = findReadyConnections(this.connectionsMap, options);
    if (found.length > 0) {
      return found;
    }

    const created = await this.createConnectionForDescriptor(options);
    if (!created?.remoteIdentity) {
      return [];
    }

    if (options.matcher && !options.matcher(created.remoteIdentity)) {
      return [];
    }

    return [created];
  }

  private async createConnectionForDescriptor(
    options: ResolveOptions<U, P>,
  ): Promise<LogicalConnection<U, P> | null> {
    const { matcher, descriptor } = options;
    if (matcher && !descriptor) {
      return null;
    }

    if (!descriptor) {
      return null;
    }

    const key = getDescriptorKey(descriptor);
    const pendingExisting = this.pendingCreations.get(key);
    if (pendingExisting) {
      this.logger.debug(
        "Connection creation already pending for descriptor, returning existing promise.",
        descriptor,
      );
      return pendingExisting;
    }

    this.logger.debug(
      "No existing connection found. Proceeding to create phase.",
      descriptor,
    );

    const pending = this.createConnectionFromDescriptor(
      descriptor,
      options.assignmentMetadata,
    );
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
    platformMetadata: P;
    createProcessor: (handlers: PortProcessorHandlers) => PortProcessor.Context;
  }): Promise<void> {
    this.logger.info(
      `Accepting incoming connection #${input.connectionId}`,
      input.platformMetadata,
    );

    const connectionRef: { current: LogicalConnection<U, P> | null } = {
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
      input.platformMetadata,
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

  private async createConnectionFromDescriptor(
    descriptor: Descriptor<U>,
    assignmentMetadata?: U,
  ): Promise<LogicalConnection<U, P>> {
    const connectionId = this.allocateConnectionId();
    this.logger.info(`Creating new outgoing connection #${connectionId}`);

    const connectionRef: { current: LogicalConnection<U, P> | null } = {
      current: null,
    };
    const pendingMessages: NexusMessage[] = [];
    let disconnectedBeforeReady = false;
    let protocolErrorBeforeReady: unknown = null;
    const handshake = createDeferred<LogicalConnection<U, P>>();
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
      descriptor,
      portHandlers,
    );

    if (connectResult.isErr()) {
      handshake.reject(connectResult.error);
      return handshake.promise;
    }

    const [portProcessor, platformMetadata] = connectResult.value;
    const hasBufferedHandshakeRequest = pendingMessages.some(
      (message) => message.type === NexusMessageType.HANDSHAKE_REQ,
    );

    const connection = this.createLogicalConnection(
      connectionId,
      platformMetadata,
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
    platformMetadata: P,
    portProcessor: PortProcessor.Context,
    handlers: ReturnType<ConnectionManager<U, P>["createLogicalHandlers"]>,
  ): LogicalConnection<U, P> {
    return new LogicalConnection<U, P>(portProcessor, handlers, {
      connectionId,
      platformMetadata,
      localEndpointMeta: this.localEndpointMeta,
      nextMessageId: this.nextMessageId,
    });
  }

  private createLogicalHandlers(
    connectionRef: { current: LogicalConnection<U, P> | null },
    direction: "incoming" | "outgoing",
    overrides: LogicalHandlersOverrides<U, P> = {},
  ) {
    return {
      onVerified: (connInfo: { identity: U }) => {
        const connection = connectionRef.current;
        if (!connection) {
          return;
        }

        this.onConnectionVerified(connection, connInfo.identity);
        overrides.onVerified?.(connection, connInfo.identity);
      },
      onClosed: (connInfo: { connectionId: string; identity?: U }) => {
        this.onConnectionClosed(connInfo);
        overrides.onClosed?.(connInfo);
      },
      onMessage: (message: NexusMessage, id: string) =>
        this.handlers.onMessage(message, id),
      onIdentityUpdated: (
        connectionId: string,
        newIdentity: U,
        oldIdentity: U,
      ) => this.onIdentityUpdated(connectionId, newIdentity, oldIdentity),
      verify: async (identity: U, context: ConnectionContext<P>) => {
        const canConnect = this.config.policy?.canConnect;
        if (!canConnect) {
          return true;
        }

        try {
          const allowed = await canConnect({
            localIdentity:
              connectionRef.current?.localIdentity ?? this.localEndpointMeta,
            remoteIdentity: identity,
            platform: context.platform,
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
    readonly connectionRef: { current: LogicalConnection<U, P> | null };
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
    connection: LogicalConnection<U, P>,
    identity: U,
  ): void {
    const { connectionId } = connection;
    this.logger.info(
      `Connection #${connectionId} verified. Remote identity:`,
      identity,
    );

    registerGroups(this.serviceGroupsMap, connectionId, identity.groups ?? []);
    this.connectionsMap.set(connectionId, connection);
  }

  public getConnectionAuthSnapshot(connectionId: string):
    | {
        readonly localIdentity: U;
        readonly remoteIdentity: U;
        readonly platform: P;
      }
    | undefined {
    const connection = this.connectionsMap.get(connectionId);
    if (!connection?.remoteIdentity) {
      return undefined;
    }

    return {
      localIdentity: connection.localIdentity,
      remoteIdentity: connection.remoteIdentity,
      platform: connection.context.platform,
    };
  }

  private onConnectionClosed(connInfo: {
    connectionId: string;
    identity?: U;
  }): void {
    const { connectionId, identity } = connInfo;
    this.logger.info(`Connection #${connectionId} closed.`, { identity });

    if (identity) {
      updateServiceGroups(this.serviceGroupsMap, connectionId, identity, null);
    }

    this.connectionsMap.delete(connectionId);
    this.handlers.onDisconnect(connectionId, identity);
  }

  private onIdentityUpdated(
    connectionId: string,
    newIdentity: U,
    oldIdentity: U,
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
    this.handlers.onIdentityUpdated?.(connectionId, newIdentity, oldIdentity);
  }
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
};

type LogicalHandlersOverrides<
  U extends EndpointMeta,
  P extends PlatformMeta,
> = {
  onVerified?: (connection: LogicalConnection<U, P>, identity: U) => void;
  onClosed?: (connInfo: { connectionId: string; identity?: U }) => void;
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

function getDescriptorKey(descriptor: object): string {
  return JSON.stringify(
    Object.keys(descriptor)
      .sort()
      .reduce((acc, key) => {
        // @ts-expect-error dynamic object build
        acc[key] = descriptor[key];
        return acc;
      }, {}),
  );
}

function isDeepMatch(target: any, source: any): boolean {
  if (target === source) {
    return true;
  }

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

function findReadyConnections<U extends EndpointMeta, P extends PlatformMeta>(
  connections: ReadonlyMap<string, LogicalConnection<U, P>>,
  options: ResolveOptions<U, P>,
): readonly LogicalConnection<U, P>[] {
  const { matcher, descriptor } = options;
  const matches: LogicalConnection<U, P>[] = [];

  for (const connection of connections.values()) {
    if (!connection.isReady() || !connection.remoteIdentity) {
      continue;
    }

    if (matcher && matcher(connection.remoteIdentity)) {
      matches.push(connection);
      continue;
    }

    if (
      !matcher &&
      descriptor &&
      isDeepMatch(connection.remoteIdentity, descriptor)
    ) {
      matches.push(connection);
    }
  }

  return matches;
}

function routeMessage<U extends EndpointMeta, P extends PlatformMeta>(
  connections: ReadonlyMap<string, LogicalConnection<U, P>>,
  serviceGroups: ReadonlyMap<string, ReadonlySet<string>>,
  target: MessageTarget<U>,
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
      target.matcher(connection.remoteIdentity)
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

function broadcastIdentityUpdate<
  U extends EndpointMeta,
  P extends PlatformMeta,
>(
  connections: ReadonlyMap<string, LogicalConnection<U, P>>,
  updates: Partial<U>,
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

function flushBufferedMessages<U extends EndpointMeta, P extends PlatformMeta>(
  logger: Logger,
  connectionId: string,
  connection: LogicalConnection<U, P>,
  pendingMessages: NexusMessage[],
): Promise<Result<void, ConnectionManagerError>> {
  const messages = pendingMessages.splice(0);

  let chain: Promise<Result<void, ConnectionManagerError>> = Promise.resolve(
    ok(undefined),
  );

  for (const message of messages) {
    chain = chain.then((result) =>
      result.andThenAsync(() =>
        connection.safeHandleMessage(message).then((next) =>
          next.mapError((error) =>
            connectionManagerErrorFromUnknown(error, {
              message: `Unhandled error while processing queued message on #${connectionId}`,
              context: { connectionId, messageId: message.id ?? "N/A" },
            }),
          ),
        ),
      ),
    );
  }

  return chain.then((result) =>
    result.tryRecover((error) => {
      logger.error(
        `Unhandled error while processing queued message on #${connectionId}`,
        error,
      );
      connection.close();
      return err(error);
    }),
  );
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

function updateServiceGroups<U extends EndpointMeta & { groups?: string[] }>(
  serviceGroups: Map<string, Set<string>>,
  connectionId: string,
  oldIdentity: U | null,
  newIdentity: U | null,
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
