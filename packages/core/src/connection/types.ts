import type {
  AdapterModel,
  ConnectionTargetOf,
  ContextMetaOf,
} from "../types/adapter-model";
import type { Result } from "better-result";
import type { LogicalConnection } from "./logical-connection";
import type { NexusMessage } from "../types/message";
import type {
  ConnectionAuthContext,
  NexusAuthorizationPolicy,
} from "../api/types/config";

export type ResolveOptions<M extends AdapterModel> = {
  target: ConnectionTargetOf<M>;
  assignmentMetadata?: ContextMetaOf<M>;
};

/**
 * Callbacks implemented by the session owner and passed to LogicalConnection.
 * The connection invokes them; the owner must not call them to advance a session.
 * ConnectionManager implements these to maintain indexes and forward messages.
 *
 * With open(), normal startup is onAttached -> authorize -> onReady. Afterwards,
 * messages, authorized identity updates and catalog changes can recur until close.
 * Identity and disconnect observation belongs to the session's event channels; these
 * owner callbacks only commit collection indexes and dispatch application work.
 * Startup failure can skip onReady. A constructed session that reaches shutdown
 * calls onClosed; an acquisition failure before ownership transfers has no session
 * to notify. The low-level constructor does not invoke onAttached.
 *
 * Only authorize and onMessage may return Promises. Registration hooks return a
 * synchronous Result; onClosed returns void and is not awaited. Connection
 * arguments are live objects, not frozen event snapshots.
 */
export interface LogicalConnectionHandlers<M extends AdapterModel> {
  /**
   * Register an attached session with its owner, without making it routable yet.
   *
   * Called once by open() after processor acquisition, construction and ownership
   * transfer, before buffered packets are processed or authorization begins.
   * If acquisition is synchronous, this runs before open() returns its Promise.
   * ConnectionManager inserts the object into its attached-session index here.
   *
   * @param connection - The newly attached object. Its local identity and adapter
   * metadata are available, but its remote identity is not yet authorized.
   * @returns Result.ok(undefined) after registration, or Result.err(error) if the
   * owner cannot accept the session. Do not return a Promise. Err or a thrown
   * exception fails open() and closes the session, invoking onClosed to clean up
   * any partial registration. Calling connection.close() here also fails startup,
   * even if the callback subsequently returns Ok.
   */
  onAttached(connection: LogicalConnection<M>): Result<void, Error>;
  /**
   * Publish a protocol-ready session into the owner's routable connection index.
   *
   * Called at most once, after successful handshake authorization, required
   * control sends, pending provider deltas and the existing outgoing FIFO have
   * been handed to the processor. The active handshake side reaches this callback
   * after its publication delay; the passive side invokes it synchronously while
   * completing READY processing. Earlier failure or closure skips this callback.
   *
   * During the callback, isReady() is true but inbound application delivery still
   * waits. Synchronous sends from the callback join the FIFO; after Ok they are
   * drained before open() succeeds. Ok does not override a reentrant close or a
   * failure while draining those sends. Local sends do not acknowledge delivery.
   *
   * @param connection - The same session previously supplied to onAttached when
   * using open(). Register this object directly; no ID-based lookup is needed.
   * @returns Result.ok(undefined) once synchronous registration is complete, or
   * Result.err(error) on registration failure. Do not return a Promise. Err or a
   * thrown exception fails open() and closes the session; onClosed must remove
   * any registration already performed. Inbound application traffic is not
   * delivered for a failed registration.
   */
  onReady(connection: LogicalConnection<M>): Result<void, Error>;
  /**
   * Remove a closed session from the owner's indexes and release its dependents.
   *
   * Called once on the first shutdown, whether caused by close(), native
   * disconnect or session failure, including failure during onAttached/onReady.
   * The session is already closed, its delayed work is cancelled, its queues are
   * cleared and any pending startup result is failed. Repeated or reentrant close
   * calls do not invoke this callback again. Remove indexes before notifying
   * upstream observers so they cannot find the closed session as available.
   *
   * @param connection - The closed object; isReady() is false. Retained identity
   * and catalog getters remain available for diagnostics, not routing.
   * @returns Nothing. Perform cleanup synchronously; returned Promises are not
   * awaited. Thrown exceptions are logged and contained by the connection; they
   * neither reopen it nor retry this callback, so essential cleanup must come first.
   */
  onClosed(connection: LogicalConnection<M>): void;
  /**
   * Handle an inbound packet not consumed by the connection protocol itself.
   *
   * Called for application traffic only after successful owner registration and
   * publication, never for handshake, identity-update or provider-catalog packets.
   * Requests wait for preceding identity authorization; RES, ERR and BATCH_RES
   * may bypass that authorization wait to complete reverse RPC, but still wait
   * for publication. Independent application handlers can execute concurrently.
   *
   * @param connection - The source session. Use connectionId for upstream RPC
   * bookkeeping; the object may close while an asynchronous handler is running.
   * @param message - The decoded inbound packet to dispatch to the service layer.
   * @returns Nothing for synchronous processing, or a Promise that settles when
   * this packet's processing finishes. This does not serialize later independent
   * packets or acknowledge delivery to the peer. A throw/rejection becomes Err
   * from safeHandleMessage(); managed reception installed by open() also logs the
   * failure and closes the session. Closing does not cancel an already running
   * application handler.
   */
  onMessage(
    connection: LogicalConnection<M>,
    message: NexusMessage,
  ): void | Promise<void>;
  /**
   * Decide whether a candidate peer identity is allowed for this session.
   *
   * Called for an admissible, capability-compatible REQ or ACK before committing
   * its identity, and for each eligible inbound IDENTITY_UPDATE before committing
   * the merged identity. Not called for READY, provider deltas, ordinary RPC or
   * ignored/replayed handshake packets. Authorization runs in transport order;
   * a result arriving after the relevant handshake state changed or the session
   * closed cannot commit an identity.
   *
   * @param context - Complete inputs supplied by the connection: localIdentity is
   * this session's identity at invocation, remoteIdentity is the candidate to
   * authorize, connection contains local adapter facts, and direction is physical
   * incoming/outgoing direction, not active/passive handshake role. For a REQ
   * carrying a christening assignment, localIdentity is still the pre-assignment
   * value. Later checks use the assigned/updated session identity. Treat these
   * inputs as read-only; do not reconstruct them from Manager indexes.
   * @returns true to allow or false to deny, directly or via Promise. Omission
   * allows authorization; an installed callback must return true to allow. A
   * throw/rejection is logged and treated as denial, not propagated as an
   * unhandled exception. Handshake denial sends a best-effort rejection and closes;
   * identity-update denial keeps the old identity and closes. Do not await this
   * same session's open() here: startup is waiting for this decision.
   */
  authorize?(context: ConnectionAuthContext<M>): boolean | Promise<boolean>;
}

