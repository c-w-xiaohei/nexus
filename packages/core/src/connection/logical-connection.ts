import { PortProcessor } from "../transport/port-processor";
import type {
  AdapterModel,
  ConnectionMetaOf,
  ContextMetaOf,
} from "../types/adapter-model";
import type { ConnectionContext } from "../types/identity";
import type {
  NexusMessage,
  HandshakeReqMessage,
  HandshakeAckMessage,
  HandshakeReadyMessage,
  IdentityUpdateMessage,
  ProviderAvailableMessage,
} from "../types/message";
import { NexusMessageType } from "../types/message";
import { ConnectionStatus, type LogicalConnectionHandlers } from "./types";
import { Logger } from "@/logger";
import { toSerializedError } from "@/utils/error";
import { NexusProtocolIncompatibleError } from "@/errors";
import { Result } from "better-result";
const { err, ok } = Result;

const PROVIDER_CATALOG_CAPABILITY = "provider-catalog-v1";

type LogicalConnectionErrorCode = "E_AUTH_CONNECT_DENIED" | "E_USAGE_INVALID";

type LogicalConnectionErrorOptions = {
  readonly context?: Record<string, unknown>;
};

class LogicalConnectionBaseError extends Error {
  readonly code: LogicalConnectionErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: LogicalConnectionErrorCode,
    options: LogicalConnectionErrorOptions = {},
  ) {
    super(message);
    this.name = "LogicalConnectionError";
    this.code = code;
    this.context = options.context;
  }
}

class LogicalConnectionAuthDeniedError extends Error {
  readonly code = "E_AUTH_CONNECT_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "LogicalConnectionAuthDeniedError";
  }
}

class LogicalConnectionHandshakeRejectedError extends LogicalConnectionBaseError {
  constructor(message: string, options: LogicalConnectionErrorOptions = {}) {
    super(message, "E_AUTH_CONNECT_DENIED", options);
    this.name = "LogicalConnectionHandshakeRejectedError";
  }
}

class LogicalConnectionInvalidStateError extends LogicalConnectionBaseError {
  constructor(message: string, options: LogicalConnectionErrorOptions = {}) {
    super(message, "E_USAGE_INVALID", options);
    this.name = "LogicalConnectionInvalidStateError";
  }
}

export const LogicalConnectionError = {
  Base: LogicalConnectionBaseError,
  HandshakeRejected: LogicalConnectionHandshakeRejectedError,
  InvalidState: LogicalConnectionInvalidStateError,
} as const;

/**
 * Encapsulates all state and logic for a single point-to-point connection.
 * It manages the connection lifecycle, orchestrates the handshake protocol,
 * and acts as the bridge between the ConnectionManager and a low-level PortProcessor.
 */
export class LogicalConnection<M extends AdapterModel> {
  public readonly connectionId: string;
  public readonly direction: "incoming" | "outgoing";
  private status: ConnectionStatus = ConnectionStatus.INITIALIZING;
  public readonly context: ConnectionContext<ConnectionMetaOf<M>>;
  private _remoteIdentity?: ContextMetaOf<M>;
  private wasEstablished = false;
  private rejectionError?: Error;
  private outboundHandshakeId?: HandshakeReqMessage["id"];
  private inboundHandshakeId?: HandshakeReqMessage["id"];
  private acknowledgedHandshakeId?: HandshakeReqMessage["id"];
  private inboundOrderingGate: Promise<void> = Promise.resolve();
  private readonly logger: Logger;
  private readonly nextMessageId: () => number;
  private readonly localProviders: () => readonly string[];
  private readonly remoteProvidersSet = new Set<string>();
  private readonly queuedProviders = new Set<string>();
  private readonly queuedOutboundMessages: NexusMessage[] = [];
  private outboundReadyGate = false;

  // This connection's own user metadata. It can be reassigned during a
  // "christening" handshake if this is a child context.
  private localEndpointMeta: ContextMetaOf<M>;

