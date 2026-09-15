import type {
  AdapterModel,
  ConnectionMetaOf,
  ConnectionTargetOf,
  ConnectionWhere,
  ContextMetaOf,
} from "@/types/adapter-model";
import {
  NexusConfigurationError,
  NexusConnectionConstraintFailedError,
  NexusEndpointCapabilityError,
  NexusEndpointConnectError,
  NexusError,
  NexusHandshakeError,
  NexusProtocolIncompatibleError,
  NexusServiceError,
  NexusUsageError,
  type ConnectionAcquireError,
} from "@/errors";
import { toSerializedError } from "@/utils/error";
import { Result } from "better-result";
import { isPlainTarget } from "./token";
import type { ConnectMulticastOptions, ConnectOptions } from "./types/config";
import { hasOnlyOptionKeys, isValidTimeout } from "./types/config";

const { err, ok } = Result;

/** Minimal session facts acquisition needs; concrete connection ownership stays with its runtime. */
export interface AcquisitionSession<M extends AdapterModel> {
  readonly connectionId: string;
  readonly remoteIdentity: ContextMetaOf<M> | null | undefined;
  readonly context: { readonly connection: ConnectionMetaOf<M> };
  isReady(): boolean;
}

/** Supplies snapshots, exact-target resolution, and availability observation to acquisition. */
export interface AcquisitionSource<
  M extends AdapterModel,
  S extends AcquisitionSession<M> = AcquisitionSession<M>,
> {
  findReadyConnections(): readonly S[];
  safeResolveConnections(options: {
    target: ConnectionTargetOf<M>;
  }): Promise<Result<readonly S[], Error>>;
  subscribeAvailabilityChanged(listener: () => void): () => void;
}

/** Acquires one ready session. Targetless calls wait without dialing; their default wait is unbounded. */
export async function safeConnect<
  M extends AdapterModel,
  S extends AcquisitionSession<M>,
>(
  ready: () => Promise<Result<AcquisitionSource<M, S>, Error>>,
  options: ConnectOptions<M>,
): Promise<Result<S, ConnectionAcquireError>> {
  if (!isValidConnectOptions(options, false))
    return err(new NexusUsageError("Invalid connect options."));
  if (options.signal?.aborted) return err(abortedError());
  const deadline = createDeadline(
    options.timeout,
    options.signal,
    options.target !== undefined,
  );
  try {
    const initialized = await Promise.race([ready(), deadline.promise]);
    if (initialized.isErr())
      return err(mapConnectionAcquireError(initialized.error));
    const source = initialized.value;
    let sessions: readonly S[];
    if (options.target === undefined) {
      const selected = selectSessions(
        source.findReadyConnections(),
        options.where,
        deadline,
      );
      if (selected.isErr()) return selected;
      sessions = selected.value;
    } else {
      const resolved = await Promise.race([
        source.safeResolveConnections({ target: options.target }),
        deadline.promise,
      ]);
      if (resolved.isErr())
        return err(
          mapConnectionAcquireError(resolved.error, { target: options.target }),
        );
      const selected = selectTargetSessions(
        resolved.value,
        options.target,
        options.where,
        deadline,
      );
      if (selected.isErr()) return selected;
      sessions = selected.value;
    }
    if (sessions.length === 0 && options.target === undefined) {
      sessions = await waitForAvailabilityAndRescan(
        source,
        deadline,
        options.where,
      );
    }
    const stopped = deadline.terminalError();
    if (stopped) return err(stopped);
    if (sessions.length !== 1)
      return err(
        new NexusServiceError(
          "Connection acquisition requires one matching session.",
          sessions.length > 1 ? "E_SERVICE_AMBIGUOUS" : "E_SERVICE_NO_MATCH",
        ),
      );
    const available = selectSessions([sessions[0]], options.where, deadline);
    if (available.isErr()) return available;
    if (deadline.terminalError()) return err(deadline.terminalError()!);
    if (available.value.length !== 1)
      return err(unavailableError(sessions[0], options.target));
    return ok(sessions[0]);
  } catch (error) {
    return err(mapConnectionAcquireError(error));
  } finally {
    deadline.cleanup();
  }
}

