import { Transport } from "../transport/transport";
import type {
  PortProcessor,
  PortProcessorHandlers,
} from "../transport/port-processor";
import type { IdentityUpdateMessage, NexusMessage } from "../types/message";
import { NexusMessageType } from "../types/message";
import type {
  ConnectionContext,
  PlatformMetadata,
  UserMetadata,
} from "../types/identity";
import { LogicalConnection } from "./logical-connection";
import type {
  ConnectionManagerConfig,
  ConnectionManagerHandlers,
  Descriptor,
  MessageTarget,
  ResolveOptions,
} from "./types";
import { Logger } from "@/logger";
import { ResultAsync, err, errAsync, ok, type Result } from "neverthrow";

type ConnectionManagerErrorCode =
  | "E_HANDSHAKE_FAILED"
  | "E_USAGE_INVALID"
  | "E_UNKNOWN";

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
  U extends UserMetadata & { groups?: string[] },
  P extends PlatformMetadata,
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

  constructor(
    private readonly config: ConnectionManagerConfig<U, P>,
    private readonly transport: Transport.Context<U, P>,
    private readonly handlers: ConnectionManagerHandlers<U, P>,
    private localUserMetadata: U,
  ) {}

  public get connections(): ReadonlyMap<string, LogicalConnection<U, P>> {
    return this.connectionsMap;
  }

  public get serviceGroups(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.serviceGroupsMap;
  }

  public safeInitialize(): Result<void, ConnectionManagerError> {
    if (this.initialized) {
      return ok(undefined);
    }
    const listenResult = Transport.safeListen(
      this.transport,
      (createProcessor, platformMetadata) => {
        const connectionId = this.allocateConnectionId();
        void ResultAsync.fromPromise(
          this.acceptIncomingConnection({
            connectionId,
            platformMetadata: (platformMetadata ?? {}) as P,
            createProcessor,
          }),
          (error) =>
            connectionManagerErrorFromUnknown(error, {
              message: `Unexpected error accepting incoming connection #${connectionId}`,
              context: { connectionId },
            }),
        ).match(
          () => undefined,
          (error) => {
            this.logger.error(
              `Unexpected error accepting incoming connection #${connectionId}`,
              error,
            );
          },
        );
      },
    );

    if (listenResult.isErr()) {
      return err(
        connectionManagerErrorFromUnknown(listenResult.error, {
          message: "Failed to start connection manager listener",
        }),
      );
    }

    this.initialized = true;
    // Pre-warm is asynchronous fire-and-forget. This method returns once
    // listener activation succeeds (or fails with Result error).
    this.preWarmConnections();

    return ok(undefined);
  }

  public safeResolveConnection(
    options: ResolveOptions<U, P>,
  ): ResultAsync<LogicalConnection<U, P> | null, ConnectionManagerError> {
    const initializedCheck = this.ensureInitialized("safeResolveConnection");
    if (initializedCheck.isErr()) {
      return errAsync(initializedCheck.error);
    }

    return ResultAsync.fromPromise(this.resolveConnectionUnsafe(options), (e) =>
      connectionManagerErrorFromUnknown(e, {
        message: "Failed to resolve connection",
        context: { options },
      }),
    );
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
      this.localUserMetadata = { ...this.localUserMetadata, ...updates };
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
      this.safeResolveConnection(target).match(
        () => undefined,
        (error) => {
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
      );
    }
  }

  private async resolveConnectionUnsafe(
    options: ResolveOptions<U, P>,
  ): Promise<LogicalConnection<U, P> | null> {
    this.logger.debug("Attempting to resolve connection.", options);

    const found = findReadyConnection(this.connectionsMap, options);
    if (found) {
      return found;
    }

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

    const logicalHandlers = this.createLogicalHandlers(connectionRef);
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

    connectionRef.current = connection;
    this.connectionsMap.set(input.connectionId, connection);

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
    ).match(
      () => undefined,
      () => undefined,
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

    const logicalHandlers = this.createLogicalHandlers(connectionRef, {
      onVerified: (connection) => {
        handshake.resolve(connection);
      },
      onClosed: (connInfo) => {
        if (!connInfo.identity) {
          handshake.reject(
            new ConnectionManagerHandshakeFailedError(
              `Connection ${connInfo.connectionId} failed to establish. The remote endpoint may have rejected the connection or is unavailable.`,
              { context: { connectionId: connInfo.connectionId } },
            ),
          );
        }
      },
    });

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
    this.connectionsMap.set(connectionId, connection);

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
      this.localUserMetadata,
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
      localUserMetadata: this.localUserMetadata,
      nextMessageId: this.nextMessageId,
    });
  }

  private createLogicalHandlers(
    connectionRef: { current: LogicalConnection<U, P> | null },
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
      verify: (_identity: U, _context: ConnectionContext<P>) =>
        Promise.resolve(true),
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

        void connection.safeHandleMessage(message).match(
          () => undefined,
          (error) => {
            this.logger.error(
              `Unhandled error while processing incoming message on #${options.connectionId}`,
              error,
            );
            connection.close();
          },
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
  }
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
};