  constructor(
    // Dependencies injected by ConnectionManager
    private readonly portProcessor: PortProcessor.Context,
    private readonly handlers: LogicalConnectionHandlers<M>,
    // Initial state
    config: {
      connectionId: string;
      localEndpointMeta: ContextMetaOf<M>;
      // For ALL connections, this is the metadata of the remote endpoint discovered by L1.
      connectionMeta: ConnectionMetaOf<M>;
      direction: "incoming" | "outgoing";
      nextMessageId: () => number;
      localProviders?: () => readonly string[];
    },
  ) {
    this.connectionId = config.connectionId;
    this.direction = config.direction;
    this.localEndpointMeta = config.localEndpointMeta;
    this.nextMessageId = config.nextMessageId;
    this.localProviders = config.localProviders ?? (() => []);
    this.context = {
      connectionId: this.connectionId,
      connection: Object.freeze({ ...config.connectionMeta }),
    };
    this.logger = new Logger(`L2 --- LogicalConnection<${this.connectionId}>`);
    this.logger.info("Created.", this.context);
  }

  // ===========================================================================
  // Public API for ConnectionManager
  // ===========================================================================

  /**
   * Checks if the connection is fully established and ready for communication.
   */
  public isReady(): boolean {
    return this.status === ConnectionStatus.CONNECTED;
  }

  public get remoteIdentity(): ContextMetaOf<M> | undefined {
    return this._remoteIdentity;
  }

  public get localIdentity(): ContextMetaOf<M> {
    return this.localEndpointMeta;
  }

  public updateLocalIdentity(updates: Partial<ContextMetaOf<M>>): void {
    this.localEndpointMeta = { ...this.localEndpointMeta, ...updates };
  }

  public get handshakeRejectionError(): Error | undefined {
    return this.rejectionError;
  }

  public get remoteProviders(): ReadonlySet<string> {
    return new Set(this.remoteProvidersSet);
  }

  public publishProviders(providers: readonly string[]): Result<void, Error> {
    for (const provider of providers) this.queuedProviders.add(provider);
    if (!this.isReady() || this.queuedProviders.size === 0)
      return ok(undefined);
    return this.flushQueuedProviders();
  }

  /**
   * Starts the handshake process from the active/client side.
   * @param localEndpointMeta The user metadata of the local endpoint.
   * @param assignmentMetadata Optional metadata to be assigned to the remote (child) endpoint.
   */
  public initiateHandshake(
    localEndpointMeta: ContextMetaOf<M>,
    assignmentMetadata?: ContextMetaOf<M>,
  ): Result<void, Error> {
    if (this.status !== ConnectionStatus.INITIALIZING) {
      this.logger.warn(
        "Handshake initiated in non-INITIALIZING state.",
        this.status,
      );
      return err(
        new LogicalConnectionError.InvalidState(
          "Handshake can only be initiated in INITIALIZING state.",
          { context: { status: this.status, connectionId: this.connectionId } },
        ),
      );
    }
    this.status = ConnectionStatus.HANDSHAKING;
    this.logger.info("Initiating handshake.");
    const handshakeReq: HandshakeReqMessage = {
      type: NexusMessageType.HANDSHAKE_REQ,
      id: this.nextMessageId(),
      metadata: localEndpointMeta,
      capabilities: [PROVIDER_CATALOG_CAPABILITY],
      ...(assignmentMetadata && { assigns: assignmentMetadata }),
    };
    const sendResult = this.portProcessor.sendMessage(handshakeReq);
    if (sendResult.isErr()) {
      this.logger.error("Failed to send HANDSHAKE_REQ", sendResult.error);
      this.close();
      return err(sendResult.error);
    }

    this.outboundHandshakeId = handshakeReq.id;

    return ok(undefined);
  }

