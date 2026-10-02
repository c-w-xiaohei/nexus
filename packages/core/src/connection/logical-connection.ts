import type {
  PortProcessor,
  PortProcessorHandlers,
} from "../transport/port-processor";
import type {
  AdapterModel,
  ConnectionMetaOf,
  ContextMetaOf,
} from "../types/adapter-model";
import type { ConnectionContext } from "../types/identity";
import {
  NexusMessageType,
  type NexusMessage,
  type HandshakeReqMessage,
  type SerializedError,
} from "../types/message";
import type { LogicalConnectionHandlers } from "./types";
import { Logger } from "@/logger";
import { createEvtChannel } from "@/utils/evt-channel";
import { toSerializedError } from "@/utils/error";
import { NexusProtocolError, NexusProtocolIncompatibleError } from "@/errors";
import { isDeterminateTransferError } from "@/transport/port-processor";
import { Result } from "better-result";
import { delay } from "es-toolkit/promise";
import type { ResolvedTransportConfig } from "../transport/transport-config";
import { isChunkControl } from "../transport/chunking";
import { DEFAULT_TRANSPORT_LIMITS } from "../transport/transport-config";
import type { ByteReservationLease } from "../service/payload/byte-reservation";

const { ok, err } = Result;
const PROVIDER_CATALOG_CAPABILITY = "provider-catalog-v1";
const RESOURCE_SCOPE_CAPABILITY = "resource-scope-v1";

/** Construction inputs for an attached, not-yet-handshaken session. */
export interface ConnectionConfig<M extends AdapterModel> {
  connectionId: string;
  localEndpointMeta: ContextMetaOf<M>;
  connectionMeta: ConnectionMetaOf<M>;
  direction: "incoming" | "outgoing";
  nextMessageId: () => number;
  localProviders?: () => readonly string[];
  transportConfig?: ResolvedTransportConfig;
  bootstrapJson?: boolean;
}

type AcquiredPort<M extends AdapterModel> = Result<
  {
    portProcessor: PortProcessor.Context;
    connectionMeta: ConnectionMetaOf<M>;
  },
  unknown
>;

/** Startup inputs shared by accepted ports and active dials. */
export interface ConnectionOpenOptions<M extends AdapterModel> extends Omit<
  ConnectionConfig<M>,
  "connectionMeta" | "localEndpointMeta"
> {
  /** Transfer a processor to this attempt, even if acquisition finishes after timeout. */
  acquire(
    handlers: PortProcessorHandlers,
  ): AcquiredPort<M> | Promise<AcquiredPort<M>>;
  /** Read the latest identity at attachment, not at dial start. */
  localIdentity(): ContextMetaOf<M>;
  /** Deadline covering acquisition, authorization and publication, in milliseconds. */
  timeoutMs: number;
  /** Identity offered to the passive peer, applied only after authorization. */
  assignmentMetadata?: ContextMetaOf<M>;
}

class HandshakeFailedError extends Error {
  readonly code = "E_HANDSHAKE_FAILED";
}

class LogicalConnectionAuthDeniedError extends Error {
  readonly code = "E_AUTH_CONNECT_DENIED";

  /** Retain the policy denial as a handshake-specific failure. */
  constructor(message: string) {
    super(message);
    this.name = "LogicalConnectionAuthDeniedError";
  }
}

class LogicalConnectionInvalidStateError extends Error {
  readonly code = "E_USAGE_INVALID";

  /** Attach the rejected session state to a caller-facing misuse error. */
  constructor(
    message: string,
    readonly context: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LogicalConnectionInvalidStateError";
  }
}

type SessionState =
  | {
      phase: "handshaking";
      expected:
        | NexusMessageType.HANDSHAKE_REQ
        | NexusMessageType.HANDSHAKE_ACK
        | NexusMessageType.HANDSHAKE_READY
        | null;
      id: HandshakeReqMessage["id"] | null;
    }
  | {
      phase: "activating" | "publishing";
    }
  | { phase: "ready" }
  | { phase: "closed"; reason: "local" | "remote" | "protocol" };

/**
 * One session owns its protocol state, authorization barrier and transport.
 * Handshake correlation is an expected packet plus ID; publication owns its FIFO.
 * State object identity prevents asynchronous work from committing after shutdown.
 * The owner supplies policy and registers lifecycle transitions, but never drives
 * protocol state or reconstructs authorization context from external indexes.
 */
export class LogicalConnection<M extends AdapterModel> {
  // ===== Immutable Identity And Dependencies =====

