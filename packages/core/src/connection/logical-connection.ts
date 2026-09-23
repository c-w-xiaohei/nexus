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
import { NexusProtocolIncompatibleError } from "@/errors";
import { Result } from "better-result";
import { delay } from "es-toolkit/promise";

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
      messages: NexusMessage[];
      published: Promise<void>;
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
          else connection?.receive(message);
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
        onProtocolError: fail,
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
          for (const message of messages) attached.receive(message);
          messages = undefined;
          if (config.direction === "outgoing" && !passive) {
            const started = attached.initiateHandshake(
              config.assignmentMetadata,
            );
            if (started.isErr()) fail(started.error);
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
   * Err leaves the session closed; processor failures close it before returning.
   */
  public sendMessage(message: NexusMessage): Result<void, Error> {
    if (this.state.phase === "closed")
      return err(
        new LogicalConnectionInvalidStateError(
          "Cannot send on a closed connection.",
          { connectionId: this.connectionId },
        ),
      );
    if ("messages" in this.state) {
      this.state.messages.push(message);
      return ok(undefined);
    }
    return this.write(message);
  }

  /** Serialize handshake authorization while allowing independent application work to overlap. */
  public safeHandleMessage(
    message: NexusMessage,
  ): Promise<Result<void, Error>> {
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
  /** Start the active handshake for an attached session and preserve its assignment metadata. */
  public initiateHandshake(
    assignmentMetadata?: ContextMetaOf<M>,
  ): Result<void, Error> {
    if (
      this.state.phase !== "handshaking" ||
      this.state.expected !== NexusMessageType.HANDSHAKE_REQ
    )
      return err(
        new LogicalConnectionInvalidStateError(
          "Handshake can only be initiated in INITIALIZING state.",
          {
            phase: this.state.phase,
            connectionId: this.connectionId,
          },
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
      ...(assignmentMetadata && { assigns: assignmentMetadata }),
    });
  }

  // ===== Public Identity And Catalog =====

  /** Apply local identity changes to this session without broadcasting them. */
  public updateLocalIdentity(updates: Partial<ContextMetaOf<M>>): void {
    this.localEndpointMeta = { ...this.localEndpointMeta, ...updates };
  }

  /** Queue additions before readiness, otherwise send them. Send failure closes the session. */
  public publishProviders(providers: readonly string[]): Result<void, Error> {
    if (this.state.phase === "closed") return ok(undefined);
    for (const provider of providers) {
      this.pendingRemovedProviders.delete(provider);
      this.pendingProviders.add(provider);
    }
    return this.isReady() ? this.flushProviders() : ok(undefined);
  }

  // ===== Private Lifetime =====

  public removeProviders(providers: readonly string[]): Result<void, Error> {
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
    this.lifetime.abort();
    if ("messages" in state) state.messages.length = 0;
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
  private write(message: NexusMessage): Result<void, Error> {
    // Control packets bypass publication buffering, not failure cleanup.
    const sent = this.port.sendMessage(message);
    if (sent.isErr()) this.close("protocol");
    return sent;
  }

  /** Start managed inbound processing and turn failures into protocol closure. */
  private receive(message: NexusMessage): void {
    void this.safeHandleMessage(message).then((result) => {
      if (result.isErr()) {
        this.logger.error("Failed to process incoming message", result.error);
        this.close("protocol");
      }
    });
  }

  // ===== Private Protocol =====

  /** Consume protocol packets or forward published application packets in order. */
  private async dispatch(message: NexusMessage): Promise<void> {
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
        if ("published" in state) await state.published;
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
      this.addProviders(message.providers ?? []);
      this.publish(false);
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
      this.write({
        type: NexusMessageType.HANDSHAKE_ACK,
        id: message.id,
        metadata: this.localEndpointMeta,
        capabilities: [PROVIDER_CATALOG_CAPABILITY, RESOURCE_SCOPE_CAPABILITY],
        providers,
      }).unwrapOr(undefined);
    } else {
      this.addProviders(message.providers ?? []);
      this.write({
        type: NexusMessageType.HANDSHAKE_READY,
        id: message.id,
        capabilities: [PROVIDER_CATALOG_CAPABILITY, RESOURCE_SCOPE_CAPABILITY],
        providers: this.localProviders(),
      }).unwrapOr(undefined);
      this.publish(true);
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

  /** Publish a verified peer after control packets and reentrant sends are drained. */
  private publish(deferred: boolean): void {
    if (this.state.phase === "closed" || !this.peerIdentity) return;
    const drain = () => {
      // Keep this FIFO installed while draining: reentrant sends append to its end.
      // Closing clears this same array, stopping traversal even after an Ok send.
      for (const message of publication.messages) {
        this.write(message).unwrapOr(undefined);
      }
      publication.messages.length = 0;
      return this.state === publication;
    };
    const finish = () => {
      if (!drain() || !this.peerIdentity) return;
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
      if (!drain()) return;
      this.state = { phase: "ready" };
      this.settleOpening(ok(undefined));
    };
    const completeLater = async () => {
      try {
        // Install publication and send catalog deltas before scheduling the timer.
        await Promise.resolve();
        await delay(0, { signal: this.lifetime.signal });
        finish();
      } catch (error) {
        if (this.lifetime.signal.aborted) return;
        this.settleOpening(err(asError(error)));
        this.close("protocol");
      }
    };
    // Install the final Promise before any transport callback can reenter.
    // Shutdown cancels the delay and releases waiters to recheck the closed state.
    const publication: Extract<SessionState, { published: Promise<void> }> = {
      phase: "activating",
      messages: [],
      published: deferred ? completeLater() : Promise.resolve(),
    };
    this.state = publication;
    // Flush deltas before readiness. Passive publication finishes in this same
    // stack, before any Promise waiter resumes; the active side waits one turn.
    // Failed writes close the session; finish() and the cancelled delay already
    // guard publication, so there is no separate failure transition here.
    this.flushProviders().unwrapOr(undefined);
    publication.phase = "publishing";
    if (!deferred) finish();
  }

  /** Send best-effort handshake rejection while retaining the original failure. */
  private reject(
    id: HandshakeReqMessage["id"],
    error: Error,
    deferred = false,
  ): void {
    this.rejection = error;
    // Rejection is best effort; send failure must not replace the original reason.
    const sent = this.port.sendMessage({
      type: NexusMessageType.HANDSHAKE_REJECT,
      id,
      error: toSerializedError(error),
    });
    if (sent.isErr())
      this.logger.error("Failed to send HANDSHAKE_REJECT", sent.error);
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
  private flushProviders(): Result<void, Error> {
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
      const sent = this.write({
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
