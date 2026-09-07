import type {
  AdapterModel,
  ConnectionTargetOf,
  ConnectionWhere,
  ConnectionMetaOf,
  ContextMetaOf,
} from "../types/adapter-model";
import type { Result } from "better-result";
import type { LogicalConnection } from "./logical-connection";
import type { NexusMessage } from "../types/message";
import type {
  ConnectionAuthContext,
  NexusAuthorizationPolicy,
} from "../api/types/config";

export enum ConnectionStatus {
  INITIALIZING,
  HANDSHAKING,
  CONNECTED,
  CLOSING,
  CLOSED,
}

export type ResolveOptions<M extends AdapterModel> = {
  target?: ConnectionTargetOf<M>;
  where?: ConnectionWhere<M>;
  assignmentMetadata?: ContextMetaOf<M>;
};

export type MessageTarget<M extends AdapterModel> =
  | { connectionId: string }
  | { connectionIds: readonly string[] }
  | {
      where: ConnectionWhere<M>;
    };

export type CallTarget<M extends AdapterModel> = MessageTarget<M>;

/**
 * Callbacks implemented by the session owner and passed to LogicalConnection.
 * The connection invokes them; the owner must not call them to advance a session.
 * ConnectionManager implements these to maintain indexes and forward messages.
 *
 * With open(), normal startup is onAttached -> authorize -> onReady. Afterwards,
 * messages, authorized identity updates and catalog changes can recur until close.
 * Startup failure can skip onReady. A constructed session that reaches shutdown
 * calls onClosed; an acquisition failure before ownership transfers has no session
 * to notify. The low-level constructor does not invoke onAttached.
 *
 * Only authorize and onMessage may return Promises. Registration hooks return a
 * synchronous Result; notification hooks return void and are not awaited.
 * Connection arguments are live objects, not frozen event snapshots. Identity
 * arguments refer to the values at the transition; treat them as read-only.
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
   * @param identity - The authorized remote identity at this transition. Use it
   * to populate owner indexes, not to authorize the session again.
   * @returns Result.ok(undefined) once synchronous registration is complete, or
   * Result.err(error) on registration failure. Do not return a Promise. Err or a
   * thrown exception fails open() and closes the session; onClosed must remove
   * any registration already performed. Inbound application traffic is not
   * delivered for a failed registration.
   */
  onReady(
    connection: LogicalConnection<M>,
    identity: ContextMetaOf<M>,
  ): Result<void, Error>;
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
   * @param identity - The last authorized remote identity if protocol readiness
   * had been reached immediately before close; otherwise undefined. It can be
   * present even when onReady was never called, or absent while remoteIdentity
   * retains a handshake candidate that was authorized. Consult the owner's own
   * index to determine whether it published the session.
   * @returns Nothing. Perform cleanup synchronously; returned Promises are not
   * awaited. Thrown exceptions are logged and contained by the connection; they
   * neither reopen it nor retry this callback, so essential cleanup must come first.
   */
  onClosed(
    connection: LogicalConnection<M>,
    identity: ContextMetaOf<M> | undefined,
  ): void;
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
   * Update owner indexes after an inbound IDENTITY_UPDATE is authorized and applied.
   *
   * Called synchronously after remoteIdentity is replaced, once per accepted
   * update, even if its values are unchanged. Denied updates close the session
   * without this callback; authorization finishing after close is ignored. This
   * is not called for initial handshake identity or updateLocalIdentity(). It can
   * run in the protocol-ready interval before onReady; ConnectionManager updates
   * published indexes only if the session is already present in them.
   *
   * @param connection - The affected session, whose remoteIdentity is already new.
   * Adapter facts remain available through connection.context.connection.
   * @param newIdentity - The complete merged and authorized remote identity, not
   * just the incoming patch. Treat the value as read-only.
   * @param oldIdentity - The previously committed identity, supplied so the owner
   * can remove obsolete index entries without storing its own identity copy.
   * @returns Nothing. Update indexes synchronously; Promises are not awaited.
   * A throw does not roll back the committed identity. It becomes Err from
   * safeHandleMessage(), and managed reception also closes the session.
   */
  onIdentityUpdated(
    connection: LogicalConnection<M>,
    newIdentity: ContextMetaOf<M>,
    oldIdentity: ContextMetaOf<M>,
  ): void;
  /**
   * Notify the owner that a protocol-ready peer's provider catalog has grown.
   *
   * Called synchronously after at least one previously unseen provider is added
   * while isReady() is true. Duplicate-only additions and additions before
   * protocol readiness do not trigger it; initial catalog data is available at
   * onReady instead. This can run before owner publication, so ConnectionManager
   * checks its published index before announcing an availability change.
   *
   * @param connection - The affected session. Query hasProvider()/remoteProviders
   * for the updated catalog; no provider delta is passed to this callback.
   * @returns Nothing. Optional; omission skips notification, not catalog updates.
   * Promises are not awaited. A throw leaves the catalog updated and becomes Err
   * from safeHandleMessage(); managed reception also closes the session.
   */
  onProviderCatalogUpdated?(connection: LogicalConnection<M>): void;
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
export interface ConnectionManagerHandlers<M extends AdapterModel> {
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
   */
  onMessage(
    message: NexusMessage,
    sourceConnectionId: string,
  ): void | Promise<void>;
  /**
   * Release pending calls and resources belonging to a session that has closed.
   * Called after Manager removes attached/published index entries and
   * notifies availability listeners. Also called for attached sessions whose
   * handshake failed; connection acquisition failing before attachment has no
   * session to report. Invoked once per closed session, not once per close call.
   *
   * @param connectionId - The closed session ID. Manager queries no longer return
   * a published connection or authorization snapshot for it.
   * @param identity - The pre-close remote identity if protocol readiness was
   * reached; otherwise undefined. Its presence does not prove prior publication.
   * @returns Nothing. Cleanup must be synchronous; Promises are not awaited.
   * Throws are logged and contained by LogicalConnection after index removal;
   * the callback is not retried.
   */
  onDisconnect(connectionId: string, identity?: ContextMetaOf<M>): void;
  /**
   * Observe an authorized remote identity update on an already published session.
   * Called after the connection commits the new identity. Authorization snapshot
   * queries already expose newIdentity.
   * Updates before publication are not forwarded. Availability notification
   * follows this callback, including when it throws.
   *
   * @param connectionId - The affected published session ID.
   * @param newIdentity - The complete merged remote identity now in use.
   * @param oldIdentity - The identity in use before this update.
   * @param connectionMeta - The session's shallow-frozen local adapter facts,
   * distinct from either peer identity.
   * @returns Nothing. Optional; omission does not skip identity or index updates.
   * Promises are not awaited. A throw does not roll back the update; it propagates
   * to session message handling, and managed reception closes the session.
   */
  onIdentityUpdated?(
    connectionId: string,
    newIdentity: ContextMetaOf<M>,
    oldIdentity: ContextMetaOf<M>,
    connectionMeta: ConnectionMetaOf<M>,
  ): void;
}