  /** Stable session identifier, not a reusable remote endpoint address. */
  public readonly connectionId: string;
  /** Physical direction for policy; an outgoing port can still receive the first REQ. */
  public readonly direction: "incoming" | "outgoing";
  /** Shallow frozen snapshot of local adapter facts. */
  public readonly context: ConnectionContext<ConnectionMetaOf<M>>;
  private readonly logger: Logger;
  private readonly nextMessageId: () => number;
  private readonly localProviders: () => readonly string[];
  private readonly transportConfig: ResolvedTransportConfig;
  private readonly bootstrapJson: boolean;
  private peerTransportOffer?: HandshakeReqMessage["transport"];
  private readonly allowImplicitLegacyTransport: boolean;
  private queuedMessages: {
    message: NexusMessage;
    resolve: (result: Result<void, Error>) => void;
    options?: { lease?: ByteReservationLease; signal?: AbortSignal };
  }[] = [];
  private drainingQueuedMessages = false;
  private publicationWaiters = new Set<() => void>();
  private activationPending = false;
  private activationIngressBytes = 0;
  private activationIngress: {
    message: NexusMessage;
    resolve: (result: Result<void, Error>) => void;
  }[] = [];
  private static readonly MAX_ACTIVATION_INGRESS_ITEMS = 256;
  private static readonly MAX_ACTIVATION_INGRESS_BYTES = 1024 * 1024;
  private static readonly MAX_QUEUED_MESSAGES = 1024;

  // ===== Session Lifecycle =====

  // expected=null reserves a correlated attempt while its policy is pending.
  private state: SessionState = {
    phase: "handshaking",
    expected: NexusMessageType.HANDSHAKE_REQ,
    id: null,
  };
  private authorization: Promise<void> = Promise.resolve();
  private readonly lifetime = new AbortController();
  private opening?: (result: Result<void, Error>) => void;

  // ===== Identity And Catalog =====

  private localEndpointMeta: ContextMetaOf<M>;
  private peerIdentity?: ContextMetaOf<M>;
  private rejection?: Error;
  private readonly providers = new Set<string>();
  private readonly pendingProviders = new Set<string>();
  private readonly pendingRemovedProviders = new Set<string>();

  // ===== Notification Capabilities =====

  private readonly identityChanel =
    createEvtChannel<Readonly<ContextMetaOf<M>>>();
  /** Accepted identity changes only; current state is available through remoteIdentity. */
  public readonly subscribeIdentity = this.identityChanel[0];

  private readonly disconnectedChanel = createEvtChannel<
    "local" | "remote" | "protocol"
  >();
  /** Closure event after owner cleanup; current terminal state is available through disconnectReason. */
  public readonly onDisconnected = this.disconnectedChanel[0];

  /** Construct an attached session without starting it; open also owns acquisition and timeout. */
  constructor(
    private readonly port: PortProcessor.Context,
    private readonly handlers: LogicalConnectionHandlers<M>,
    config: ConnectionConfig<M>,
  ) {
    this.connectionId = config.connectionId;
    this.direction = config.direction;
    this.localEndpointMeta = config.localEndpointMeta;
    this.nextMessageId = config.nextMessageId;
    this.localProviders = config.localProviders ?? (() => []);
    this.transportConfig = config.transportConfig ?? {
      binaryPackets: false,
      ...DEFAULT_TRANSPORT_LIMITS,
    };
    this.bootstrapJson = config.bootstrapJson === true;
    this.allowImplicitLegacyTransport = config.transportConfig === undefined;
    this.context = {
      connectionId: this.connectionId,
      connection: Object.freeze({ ...config.connectionMeta }),
    };
    this.logger = new Logger(`L2 --- LogicalConnection<${this.connectionId}>`);
  }

  /** Report protocol readiness, including the short publication-drain interval. */
  public isReady(): boolean {
    return this.state.phase === "publishing" || this.state.phase === "ready";
  }

  /** Return the terminal cause retained after this session closes. */
  public get disconnectReason(): "local" | "remote" | "protocol" | undefined {
    return this.state.phase === "closed" ? this.state.reason : undefined;
  }

  /** Last authorized peer identity, also retained after shutdown. */
  public get remoteIdentity(): ContextMetaOf<M> | undefined {
    return this.peerIdentity;
  }
  /** This session's current identity, including an authorized christening assignment. */
  public get localIdentity(): ContextMetaOf<M> {
    return this.localEndpointMeta;
  }
  /** Protocol/authorization rejection retained for diagnostics and failed acquisition. */
  public get handshakeRejectionError(): Error | undefined {
    return this.rejection;
  }
  /** Detached snapshot of the monotonically accumulated peer catalog. */
  public get remoteProviders(): ReadonlySet<string> {
    return new Set(this.providers);
  }
  /** Catalog membership does not itself imply readiness. */
  public hasProvider(provider: string): boolean {
    return this.providers.has(provider);
  }

  // ===== Public Entry And Acquisition =====

