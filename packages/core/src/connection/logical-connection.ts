import { PortProcessor } from "../transport/port-processor";
import type {
  UserMetadata,
  PlatformMetadata,
  ConnectionContext,
} from "../types/identity";
import type {
  NexusMessage,
  HandshakeReqMessage,
  HandshakeAckMessage,
  HandshakeReadyMessage,
  IdentityUpdateMessage,
} from "../types/message";
import { NexusMessageType } from "../types/message";
import { ConnectionStatus, type LogicalConnectionHandlers } from "./types";
import { Logger } from "@/logger";
import { toSerializedError } from "@/utils/error";
import { ResultAsync, err, ok, type Result } from "neverthrow";

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
export class LogicalConnection<
  U extends UserMetadata,
  P extends PlatformMetadata,
> {
  public readonly connectionId: string;
  private status: ConnectionStatus = ConnectionStatus.INITIALIZING;
  public readonly context: ConnectionContext<P>;
  private _remoteIdentity?: U;
  private wasEstablished = false;
  private rejectionError?: Error;
  private outboundHandshakeId?: HandshakeReqMessage["id"];
  private acknowledgedHandshakeId?: HandshakeReqMessage["id"];
  private inboundOrderingGate: Promise<void> = Promise.resolve();
  private readonly logger: Logger;
  private readonly nextMessageId: () => number;

  // This connection's own user metadata. It can be reassigned during a
  // "christening" handshake if this is a child context.
  private localUserMetadata: U;

  constructor(
    // Dependencies injected by ConnectionManager
    private readonly portProcessor: PortProcessor.Context,
    private readonly handlers: LogicalConnectionHandlers<U, P>,
    // Initial state
    config: {
      connectionId: string;
      localUserMetadata: U;
      // For ALL connections, this is the metadata of the remote endpoint discovered by L1.
      platformMetadata: P;
      nextMessageId: () => number;
    },
  ) {
    this.connectionId = config.connectionId;
    this.localUserMetadata = config.localUserMetadata;
    this.nextMessageId = config.nextMessageId;
    this.context = {
      platform: config.platformMetadata,
      connectionId: this.connectionId,
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

  public get remoteIdentity(): U | undefined {
    return this._remoteIdentity;
  }

  public get localIdentity(): U {
    return this.localUserMetadata;
  }

  public updateLocalIdentity(updates: Partial<U>): void {
    this.localUserMetadata = { ...this.localUserMetadata, ...updates };
  }

  public get handshakeRejectionError(): Error | undefined {
    return this.rejectionError;
  }

  /**
   * Starts the handshake process from the active/client side.
   * @param localUserMetadata The user metadata of the local endpoint.
   * @param assignmentMetadata Optional metadata to be assigned to the remote (child) endpoint.
   */
  public initiateHandshake(
    localUserMetadata: U,
    assignmentMetadata?: U,
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
      metadata: localUserMetadata,
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
    // The onDisconnect handler is now the single source of truth for all cleanup.
  }

  /**
   * Sends a logical message over the connection's port.
   * @param message The `NexusMessage` to send.
   */
  public sendMessage(message: NexusMessage): Result<void, Error> {
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
  ): ResultAsync<void, globalThis.Error> {
    const orderingGate = this.shouldWaitForInboundOrdering(message)
      ? this.inboundOrderingGate
      : Promise.resolve();
    const messageHandling = orderingGate.then(() =>
      this.handleMessageInTransportOrder(message),
    );

    if (this.shouldGateInboundOrdering(message)) {
      this.inboundOrderingGate = messageHandling.catch(() => undefined);
    }

    return ResultAsync.fromPromise(messageHandling, (error) =>
      error instanceof globalThis.Error
        ? error
        : new globalThis.Error(String(error)),
    );
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
    const assignedMetadata = req.assigns as U | undefined;
    const remoteIdentity = req.metadata as U;

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
      this.localUserMetadata = assignedMetadata;
    }
    this._remoteIdentity = remoteIdentity;

    this.logger.debug(
      "Verification successful. Sending HANDSHAKE_ACK.",
      this.localUserMetadata,
    );
    // Identity verified, send back our own *final* metadata in the ACK.
    // For a christened child, this is the metadata it was just given.
    const ack: HandshakeAckMessage = {
      type: NexusMessageType.HANDSHAKE_ACK,
      id: req.id,
      metadata: this.localUserMetadata,
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

    // We are the active side. We sent a REQ and got an ACK.
    // The ACK contains the server's user metadata.
    this._remoteIdentity = ack.metadata as U;

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

    const readyResult = this.portProcessor.sendMessage({
      type: NexusMessageType.HANDSHAKE_READY,
      id: ack.id,
    });
    if (readyResult.isErr()) {
      this.logger.error("Failed to send HANDSHAKE_READY", readyResult.error);
      this.close();
      return;
    }

    // Let the passive side process HANDSHAKE_READY before callers can use the
    // active connection returned from resolution.
    setTimeout(() => {
      if (
        this.status !== ConnectionStatus.HANDSHAKING ||
        !this._remoteIdentity
      ) {
        return;
      }
      this.status = ConnectionStatus.CONNECTED;
      this.wasEstablished = true;
      this.logger.info("Handshake complete (active). Connection is now live.");
      this.handlers.onVerified({
        connectionId: this.connectionId,
        identity: this._remoteIdentity,
      });
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

    this.status = ConnectionStatus.CONNECTED;
    this.wasEstablished = true;
    this.logger.info("Handshake complete (passive). Connection is now live.");
    this.handlers.onVerified({
      connectionId: this.connectionId,
      identity: this._remoteIdentity,
    });
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

function serializedErrorToError(input: {
  message?: string;
  code?: string;
  name?: string;
}): Error {
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