  /**
   * Forcibly closes the connection and notifies the manager.
   */
  public close(): void {
    // If already closing or closed, do nothing.
    if (
      this.status === ConnectionStatus.CLOSING ||
      this.status === ConnectionStatus.CLOSED
    ) {
      this.logger.debug(
        "Close called on an already closing/closed connection.",
      );
      return;
    }
    this.status = ConnectionStatus.CLOSING;
    this.logger.info("Forcibly closing connection.");
    const closeResult = this.portProcessor.close();
    if (closeResult.isErr()) {
      this.logger.error("Failed to close port processor", closeResult.error);
    }
    // Some transports do not synchronously emit onDisconnect from close().
    // handleDisconnect is idempotent and preserves the manager/Engine cleanup path.
    this.handleDisconnect();
  }

  /**
   * Sends a logical message over the connection's port.
   * @param message The `NexusMessage` to send.
   */
  public sendMessage(message: NexusMessage): Result<void, Error> {
    if (this.outboundReadyGate) {
      this.queuedOutboundMessages.push(message);
      return ok(undefined);
    }
    return this.sendImmediately(message);
  }

  private sendImmediately(message: NexusMessage): Result<void, Error> {
    const sendResult = this.portProcessor.sendMessage(message);
    if (sendResult.isErr()) {
      this.logger.error("Failed to send message", sendResult.error);
      this.close();
      return err(sendResult.error);
    }

    return ok(undefined);
  }

  // ===========================================================================
  // Handlers for PortProcessor Events
  // ===========================================================================

  /**
   * The entry point for all messages received from the underlying port.
   * This method drives the handshake state machine or forwards messages to L3.
   * @param message The logical message from the PortProcessor.
   */
  public safeHandleMessage(
    message: NexusMessage,
  ): Promise<Result<void, globalThis.Error>> {
    const messageHandling = this.shouldWaitForInboundOrdering(message)
      ? this.inboundOrderingGate.then(() =>
          this.handleMessageInTransportOrder(message),
        )
      : this.handleMessageInTransportOrder(message);

    if (this.shouldGateInboundOrdering(message)) {
      this.inboundOrderingGate = messageHandling.catch(() => undefined);
    }

    return Result.tryPromise({
      try: () => messageHandling,
      catch: (error) =>
        error instanceof globalThis.Error
          ? error
          : new globalThis.Error(String(error)),
    });
  }

  private shouldGateInboundOrdering(message: NexusMessage): boolean {
    return (
      this.status !== ConnectionStatus.CONNECTED ||
      message.type === NexusMessageType.IDENTITY_UPDATE
    );
  }

  private shouldWaitForInboundOrdering(message: NexusMessage): boolean {
    if (this.status !== ConnectionStatus.CONNECTED) {
      return true;
    }

    return !isConnectedResponseMessage(message);
  }

  private async handleMessageInTransportOrder(message: NexusMessage) {
    this.logger.debug("Received message from port.", message);
    // Identity update authorization can be async; later service messages must
    // wait so L3 observes the same identity order as the transport.
    if (message.type === NexusMessageType.IDENTITY_UPDATE) {
      await this.handleIdentityUpdate(message as IdentityUpdateMessage);
      return;
    }

    if (message.type === NexusMessageType.PROVIDER_AVAILABLE) {
      this.mergeRemoteProviders(
        (message as ProviderAvailableMessage).providers,
      );
      return;
    }

    // If we are initializing and receive a handshake request, we are the passive
    // side of the connection. We transition to HANDSHAKING to process it.
    if (
      this.status === ConnectionStatus.INITIALIZING &&
      message.type === NexusMessageType.HANDSHAKE_REQ
    ) {
      this.status = ConnectionStatus.HANDSHAKING;
    }

    if (this.status === ConnectionStatus.HANDSHAKING) {
      await this.processHandshakeMessage(message);
    } else if (this.status === ConnectionStatus.CONNECTED) {
      // Once connected, forward all other messages to the manager.
      await this.handlers.onMessage(message, this.connectionId);
    }
  }