  /**
   * Acquire a processor and establish one session through handshake publication.
   * Used for both accepted incoming ports and actively dialed outgoing ports.
   *
   * Startup proceeds in this order:
   * 1. Start the deadline and call `config.acquire` with the session's transport
   *    handlers. Buffer messages received before a connection can handle them.
   * 2. Read `config.localIdentity()` at attachment time, construct the connection,
   *    and call `handlers.onAttached` so the owner can register the session before
   *    any buffered packet reaches authorization or protocol processing.
   * 3. Submit the buffered messages in arrival order, including messages emitted
   *    synchronously during `onAttached`, then switch to direct reception.
   *    Initiate a handshake only for an outgoing port without a buffered REQ;
   *    an early peer REQ selects the passive role regardless of port direction.
   * 4. Complete authorization and the handshake, flush pending provider deltas
   *    and queued sends, and register through `handlers.onReady`. Only then can opening
   *    resolve successfully.
   *
   * @remarks
   * If acquisition returns a Result synchronously, attachment and `onAttached`
   * also run before this method returns; no extra microtask is introduced for
   * accepted ports. The returned Promise still waits for handshake publication.
   * On the active side, `isReady()` becomes true one timer turn before manager
   * publication, so it is not equivalent to successful completion of `open()`.
   *
   * The attempt owns every successfully acquired processor until it transfers
   * ownership to the connection. Startup failure closes any owned resource and
   * clears the deadline. The deadline covers acquisition, authorization, and
   * publication, and settles even if native acquisition never resolves. It does
   * not cancel native acquisition: a processor arriving after failure is closed
   * without registration or handshaking. After success, the connection owns its
   * lifetime; a later disconnect does not change the already settled result.
   *
   * @param config - Acquisition, identity, physical direction, and startup deadline.
   * @param handlers - Owner integration and authorization callbacks. `onAttached`
   * registers an unverified session; `onReady` registers a routable one. Both are
   * synchronous Result-returning hooks, not best-effort observer notifications.
   * @returns Ok with the connection after `onReady` returns Ok, or
   * Err for acquisition, attachment, handshake, or publication failure. Original
   * acquisition and callback errors are retained. Timeout uses
   * `E_HANDSHAKE_FAILED`; premature closure preserves a known handshake rejection
   * or otherwise uses `E_HANDSHAKE_FAILED`.
   */
  static open<M extends AdapterModel>(
    config: ConnectionOpenOptions<M>,
    handlers: LogicalConnectionHandlers<M>,
  ): Promise<Result<LogicalConnection<M>, unknown>> {
    return new Promise((resolve) => {
      // Ownership and reception are separate: the session takes over the port
      // while reception stays buffered through manager registration.
      let connection: LogicalConnection<M> | undefined;
      let messages: NexusMessage[] | undefined = [];
      const settle = (result: Result<LogicalConnection<M>, unknown>) => {
        clearTimeout(deadline);
        resolve(result);
        // Resolve the original failure before close can reenter settlement.
        if (result.isErr()) {
          messages = undefined;
          connection?.close();
        }
      };
      const fail = (error: unknown) => settle(err(error));
      // This deadline must finish even if native acquisition never resolves.
      // Promise.race/withTimeout alone would leave late processors unclaimed.
      const deadline = setTimeout(
        () =>
          fail(
            new HandshakeFailedError(
              `Connection ${config.connectionId} timed out during handshake.`,
            ),
          ),
        config.timeoutMs,
      );
      const portHandlers: PortProcessorHandlers = {
        onLogicalMessage: (message) => {
          if (messages) messages.push(message);
          else return connection?.receive(message);
        },
        onDisconnect: () => {
          if (messages)
            fail(
              new HandshakeFailedError(
                `Connection ${config.connectionId} closed before attachment.`,
              ),
            );
          else connection?.handleDisconnect();
        },
        onProtocolError: (error) => {
          if (messages) fail(error);
          else connection?.close("protocol");
        },
      };
      const attach = (acquired: AcquiredPort<M>) => {
        if (acquired.isErr()) return fail(acquired.error);
        const { portProcessor, connectionMeta } = acquired.value;
        try {
          if (!messages) return;
          const attached = new LogicalConnection(portProcessor, handlers, {
            ...config,
            connectionMeta,
            localEndpointMeta: config.localIdentity(),
          });
          // Getters may disconnect during construction; only live attempts take over.
          if (!messages) return;
          connection = attached;
          attached.opening = (result) => settle(result.map(() => attached));
          // Install cleanup before owner registration, which may fail or close.
          const registered = handlers.onAttached(attached);
          if (registered.isErr()) return fail(registered.error);
          if (!messages) return;

          // Preserve the entire replay prefix, including observer-emitted packets.
          // An early REQ chooses the passive role even on an outgoing native port.
          const passive = messages.some(
            (message) => message.type === NexusMessageType.HANDSHAKE_REQ,
          );
          for (const message of messages) void attached.receive(message);
          messages = undefined;
          if (config.direction === "outgoing" && !passive) {
            const started = attached.initiateHandshake(
              config.assignmentMetadata,
            );
            void started.then((result) => {
              if (result.isErr()) fail(result.error);
            });
          }
        } catch (error) {
          // Preserve construction/observer errors before cleanup can emit disconnect.
          fail(error);
        } finally {
          // Until ownership transfers this attempt still owns cleanup, including
          // a successful acquisition arriving after timeout or early disconnect.
          if (connection?.port !== portProcessor)
            portProcessor.close().match({
              ok: () => undefined,
              err: (error) =>
                console.error(
                  "Nexus DEV: failed to close unattached port",
                  error,
                ),
            });
        }
      };
      // Do not introduce a microtask before accepted ports attach to the manager.
      try {
        const acquired = config.acquire(portHandlers);
        if (acquired instanceof Promise) void acquired.then(attach).catch(fail);
        else attach(acquired);
      } catch (error) {
        fail(error);
      }
    });
  }