/** Acquires all explicit targets or snapshots current peers. Failures retain their target and leave shared sessions alive. */
export async function safeConnectMulticast<
  M extends AdapterModel,
  S extends AcquisitionSession<M>,
>(
  ready: () => Promise<Result<AcquisitionSource<M, S>, Error>>,
  options: ConnectMulticastOptions<M>,
): Promise<Result<readonly S[], ConnectionAcquireError>> {
  if (!isValidConnectOptions(options, true))
    return err(new NexusUsageError("Invalid connectMulticast options."));
  if (options.signal?.aborted) return err(abortedError());
  const deadline = createDeadline(options.timeout, options.signal);
  try {
    const initialized = await Promise.race([ready(), deadline.promise]);
    if (initialized.isErr())
      return err(mapConnectionAcquireError(initialized.error));
    const source = initialized.value;
    let groups: readonly (readonly S[])[];
    if (options.targets === undefined) {
      const selected = selectSessions(
        source.findReadyConnections(),
        options.where,
        deadline,
      );
      if (selected.isErr()) return selected;
      groups = [selected.value];
    } else {
      const resolved = await resolveTargetGroups(
        source,
        options.targets,
        options.where,
        deadline,
      );
      if (resolved.isErr()) return resolved;
      groups = resolved.value;
    }
    const sessions = [...new Set(groups.flat())];
    const stopped = deadline.terminalError();
    if (stopped) return err(stopped);
    for (const session of sessions) {
      const available = selectSessions([session], options.where, deadline);
      if (available.isErr()) return available;
      const stopped = deadline.terminalError();
      if (stopped) return err(stopped);
      if (available.value.length !== 1) {
        const groupIndex = groups.findIndex((group) => group.includes(session));
        return err(unavailableError(session, options.targets?.[groupIndex]));
      }
    }
    return ok(sessions);
  } catch (error) {
    return err(mapConnectionAcquireError(error));
  } finally {
    deadline.cleanup();
  }
}

/** Rejects unsupported acquisition options before bootstrap, including sparse target arrays. */
function isValidConnectOptions(value: unknown, multicast: boolean): boolean {
  if (
    !hasOnlyOptionKeys(value, [
      multicast ? "targets" : "target",
      "where",
      "timeout",
      "signal",
    ])
  )
    return false;
  return (
    (value.where === undefined || typeof value.where === "function") &&
    isValidTimeout(value.timeout) &&
    (value.signal === undefined ||
      (typeof AbortSignal !== "undefined" &&
        value.signal instanceof AbortSignal)) &&
    (multicast
      ? value.targets === undefined ||
        (Array.isArray(value.targets) &&
          Array.from(value.targets).every(isPlainTarget))
      : value.target === undefined || isPlainTarget(value.target))
  );
}

type Deadline = {
  promise: Promise<never>;
  terminalError(): NexusServiceError | undefined;
  cleanup(): void;
};