  /**
   * The entry point for the disconnect event from the underlying port.
   */
  public handleDisconnect(): void {
    if (this.status === ConnectionStatus.CLOSED) return;

    this.logger.info("Port disconnected.");

    // Determine if the connection was fully established before this disconnect event.
    const wasConnected = this.wasEstablished;
    this.status = ConnectionStatus.CLOSED;

    // Always notify the manager. Provide identity only if the connection had been
    // successfully established. This prevents acting on a partial/unverified identity.
    this.handlers.onClosed({
      connectionId: this.connectionId,
      identity: wasConnected ? this._remoteIdentity : undefined,
    });
  }

  // ===========================================================================
  // Internal Handshake Logic
  // ===========================================================================

  private async handleIdentityUpdate(
    message: IdentityUpdateMessage,
  ): Promise<void> {
    if (this.status !== ConnectionStatus.CONNECTED || !this._remoteIdentity) {
      this.logger.warn(
        "Ignoring identity update received in non-connected state.",
        this.status,
      );
      // Ignore if not fully connected or identity is not yet known.
      return;
    }
    const oldIdentity = this._remoteIdentity;

    const newIdentity = { ...oldIdentity, ...message.updates };
    const isVerified = await this.handlers.verify(newIdentity, this.context);
    if (!isVerified) {
      this.logger.warn("Remote identity update verification failed. Closing.");
      this.rejectionError = new LogicalConnectionAuthDeniedError(
        "Identity update rejected by policy.",
      );
      this.close();
      return;
    }

    this._remoteIdentity = newIdentity;

    this.logger.debug("Updated remote identity and notifying manager.", {
      from: oldIdentity,
      to: newIdentity,
    });

    // Notify the ConnectionManager for service group updates
    this.handlers.onIdentityUpdated?.(
      this.connectionId,
      newIdentity,
      oldIdentity,
      this.context.connection,
    );
  }

  private async processHandshakeMessage(message: NexusMessage): Promise<void> {
    switch (message.type) {
      case NexusMessageType.HANDSHAKE_REQ:
        // Passive side: Received a request, must reply with an ACK.
        await this.handleHandshakeRequest(message as HandshakeReqMessage);
        break;

      case NexusMessageType.HANDSHAKE_ACK:
        // Active side: Received an ACK, can finalize the connection.
        await this.handleHandshakeAck(message as HandshakeAckMessage);
        break;

      case NexusMessageType.HANDSHAKE_READY:
        this.handleHandshakeReady(message as HandshakeReadyMessage);
        break;

      case NexusMessageType.HANDSHAKE_REJECT:
        // The other side rejected our connection.
        this.logger.warn("Handshake rejected by remote.");
        this.rejectionError = serializedErrorToError(message.error);
        this.close();
        break;

      default:
        this.logger.warn(
          `Ignoring message of type ${message.type} during handshake.`,
        );
      // Ignore other message types during handshake.
    }
  }