  // ===== Lifetime =====

  /** Close locally or for a protocol failure, settling startup before notifying the owner. */
  public close(reason: "local" | "protocol" = "local"): void {
    this.stop(true, reason);
  }
  /** Finish a native disconnect without asking the processor to close again. */
  public handleDisconnect(): void {
    this.stop(false, "remote");
  }

  // ===== Public Transport =====

  /**
   * Send or queue in FIFO order. Ok means local acceptance, not remote delivery.
   * Cancellation and determinate transfer rejection leave the ready session
   * usable; other processor failures close it before returning.
   */
  public sendMessage(
    message: NexusMessage,
    options?: { lease?: ByteReservationLease; signal?: AbortSignal },
  ): Promise<Result<void, Error>> {
    if (this.state.phase === "closed")
      return Promise.resolve(
        err(
          new LogicalConnectionInvalidStateError(
            "Cannot send on a closed connection.",
            { connectionId: this.connectionId },
          ),
        ),
      );
    if (this.queuedMessages.length >= LogicalConnection.MAX_QUEUED_MESSAGES) {
      const error = new NexusProtocolError(
        "Connection outbound queue capacity exceeded",
        { code: "E_TRANSPORT_CAPACITY" },
      );
      this.close("protocol");
      return Promise.resolve(err(error));
    }
    const sent = new Promise<Result<void, Error>>((resolve) => {
      this.queuedMessages.push({ message, resolve, options });
    });
    if (this.state.phase === "ready") void this.drainQueuedMessages();
    return sent;
  }

  /** Serialize handshake authorization while allowing independent application work to overlap. */
  public safeHandleMessage(
    message: NexusMessage,
  ): Promise<Result<void, Error>> {
    if (this.activationPending && !isChunkControl(message)) {
      let messageBytes: number;
      try {
        messageBytes = new TextEncoder().encode(
          JSON.stringify(message),
        ).byteLength;
      } catch (error) {
        this.close("protocol");
        return Promise.resolve(err(asError(error)));
      }
      this.activationIngressBytes += messageBytes;
      if (
        this.activationIngress.length >=
          LogicalConnection.MAX_ACTIVATION_INGRESS_ITEMS ||
        this.activationIngressBytes >
          LogicalConnection.MAX_ACTIVATION_INGRESS_BYTES
      ) {
        this.close("protocol");
        return Promise.resolve(
          err(
            new NexusProtocolError("READY activation ingress queue exceeded"),
          ),
        );
      }
      return new Promise((resolve) => {
        this.activationIngress.push({ message, resolve });
      });
    }
    const handshaking = this.state.phase === "handshaking";
    const response =
      message.type === NexusMessageType.RES ||
      message.type === NexusMessageType.ERR ||
      message.type === NexusMessageType.BATCH_RES;
    // Only handshake and identity work extends the authorization tail. Application
    // calls wait independently; post-handshake responses can bypass authorization
    // for reverse RPC, but dispatch still makes them wait for publication.
    const handling =
      handshaking || !response
        ? this.authorization.then(() => this.dispatch(message))
        : this.dispatch(message);
    if (handshaking || message.type === NexusMessageType.IDENTITY_UPDATE)
      this.authorization = handling.catch(() => undefined);
    return Result.tryPromise({ try: () => handling, catch: asError });
  }

  // ===== Public Protocol =====

  /**
   * Low-level startup for an already attached session. Advertises this object's
   * current identity, optionally assigning the passive peer's identity. Manager
   * uses open instead, which also owns acquisition, reception and the deadline.
   */
  public initiateHandshake(
    assignmentMetadata?: ContextMetaOf<M>,
  ): Promise<Result<void, Error>> {
    if (
      this.state.phase !== "handshaking" ||
      this.state.expected !== NexusMessageType.HANDSHAKE_REQ
    )
      return Promise.resolve(
        err(
          new LogicalConnectionInvalidStateError(
            "Handshake can only be initiated in INITIALIZING state.",
            {
              phase: this.state.phase,
              connectionId: this.connectionId,
            },
          ),
        ),
      );
    const id = this.nextMessageId();
    this.state = {
      phase: "handshaking",
      expected: NexusMessageType.HANDSHAKE_ACK,
      id,
    };
    return this.write({
      type: NexusMessageType.HANDSHAKE_REQ,
      id,
      metadata: this.localEndpointMeta,
      capabilities: [PROVIDER_CATALOG_CAPABILITY, RESOURCE_SCOPE_CAPABILITY],
      transport: this.localTransportOffer(),
      ...(assignmentMetadata && { assigns: assignmentMetadata }),
    });
  }

  // ===== Public Identity And Catalog =====

  /** Apply local identity changes to this session without broadcasting them. */
  public updateLocalIdentity(updates: Partial<ContextMetaOf<M>>): void {
    this.localEndpointMeta = { ...this.localEndpointMeta, ...updates };
  }