export interface ConnectionManagerConfig<M extends AdapterModel> {
  /** One-shot exact startup targets; failures do not fail listener initialization. */
  connectTo?: readonly ConnectionTargetOf<M>[];
  policy?: NexusAuthorizationPolicy<M>;
  handshakeTimeoutMs?: number;
}

/**
 * Upstream callbacks supplied to ConnectionManager, normally by Engine.
 * Manager owns session indexes; these callbacks own service dispatch and
 * session-bound call/resource cleanup. They do not drive the handshake.
 */
export interface ConnectionManagerHandlers {
  /**
   * Dispatch an application packet forwarded by a successfully published session.
   * Connection protocol packets are consumed by LogicalConnection, not forwarded.
   * Independent invocations may overlap; publication and authorization ordering
   * follow LogicalConnectionHandlers.onMessage.
   *
   * @param message - The decoded inbound packet to dispatch.
   * @param sourceConnectionId - The source session ID, not a reusable target ID.
   * @returns Nothing or a Promise for this packet's processing. Throws/rejections
   * propagate to the session's message handling; managed reception closes it.
   * A synchronous dispatcher may hand work off to its own error boundary; only
   * failures returned through this callback propagate to the session.
   */
  onMessage(
    message: NexusMessage,
    sourceConnectionId: string,
  ): void | Promise<void>;
  /**
   * Release pending calls and resources belonging to a session that has closed.
   * Called after Manager removes attached/published index entries. Also called for
   * attached sessions whose handshake failed; connection acquisition failing before
   * attachment has no session to report. Invoked once per closed session, not once
   * per close call.
   *
   * @param connectionId - The closed session ID. Manager queries no longer return
   * a published connection or authorization snapshot for it.
   * @returns Nothing. Cleanup must be synchronous; Promises are not awaited.
   * Throws are logged and contained by LogicalConnection after index removal;
   * the callback is not retried.
   */
  onDisconnect(connectionId: string): void;
}