  private async handleHandshakeRequest(req: HandshakeReqMessage) {
    this.logger.debug("Handling HANDSHAKE_REQ.", req);
    if (
      this.inboundHandshakeId !== undefined &&
      this.inboundHandshakeId !== req.id
    ) {
      this.logger.warn("Ignoring HANDSHAKE_REQ for unknown handshake.", {
        requestId: req.id,
        inboundHandshakeId: this.inboundHandshakeId,
      });
      return;
    }
    if (!hasProviderCatalogCapability(req.capabilities)) {
      this.rejectProtocol(req.id);
      return;
    }
    this.inboundHandshakeId = req.id;

    const assignedMetadata = req.assigns as ContextMetaOf<M> | undefined;
    const remoteIdentity = req.metadata as ContextMetaOf<M>;

    this.logger.debug("Verifying remote identity.", remoteIdentity);
    const isVerified = await this.handlers.verify(remoteIdentity, this.context);
    if (!isVerified) {
      this.logger.warn("Remote identity verification failed. Closing.");
      // TODO: Send HANDSHAKE_REJECT
      const rejectResult = this.portProcessor.sendMessage({
        type: NexusMessageType.HANDSHAKE_REJECT,
        id: req.id,
        error: toSerializedError(
          new LogicalConnectionAuthDeniedError(
            "Connection rejected by policy.",
          ),
        ),
      });
      if (rejectResult.isErr()) {
        this.logger.error(
          "Failed to send HANDSHAKE_REJECT",
          rejectResult.error,
        );
      }
      setTimeout(() => this.close(), 0);
      return;
    }

    // If this is a "christening" call, the child adopts the assigned metadata
    // only after authorization has evaluated the pre-assignment local identity.
    if (assignedMetadata) {
      this.localEndpointMeta = assignedMetadata;
    }
    this._remoteIdentity = remoteIdentity;

    this.logger.debug(
      "Verification successful. Sending HANDSHAKE_ACK.",
      this.localEndpointMeta,
    );
    // Identity verified, send back our own *final* metadata in the ACK.
    // For a christened child, this is the metadata it was just given.
    const ack: HandshakeAckMessage = {
      type: NexusMessageType.HANDSHAKE_ACK,
      id: req.id,
      metadata: this.localEndpointMeta,
      capabilities: [PROVIDER_CATALOG_CAPABILITY],
      providers: this.localProviders(),
    };
    const ackResult = this.portProcessor.sendMessage(ack);
    if (ackResult.isErr()) {
      this.logger.error("Failed to send HANDSHAKE_ACK", ackResult.error);
      this.close();
      return;
    }

    this.acknowledgedHandshakeId = req.id;

    this.logger.info("ACK sent. Waiting for active side final confirmation.");
  }

  private async handleHandshakeAck(ack: HandshakeAckMessage) {
    this.logger.debug("Handling HANDSHAKE_ACK.", ack);
    if (ack.id !== this.outboundHandshakeId) {
      this.logger.warn("Ignoring HANDSHAKE_ACK for unknown handshake.", {
        ackId: ack.id,
        outboundHandshakeId: this.outboundHandshakeId,
      });
      return;
    }

    if (!hasProviderCatalogCapability(ack.capabilities)) {
      this.rejectProtocol(ack.id);
      return;
    }

    // We are the active side. We sent a REQ and got an ACK.
    // The ACK contains the server's user metadata.
    this._remoteIdentity = ack.metadata as ContextMetaOf<M>;

    const isVerified = await this.handlers.verify(
      this._remoteIdentity,
      this.context,
    );
    if (!isVerified) {
      this.logger.warn("Remote identity verification failed. Closing.");
      this.rejectionError = new LogicalConnectionAuthDeniedError(
        "Connection rejected by policy.",
      );
      this.sendHandshakeReject(ack.id, this.rejectionError);
      this.close();
      return;
    }

    this.mergeRemoteProviders(ack.providers ?? []);

    const readyResult = this.portProcessor.sendMessage({
      type: NexusMessageType.HANDSHAKE_READY,
      id: ack.id,
      capabilities: [PROVIDER_CATALOG_CAPABILITY],
      providers: this.localProviders(),
    });
    if (readyResult.isErr()) {
      this.logger.error("Failed to send HANDSHAKE_READY", readyResult.error);
      this.close();
      return;
    }

    this.outboundReadyGate = true;
    this.markReady(false);
    setTimeout(() => {
      this.flushOutboundReadyGate();
      this.notifyReady();
    }, 0);
  }