  /** Queue additions before readiness, otherwise send them. Send failure closes the session. */
  public async publishProviders(
    providers: readonly string[],
  ): Promise<Result<void, Error>> {
    if (this.state.phase === "closed") return ok(undefined);
    for (const provider of providers) {
      this.pendingRemovedProviders.delete(provider);
      this.pendingProviders.add(provider);
    }
    return this.isReady() ? this.flushProviders() : ok(undefined);
  }

  // ===== Private Lifetime =====

  public async removeProviders(
    providers: readonly string[],
  ): Promise<Result<void, Error>> {
    if (this.state.phase === "closed") return ok(undefined);
    for (const provider of providers) {
      this.pendingProviders.delete(provider);
      this.pendingRemovedProviders.add(provider);
    }
    return this.isReady() ? this.flushProviders() : ok(undefined);
  }

  /** Transition once to closed, cancel work, release queues, and notify the owner. */
  private stop(
    closePort: boolean,
    reason: "local" | "remote" | "protocol",
  ): void {
    const state = this.state;
    if (state.phase === "closed") return;
    // Reentrant close/disconnect sees the terminal state before any native callback.
    this.state = { phase: "closed", reason };
    this.activationPending = false;
    this.activationIngressBytes = 0;
    for (const pending of this.activationIngress.splice(0))
      pending.resolve(
        err(
          new LogicalConnectionInvalidStateError(
            "Connection closed before READY activation",
            { connectionId: this.connectionId },
          ),
        ),
      );
    for (const resolve of this.publicationWaiters) resolve();
    this.publicationWaiters.clear();
    this.lifetime.abort();
    for (const queued of this.queuedMessages.splice(0))
      queued.resolve(
        err(
          new LogicalConnectionInvalidStateError(
            "Connection closed before queued send",
            { connectionId: this.connectionId },
          ),
        ),
      );
    this.pendingProviders.clear();
    this.pendingRemovedProviders.clear();
    if (closePort) {
      const closed = this.port.close();
      if (closed.isErr())
        this.logger.error("Failed to close port processor", closed.error);
    }
    this.settleOpening(
      err(
        this.rejection ??
          new HandshakeFailedError(
            `Connection ${this.connectionId} closed before publication.`,
          ),
      ),
    );
    const cleaned = Result.try({
      try: () => this.handlers.onClosed(this),
      catch: asError,
    });
    this.identityChanel[1].clear();
    const notified = this.disconnectedChanel[1].safeEmit(reason);
    this.disconnectedChanel[1].clear();
    cleaned.tapError((error) =>
      this.logger.error("Session owner failed to handle closure", error),
    );
    notified.tapError((errors) =>
      this.logger.error("Disconnect observers failed", errors),
    );
  }

  /** Resolve the one startup waiter and prevent later lifecycle transitions from reusing it. */
  private settleOpening(result: Result<void, Error>): void {
    const notify = this.opening;
    this.opening = undefined;
    notify?.(result);
  }

  // ===== Private Transport =====

  /** Write one packet and close the session when the processor rejects it. */
  private async write(message: NexusMessage): Promise<Result<void, Error>> {
    const sent = await Promise.resolve(this.port.sendMessage(message));
    if (sent.isErr()) this.close("protocol");
    return sent;
  }

  /** Start managed inbound processing and turn failures into protocol closure. */
  private receive(message: NexusMessage): Promise<void> {
    return this.safeHandleMessage(message).then((result) => {
      if (result.isErr()) {
        this.logger.error("Failed to process incoming message", result.error);
        this.close("protocol");
      }
    });
  }

  // ===== Private Protocol =====