type LogicalHandlersOverrides<
  U extends UserMetadata,
  P extends PlatformMetadata,
> = {
  onVerified?: (connection: LogicalConnection<U, P>, identity: U) => void;
  onClosed?: (connInfo: { connectionId: string; identity?: U }) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
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

function findReadyConnection<
  U extends UserMetadata,
  P extends PlatformMetadata,
>(
  connections: ReadonlyMap<string, LogicalConnection<U, P>>,
  options: ResolveOptions<U, P>,
): LogicalConnection<U, P> | null {
  const { matcher, descriptor } = options;

  for (const connection of connections.values()) {
    if (!connection.isReady() || !connection.remoteIdentity) {
      continue;
    }

    if (matcher && matcher(connection.remoteIdentity)) {
      return connection;
    }

    if (
      !matcher &&
      descriptor &&
      isDeepMatch(connection.remoteIdentity, descriptor)
    ) {
      return connection;
    }
  }

  return null;
}

function routeMessage<U extends UserMetadata, P extends PlatformMetadata>(
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

  if ("groupName" in target) {
    const groupMembers = serviceGroups.get(target.groupName);
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
  U extends UserMetadata,
  P extends PlatformMetadata,
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

function flushBufferedMessages<
  U extends UserMetadata,
  P extends PlatformMetadata,
>(
  logger: Logger,
  connectionId: string,
  connection: LogicalConnection<U, P>,
  pendingMessages: NexusMessage[],
): ResultAsync<void, ConnectionManagerError> {
  const messages = pendingMessages.splice(0);

  let chain: ResultAsync<void, ConnectionManagerError> =
    ResultAsync.fromSafePromise(Promise.resolve()).mapErr((error) =>
      connectionManagerErrorFromUnknown(error, {
        message: `Failed to initialize buffered message processing chain for #${connectionId}`,
        context: { connectionId },
      }),
    );

  for (const message of messages) {
    chain = chain.andThen(() =>
      connection.safeHandleMessage(message).mapErr((error) =>
        connectionManagerErrorFromUnknown(error, {
          message: `Unhandled error while processing queued message on #${connectionId}`,
          context: { connectionId, messageId: message.id ?? "N/A" },
        }),
      ),
    );
  }

  return chain.orElse((error) => {
    logger.error(
      `Unhandled error while processing queued message on #${connectionId}`,
      error,
    );
    connection.close();
    return errAsync(error);
  });
}

function registerGroups(
  serviceGroups: Map<string, Set<string>>,
  connectionId: string,
  groups: string[],
): void {
  for (const groupName of groups) {
    if (!serviceGroups.has(groupName)) {
      serviceGroups.set(groupName, new Set());
    }
    serviceGroups.get(groupName)!.add(connectionId);
  }
}

function updateServiceGroups<U extends UserMetadata & { groups?: string[] }>(
  serviceGroups: Map<string, Set<string>>,
  connectionId: string,
  oldIdentity: U | null,
  newIdentity: U | null,
): void {
  const oldGroups = oldIdentity?.groups ?? [];
  const newGroups = newIdentity?.groups ?? [];

  const removed = oldGroups.filter((group) => !newGroups.includes(group));
  const added = newGroups.filter((group) => !oldGroups.includes(group));

  for (const groupName of removed) {
    serviceGroups.get(groupName)?.delete(connectionId);
  }

  for (const groupName of added) {
    if (!serviceGroups.has(groupName)) {
      serviceGroups.set(groupName, new Set());
    }
    serviceGroups.get(groupName)!.add(connectionId);
  }
}