/** Owns only this caller's timer and abort listener; never cancels shared bootstrap or dialing. */
function createDeadline(
  timeout: number | undefined,
  signal: AbortSignal | undefined,
  finiteDefault = true,
): Deadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reject!: (error: NexusServiceError) => void;
  let terminal: NexusServiceError | undefined;
  const stop = (error: NexusServiceError) => {
    if (terminal) return;
    terminal = error;
    reject(error);
  };
  const onAbort = () => stop(abortedError());
  const promise = new Promise<never>((_, rejectPromise) => {
    reject = rejectPromise;
    if (timeout !== undefined || finiteDefault)
      timer = setTimeout(
        () =>
          stop(
            new NexusServiceError(
              "Connection acquisition timed out.",
              "E_SERVICE_ACQUISITION_TIMEOUT",
            ),
          ),
        timeout ?? 30_000,
      );
  });
  // A synchronous predicate can abort after the last Promise.race. Keep that rejection observed.
  void promise.catch(() => undefined);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    terminalError: () => terminal,
    cleanup() {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Subscribes before rescanning to avoid losing a connection published between scans. */
function waitForAvailabilityAndRescan<
  M extends AdapterModel,
  S extends AcquisitionSession<M>,
>(
  source: AcquisitionSource<M, S>,
  deadline: Deadline,
  where: ConnectionWhere<M> | undefined,
): Promise<readonly S[]> {
  let unsubscribe: (() => void) | undefined;
  const event = new Promise<readonly S[]>((resolve, reject) => {
    const scan = () => {
      const sessions = selectSessions(
        source.findReadyConnections(),
        where,
        deadline,
      );
      if (sessions.isErr()) return reject(sessions.error);
      if (sessions.value.length) resolve(sessions.value);
    };
    unsubscribe = source.subscribeAvailabilityChanged(scan);
    scan();
  });
  return Promise.race([event, deadline.promise]).finally(() => unsubscribe?.());
}

/** Applies caller constraints only after address resolution; a mismatch never authorizes another dial. */
function selectTargetSessions<
  M extends AdapterModel,
  S extends AcquisitionSession<M>,
>(
  sessions: readonly S[],
  target: ConnectionTargetOf<M>,
  where: ConnectionWhere<M> | undefined,
  deadline: Deadline,
): Result<readonly S[], ConnectionAcquireError> {
  const selected = selectWhere(sessions, where, deadline);
  if (selected.isErr()) return selected;
  if (!selected.value.length)
    return err(
      new NexusConnectionConstraintFailedError(
        "The resolved target does not satisfy the connection constraint.",
        { target },
      ),
    );
  const ready = selected.value.filter((session) => session.isReady());
  return ready.length
    ? ok(ready)
    : err(unavailableError(selected.value[0], target));
}

/** Runs predicates before the final readiness check, so a synchronous close cannot be delivered. */
function selectSessions<
  M extends AdapterModel,
  S extends AcquisitionSession<M>,
>(
  sessions: readonly S[],
  where: ConnectionWhere<M> | undefined,
  deadline: Deadline,
): Result<readonly S[], ConnectionAcquireError> {
  const selected = selectWhere(sessions, where, deadline);
  return selected.map((matching) =>
    matching.filter((session) => session.isReady()),
  );
}

/** Runs caller predicates and preserves the established Core acquisition error classification. */
function selectWhere<M extends AdapterModel, S extends AcquisitionSession<M>>(
  sessions: readonly S[],
  where: ConnectionWhere<M> | undefined,
  deadline: Deadline,
): Result<readonly S[], ConnectionAcquireError> {
  try {
    const selected: S[] = [];
    for (const session of sessions) {
      const stopped = deadline.terminalError();
      if (stopped) return err(stopped);
      if (!where || where(session.remoteIdentity!, session.context.connection))
        selected.push(session);
      const stoppedAfterPredicate = deadline.terminalError();
      if (stoppedAfterPredicate) return err(stoppedAfterPredicate);
    }
    return ok(selected);
  } catch (error) {
    return err(mapConnectionAcquireError(error));
  }
}

/** Launches all target dials concurrently while preserving ordered successful groups. */
async function resolveTargetGroups<
  M extends AdapterModel,
  S extends AcquisitionSession<M>,
>(
  source: AcquisitionSource<M, S>,
  targets: readonly ConnectionTargetOf<M>[],
  where: ConnectionWhere<M> | undefined,
  deadline: Deadline,
): Promise<Result<readonly (readonly S[])[], ConnectionAcquireError>> {
  const attempts = targets.map((target) => ({
    target,
    // Start every shared dial before waiting for any result.
    result: source.safeResolveConnections({ target }),
  }));
  const resolved = new Promise<
    Result<readonly (readonly S[])[], ConnectionAcquireError>
  >((settle) => {
    const groups: S[][] = new Array(attempts.length);
    let remaining = attempts.length;
    let finished = false;
    const finish = (
      result: Result<readonly (readonly S[])[], ConnectionAcquireError>,
    ) => {
      if (finished) return;
      finished = true;
      settle(result);
    };
    if (remaining === 0) finish(ok(groups));
    for (const [index, attempt] of attempts.entries()) {
      void attempt.result.then(
        (result) => {
          if (finished || deadline.terminalError()) return;
          if (result.isErr()) {
            finish(
              err(
                mapConnectionAcquireError(result.error, {
                  target: attempt.target,
                }),
              ),
            );
            return;
          }
          const selected = selectTargetSessions(
            result.value,
            attempt.target,
            where,
            deadline,
          );
          if (finished || deadline.terminalError()) return;
          if (selected.isErr()) {
            finish(selected);
            return;
          }
          groups[index] = [...selected.value];
          if (--remaining === 0) finish(ok(groups));
        },
        (error) => {
          if (!finished && !deadline.terminalError())
            finish(
              err(mapConnectionAcquireError(error, { target: attempt.target })),
            );
        },
      );
    }
  });
  return Promise.race([resolved, deadline.promise]);
}

const abortedError = () =>
  new NexusServiceError("Connection acquisition was aborted.", "E_ABORTED");

function unavailableError<M extends AdapterModel>(
  session: AcquisitionSession<M>,
  target: ConnectionTargetOf<M> | undefined,
): NexusServiceError {
  return new NexusServiceError(
    "The acquired session is no longer available.",
    "E_SERVICE_UNAVAILABLE",
    {
      context: { connectionId: session.connectionId, target },
    },
  );
}

/** Preserves concrete acquisition errors and attaches the originating target at the API boundary. */
function mapConnectionAcquireError(
  error: unknown,
  context?: Record<string, unknown>,
): ConnectionAcquireError {
  if (error instanceof NexusConfigurationError) return error;
  if (error instanceof NexusEndpointConnectError)
    return new NexusEndpointConnectError(error.message, {
      context: { ...error.context, ...context },
      cause: error.cause,
      stack: error.stack,
    });
  if (error instanceof NexusEndpointCapabilityError)
    return new NexusEndpointCapabilityError(error.message, {
      context: { ...error.context, ...context },
      cause: error.cause,
      stack: error.stack,
    });
  if (error instanceof NexusHandshakeError)
    return new NexusHandshakeError(
      error.message,
      error.code,
      { ...error.context, ...context },
      { cause: error.cause, stack: error.stack },
    );
  if (error instanceof NexusConnectionConstraintFailedError)
    return new NexusConnectionConstraintFailedError(
      error.message,
      { ...error.context, ...context },
      error.cause,
    );
  if (error instanceof NexusProtocolIncompatibleError)
    return new NexusProtocolIncompatibleError(
      error.message,
      { ...error.context, ...context },
      error.cause,
    );
  if (error instanceof NexusServiceError)
    return new NexusServiceError(error.message, error.code, {
      context: { ...error.context, ...context },
      cause: error.cause,
      stack: error.stack,
    });
  if (error instanceof NexusError) {
    if (error.code === "E_CONNECTION_CONSTRAINT_FAILED")
      return new NexusConnectionConstraintFailedError(
        error.message,
        { ...error.context, ...context },
        error.cause,
      );
    return new NexusServiceError(error.message, "E_SERVICE_UNAVAILABLE", {
      context,
      cause: error.cause ?? toSerializedError(error),
    });
  }
  return new NexusServiceError(
    "Connection acquisition failed.",
    "E_SERVICE_UNAVAILABLE",
    { context, cause: toSerializedError(error) },
  );
}