  /** Consume protocol packets or forward published application packets in order. */
  private async dispatch(message: NexusMessage): Promise<void> {
    if (
      this.allowImplicitLegacyTransport &&
      (message.type === NexusMessageType.HANDSHAKE_REQ ||
        message.type === NexusMessageType.HANDSHAKE_ACK ||
        message.type === NexusMessageType.HANDSHAKE_READY) &&
      !message.transport
    ) {
      const offer = this.localTransportOffer();
      message =
        message.type === NexusMessageType.HANDSHAKE_READY
          ? {
              ...message,
              transport: {
                initiatorReceive: offer.receive,
                responderReceive: offer.receive,
                selectedPacketMode: "json",
              },
            }
          : message.type === NexusMessageType.HANDSHAKE_REQ ||
              message.type === NexusMessageType.HANDSHAKE_ACK
            ? { ...message, transport: offer }
            : message;
    }
    const state = this.state;
    if (state.phase === "closed") return;
    // Catalogs and identity updates have their own admission rules. Application
    // traffic also waits for manager publication, including response bypasses.
    switch (message.type) {
      case NexusMessageType.PROVIDER_AVAILABLE:
        // Deltas may arrive before READY; readiness only controls notification.
        this.addProviders(message.providers);
        for (const provider of message.removed ?? [])
          this.providers.delete(provider);
        return;
      case NexusMessageType.IDENTITY_UPDATE: {
        if (!this.isReady() || !this.peerIdentity) return;
        const identity = { ...this.peerIdentity, ...message.updates };
        const allowed = await this.authorize(identity);
        // Publication may advance while policy waits; shutdown may not be crossed.
        if (this.state.phase === "closed") return;
        if (!allowed) {
          this.rejection = new LogicalConnectionAuthDeniedError(
            "Identity update rejected by policy.",
          );
          this.close("protocol");
          return;
        }
        const nextIdentity = Object.freeze({ ...identity });
        this.peerIdentity = nextIdentity;
        this.identityChanel[1]
          .safeEmit(nextIdentity)
          .tapError((errors) =>
            this.logger.error("Identity observers failed", errors),
          );
        return;
      }
      case NexusMessageType.HANDSHAKE_REJECT:
        if (state.phase === "handshaking" && message.id === state.id) {
          this.rejection = serializedErrorToError(message.error);
          this.close("protocol");
        }
        return;
      case NexusMessageType.HANDSHAKE_REQ:
      case NexusMessageType.HANDSHAKE_ACK:
      case NexusMessageType.HANDSHAKE_READY:
        break;
      default:
        if (state.phase === "activating" || state.phase === "publishing")
          await new Promise<void>((resolve) => {
            this.publicationWaiters.add(resolve);
          });
        if (this.state.phase === "ready")
          await this.handlers.onMessage(this, message);
        return;
    }

    // A single expected-packet check rejects wrong roles, wrong IDs and replays.
    if (
      state.phase !== "handshaking" ||
      state.expected !== message.type ||
      (state.id !== null && state.id !== message.id)
    )
      return;
    if (
      (message.type === NexusMessageType.HANDSHAKE_REQ ||
        message.type === NexusMessageType.HANDSHAKE_ACK) &&
      !message.transport
    ) {
      this.reject(
        message.id,
        new NexusProtocolIncompatibleError(
          "Peer does not advertise the required transport protocol.",
        ),
        message.type === NexusMessageType.HANDSHAKE_REQ,
      );
      return;
    }
    if (
      !message.capabilities?.includes(PROVIDER_CATALOG_CAPABILITY) ||
      !message.capabilities.includes(RESOURCE_SCOPE_CAPABILITY)
    ) {
      this.reject(
        message.id,
        new NexusProtocolIncompatibleError(
          `Peer must support ${PROVIDER_CATALOG_CAPABILITY} and ${RESOURCE_SCOPE_CAPABILITY}.`,
        ),
        message.type === NexusMessageType.HANDSHAKE_REQ,
      );
      return;
    }
    if (message.type === NexusMessageType.HANDSHAKE_READY) {
      const local = this.localTransportOffer();
      const peer = this.peerTransportOffer;
      const expectedMode = this.selectPacketMode(peer?.packetModes ?? ["json"]);
      if (
        !peer ||
        message.transport.initiatorReceive.maxFrameBytes !==
          peer.receive.maxFrameBytes ||
        message.transport.initiatorReceive.maxMessageBytes !==
          peer.receive.maxMessageBytes ||
        message.transport.responderReceive.maxFrameBytes !==
          local.receive.maxFrameBytes ||
        message.transport.responderReceive.maxMessageBytes !==
          local.receive.maxMessageBytes ||
        message.transport.selectedPacketMode !== expectedMode
      ) {
        this.reject(
          message.id,
          new NexusProtocolIncompatibleError(
            "Peer READY does not match negotiated transport parameters.",
          ),
        );
        return;
      }
      const activated = this.port.activateSession?.({
        maxFrameBytes: Math.min(
          local.receive.maxFrameBytes,
          peer!.receive.maxFrameBytes,
        ),
        maxMessageBytes: Math.min(
          local.receive.maxMessageBytes,
          peer!.receive.maxMessageBytes,
        ),
        packetMode: message.transport.selectedPacketMode,
      });
      if (activated?.isErr()) {
        this.reject(message.id, activated.error);
        return;
      }
      this.addProviders(message.providers ?? []);
      await this.publish(false);
      return;
    }

    const verifying: SessionState = {
      phase: "handshaking",
      expected: null,
      id: message.id,
    };
    // No next packet is admissible until this identity has been authorized.
    this.state = verifying;
    const identity = message.metadata as ContextMetaOf<M>;
    const allowed = await this.authorize(identity);
    if (this.state !== verifying) return;
    if (!allowed) {
      this.reject(
        message.id,
        new LogicalConnectionAuthDeniedError("Connection rejected by policy."),
        message.type === NexusMessageType.HANDSHAKE_REQ,
      );
      return;
    }
    this.peerIdentity = Object.freeze({ ...identity });
    this.peerTransportOffer = message.transport;
    const localOffer = this.localTransportOffer();
    const peerModes = message.transport.packetModes;
    const fixedLocalMode =
      !this.bootstrapJson && localOffer.packetModes.length === 1;
    if (
      message.transport.version !== 1 ||
      !peerModes.length ||
      (fixedLocalMode &&
        (peerModes.length !== 1 || peerModes[0] !== localOffer.packetModes[0]))
    ) {
      this.reject(
        message.id,
        new NexusProtocolIncompatibleError(
          "Peer transport mode offer is incompatible with this endpoint.",
        ),
        message.type === NexusMessageType.HANDSHAKE_REQ,
      );
      return;
    }
    if (message.type === NexusMessageType.HANDSHAKE_REQ) {
      // Policy saw the pre-assignment local identity; ACK reports the final one.
      if (message.assigns)
        this.localEndpointMeta = message.assigns as ContextMetaOf<M>;
      const providers = this.localProviders();
      this.state = {
        phase: "handshaking",
        expected: NexusMessageType.HANDSHAKE_READY,
        id: message.id,
      };
      await this.write({
        type: NexusMessageType.HANDSHAKE_ACK,
        id: message.id,
        metadata: this.localEndpointMeta,
        capabilities: [PROVIDER_CATALOG_CAPABILITY, RESOURCE_SCOPE_CAPABILITY],
        providers,
        transport: this.localTransportOffer(),
      });
    } else {
      this.addProviders(message.providers ?? []);
      this.activationPending = true;
      this.activationIngressBytes = 0;
      const selectedMode = this.selectPacketMode(message.transport.packetModes);
      const activationStarted = this.port.beginActivation?.(selectedMode);
      if (activationStarted?.isErr()) {
        this.activationPending = false;
        this.reject(message.id, activationStarted.error);
        return;
      }
      const readySent = await this.write({
        type: NexusMessageType.HANDSHAKE_READY,
        id: message.id,
        capabilities: [PROVIDER_CATALOG_CAPABILITY, RESOURCE_SCOPE_CAPABILITY],
        providers: this.localProviders(),
        transport: {
          initiatorReceive: this.localTransportOffer().receive,
          responderReceive: message.transport.receive,
          selectedPacketMode: selectedMode,
        },
      });
      if (readySent.isErr()) {
        this.activationPending = false;
        for (const pending of this.activationIngress.splice(0))
          pending.resolve(err(readySent.error));
        return;
      }
      const activated = this.port.activateSession?.({
        maxFrameBytes: Math.min(
          this.localTransportOffer().receive.maxFrameBytes,
          message.transport.receive.maxFrameBytes,
        ),
        maxMessageBytes: Math.min(
          this.localTransportOffer().receive.maxMessageBytes,
          message.transport.receive.maxMessageBytes,
        ),
        packetMode: this.selectPacketMode(message.transport.packetModes),
      });
      if (activated?.isErr()) {
        this.activationPending = false;
        for (const pending of this.activationIngress.splice(0))
          pending.resolve(err(activated.error));
        this.reject(message.id, activated.error);
        return;
      }
      this.activationPending = false;
      await this.publish(true);
      this.port.completeActivation?.();
      for (const pending of this.activationIngress.splice(0)) {
        const result = await Result.tryPromise({
          try: () => this.dispatch(pending.message),
          catch: asError,
        });
        pending.resolve(result);
        if (result.isErr()) this.close("protocol");
      }
      this.activationIngressBytes = 0;
    }
  }