  private handleHandshakeReady(ready: HandshakeReadyMessage): void {
    if (!this._remoteIdentity) {
      this.logger.warn("Ignoring HANDSHAKE_READY without remote identity.");
      return;
    }

    if (ready.id !== this.acknowledgedHandshakeId) {
      this.logger.warn(
        "Ignoring HANDSHAKE_READY for unacknowledged handshake.",
        {
          readyId: ready.id,
          acknowledgedHandshakeId: this.acknowledgedHandshakeId,
        },
      );
      return;
    }

    if (!hasProviderCatalogCapability(ready.capabilities)) {
      this.rejectProtocol(ready.id);
      return;
    }

    this.mergeRemoteProviders(ready.providers ?? []);

    this.markReady();
  }

  private markReady(notify = true): void {
    if (!this._remoteIdentity) return;
    const published = this.flushQueuedProviders();
    if (published.isErr()) return;
    this.status = ConnectionStatus.CONNECTED;
    this.wasEstablished = true;
    this.logger.info("Handshake complete. Connection is now live.");
    if (notify) this.notifyReady();
  }

  private notifyReady(): void {
    if (!this.isReady() || !this._remoteIdentity) return;
    this.handlers.onVerified({
      connectionId: this.connectionId,
      identity: this._remoteIdentity,
    });
    this.notifyProviderCatalogUpdated();
  }

  private mergeRemoteProviders(providers: readonly string[]): void {
    for (const provider of providers) this.remoteProvidersSet.add(provider);
    if (this.isReady()) this.notifyProviderCatalogUpdated();
  }

  private notifyProviderCatalogUpdated(): void {
    this.handlers.onProviderCatalogUpdated?.(
      this.connectionId,
      Array.from(this.remoteProvidersSet),
    );
  }

  private flushQueuedProviders(): Result<void, Error> {
    const providers = Array.from(this.queuedProviders);
    this.queuedProviders.clear();
    if (providers.length === 0) return ok(undefined);
    const sent = this.portProcessor.sendMessage({
      type: NexusMessageType.PROVIDER_AVAILABLE,
      id: null,
      providers,
    });
    if (sent.isErr()) {
      this.close();
      return err(sent.error);
    }
    return ok(undefined);
  }

  private flushOutboundReadyGate(): void {
    this.outboundReadyGate = false;
    for (const message of this.queuedOutboundMessages.splice(0)) {
      const sent = this.sendImmediately(message);
      if (sent.isErr()) break;
    }
  }

  private rejectProtocol(id: HandshakeReadyMessage["id"]): void {
    this.rejectionError = new NexusProtocolIncompatibleError(
      `Peer does not support required capability ${PROVIDER_CATALOG_CAPABILITY}.`,
    );
    this.sendHandshakeReject(id, this.rejectionError);
    this.close();
  }

  private sendHandshakeReject(id: HandshakeReadyMessage["id"], error: Error) {
    const rejectResult = this.portProcessor.sendMessage({
      type: NexusMessageType.HANDSHAKE_REJECT,
      id,
      error: toSerializedError(error),
    });
    if (rejectResult.isErr()) {
      this.logger.error("Failed to send HANDSHAKE_REJECT", rejectResult.error);
    }
  }
}

function hasProviderCatalogCapability(
  capabilities: readonly string[] | undefined,
): boolean {
  return capabilities?.includes(PROVIDER_CATALOG_CAPABILITY) ?? false;
}

function serializedErrorToError(input: {
  message?: string;
  code?: string;
  name?: string;
  cause?: import("../types/message").SerializedError;
}): Error {
  if (input.code === "E_PROTOCOL_INCOMPATIBLE") {
    return new NexusProtocolIncompatibleError(
      input.message ?? "",
      {},
      input.cause,
    );
  }
  const error = new Error(input.message ?? "Handshake rejected by remote.");
  error.name = input.name ?? "HandshakeRejectedError";
  if (input.code) {
    (error as Error & { code?: string }).code = input.code;
  }
  return error;
}

function isConnectedResponseMessage(message: NexusMessage): boolean {
  return (
    message.type === NexusMessageType.RES ||
    message.type === NexusMessageType.ERR ||
    message.type === NexusMessageType.BATCH_RES
  );
}