  /** Ask the owner policy about a candidate identity without committing state here. */
  private async authorize(remoteIdentity: ContextMetaOf<M>): Promise<boolean> {
    // The session owns both identities and direction, including christening and
    // subsequent local updates. Policy is only a decision, not a state lookup.
    const allowed = await Result.tryPromise({
      try: async () =>
        this.handlers.authorize
          ? this.handlers.authorize({
              localIdentity: this.localEndpointMeta,
              remoteIdentity,
              connection: this.context.connection,
              direction: this.direction,
            })
          : true,
      catch: asError,
    });
    if (allowed.isErr())
      this.logger.debug("Connection authorization failed", allowed.error);
    return allowed.isOk() && allowed.value === true;
  }

  private localTransportOffer(): HandshakeReqMessage["transport"] {
    return {
      version: 1,
      receive: {
        maxFrameBytes: this.transportConfig.maxFrameBytes,
        maxMessageBytes: this.transportConfig.maxMessageBytes,
      },
      packetModes: this.transportConfig.binaryPackets
        ? ["json", "binary"]
        : ["json"],
    };
  }

  private selectPacketMode(
    modes: readonly ("json" | "binary")[],
  ): "json" | "binary" {
    return this.transportConfig.binaryPackets && modes.includes("binary")
      ? "binary"
      : "json";
  }

  /** Publish a verified peer after control packets and reentrant sends are drained. */
  private async publish(deferred: boolean): Promise<void> {
    if (this.state.phase === "closed" || !this.peerIdentity) return;
    const drain = async () => {
      // Keep this FIFO installed while draining: reentrant sends append to its end.
      // Closing clears this same array, stopping traversal even after an Ok send.
      while (this.queuedMessages.length) {
        const queued = this.queuedMessages.shift()!;
        const sent = queued.options
          ? await this.port.sendMessage(queued.message, queued.options)
          : await this.write(queued.message);
        if (sent.isErr()) this.close("protocol");
        queued.resolve(sent);
        if (sent.isErr()) return false;
      }
      return this.state === publication;
    };
    const finish = async () => {
      if (!(await drain()) || !this.peerIdentity) return;
      const notified = Result.try({
        try: () => this.handlers.onReady(this),
        catch: asError,
      }).andThen((result) => result);
      if (notified.isErr()) {
        this.settleOpening(notified);
        this.close("protocol");
        return;
      }
      // Owner registration may reenter sends or close. Keep inbound traffic behind
      // publication and drain new sends before completing the transition.
      if (!(await drain())) return;
      this.state = { phase: "ready" };
      await this.drainQueuedMessages();
      if (this.state.phase !== "ready") return;
      this.settleOpening(ok(undefined));
      for (const resolve of this.publicationWaiters) resolve();
      this.publicationWaiters.clear();
    };
    // Install publication state before transport callbacks can reenter.
    const publication: Extract<
      SessionState,
      { phase: "activating" | "publishing" }
    > = {
      phase: "activating",
    };
    this.state = publication;
    // Flush deltas before readiness. Passive publication finishes in this same
    // stack, before any Promise waiter resumes; the active side waits one turn.
    // Failed writes close the session; finish() and the cancelled delay already
    // guard publication, so there is no separate failure transition here.
    const sent = await this.flushProviders();
    if (sent.isErr()) return;
    publication.phase = "publishing";
    if (deferred) {
      await Promise.resolve();
      await delay(0, { signal: this.lifetime.signal });
    }
    await finish();
  }

  private async drainQueuedMessages(): Promise<void> {
    if (this.drainingQueuedMessages) return;
    this.drainingQueuedMessages = true;
    try {
      while (this.queuedMessages.length && this.state.phase === "ready") {
        const queued = this.queuedMessages.shift()!;
        if (queued.options?.signal?.aborted) {
          queued.resolve(
            err(
              new LogicalConnectionInvalidStateError(
                "Queued send was aborted",
                {
                  connectionId: this.connectionId,
                },
              ),
            ),
          );
          continue;
        }
        const result = queued.options
          ? await this.port.sendMessage(queued.message, queued.options)
          : await this.write(queued.message);
        if (
          result.isErr() &&
          !queued.options?.signal?.aborted &&
          !isDeterminateTransferError(result.error)
        )
          this.close("protocol");
        queued.resolve(result);
        if (result.isErr()) break;
      }
    } finally {
      this.drainingQueuedMessages = false;
      if (this.queuedMessages.length && this.state.phase === "ready")
        void this.drainQueuedMessages();
    }
  }

  /** Send best-effort handshake rejection while retaining the original failure. */
  private reject(
    id: HandshakeReqMessage["id"],
    error: Error,
    deferred = false,
  ): void {
    this.rejection = error;
    // Rejection is best effort; send failure must not replace the original reason.
    const sent = Promise.resolve(
      this.port.sendMessage({
        type: NexusMessageType.HANDSHAKE_REJECT,
        id,
        error: toSerializedError(error),
      }),
    );
    void sent.then((result) => {
      if (result.isErr())
        this.logger.error("Failed to send HANDSHAKE_REJECT", result.error);
    });
    if (this.state.phase === "closed") return;
    if (deferred)
      void delay(0, { signal: this.lifetime.signal }).then(
        () => this.close("protocol"),
        () => undefined,
      );
    else this.close("protocol");
  }

  // ===== Private Identity And Catalog =====

  /** Merges wire catalog additions for synchronous get without waking connection acquisition. */
  private addProviders(providers: readonly string[]): void {
    for (const provider of providers) this.providers.add(provider);
  }

  /** Drain queued provider announcements, including registrations made reentrantly. */
  private async flushProviders(): Promise<Result<void, Error>> {
    // Reentrant registration during activation queues another delta. Drain it
    // before publishing instead of stranding it until an unrelated registration.
    while (
      this.pendingProviders.size > 0 ||
      this.pendingRemovedProviders.size > 0
    ) {
      const providers = Array.from(this.pendingProviders);
      const removed = Array.from(this.pendingRemovedProviders);
      this.pendingProviders.clear();
      this.pendingRemovedProviders.clear();
      const sent = await this.write({
        type: NexusMessageType.PROVIDER_AVAILABLE,
        id: null,
        providers,
        ...(removed.length ? { removed } : {}),
      });
      if (sent.isErr()) return sent;
    }
    return ok(undefined);
  }
}

/** Convert arbitrary callback failures into safe diagnostic errors. */
function asError(error: unknown): Error {
  // User callbacks may throw values whose string conversion also throws.
  return Result.try({
    try: () => (error instanceof Error ? error : new Error(String(error))),
    catch: () => new Error("Unknown connection callback error"),
  }).match({ ok: (value) => value, err: (value) => value });
}

/** Reconstruct a handshake failure while preserving protocol-specific identity. */
function serializedErrorToError(input: SerializedError): Error {
  if (input.code === "E_PROTOCOL_INCOMPATIBLE")
    return new NexusProtocolIncompatibleError(
      input.message ?? "",
      {},
      input.cause,
    );
  const error = new Error(input.message ?? "Handshake rejected by remote.");
  error.name = input.name ?? "HandshakeRejectedError";
  if (input.code) Object.assign(error, { code: input.code });
  return error;
}
