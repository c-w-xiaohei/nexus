import type { ConnectionManager } from "@/connection/connection-manager";
import type { LogicalConnection } from "@/connection/logical-connection";
import type { AdapterModel } from "@/types/adapter-model";
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
import type { ConnectOptions, ConnectMulticastOptions } from "./types/config";
import { hasOnlyOptionKeys, isValidTimeout } from "./types/config";

const { ok, err } = Result;

/** Acquires one ready session. Targetless calls wait without dialing; their default wait is unbounded. */
export async function safeConnect<M extends AdapterModel>(
  ready: () => Promise<Result<ConnectionManager<M>, Error>>,
  options: ConnectOptions<M>,
): Promise<Result<LogicalConnection<M>, ConnectionAcquireError>> {
  if (!isValidConnectOptions(options, false))
    return err(new NexusUsageError("Invalid connect options."));
  if (options.signal?.aborted)
    return err(
      new NexusServiceError("Connection acquisition was aborted.", "E_ABORTED"),
    );
  const deadline = createDeadline(
    options.timeout,
    options.signal,
    options.target !== undefined,
  );
  try {
    const initialized = await Promise.race([ready(), deadline.promise]);
    if (initialized.isErr())
      return err(mapConnectionAcquireError(initialized.error));
    const manager = initialized.value;
    const resolved = await Promise.race([
      manager.safeResolveConnections(options),
      deadline.promise,
    ]);
    if (resolved.isErr()) return err(mapConnectionAcquireError(resolved.error));
    let sessions = resolved.value;
    while (sessions.length === 0 && options.target === undefined) {
      await waitForAvailabilityAndRescan(
        manager,
        deadline,
        () => manager.findReadyConnections(options.where).length,
      );
      sessions = manager.findReadyConnections(options.where);
    }
    if (sessions.length !== 1)
      return err(
        new NexusServiceError(
          "Connection acquisition requires one matching session.",
          sessions.length > 1 ? "E_SERVICE_AMBIGUOUS" : "E_SERVICE_NO_MATCH",
        ),
      );
    const session = sessions[0];
    if (
      !session.isReady() ||
      (options.where &&
        !options.where(session.remoteIdentity!, session.context.connection))
    ) {
      return err(
        new NexusServiceError(
          "The acquired session is no longer available.",
          "E_SERVICE_UNAVAILABLE",
          {
            context: {
              connectionId: session.connectionId,
              target: options.target,
            },
          },
        ),
      );
    }
    return ok(session);
  } catch (error) {
    return err(mapConnectionAcquireError(error));
  } finally {
    deadline.cleanup();
  }
}

/** Acquires all explicit targets or snapshots current peers. Failures retain their target and leave shared sessions alive. */
export async function safeConnectMulticast<M extends AdapterModel>(
  ready: () => Promise<Result<ConnectionManager<M>, Error>>,
  options: ConnectMulticastOptions<M>,
): Promise<Result<readonly LogicalConnection<M>[], ConnectionAcquireError>> {
  if (!isValidConnectOptions(options, true))
    return err(new NexusUsageError("Invalid connectMulticast options."));
  if (options.signal?.aborted)
    return err(
      new NexusServiceError("Connection acquisition was aborted.", "E_ABORTED"),
    );
  const deadline = createDeadline(options.timeout, options.signal);
  try {
    const initialized = await Promise.race([ready(), deadline.promise]);
    if (initialized.isErr())
      return err(mapConnectionAcquireError(initialized.error));
    const manager = initialized.value;
    let groups: readonly (readonly LogicalConnection<M>[])[];
    if (options.targets === undefined) {
      groups = [manager.findReadyConnections(options.where)];
    } else {
      const targets = options.targets;
      const resolved = await Promise.race([
        new Promise<
          Result<
            readonly (readonly LogicalConnection<M>[])[],
            ConnectionAcquireError
          >
        >((resolve) => {
          // Observe every attempt after the first failure; successful sessions are runtime-owned.
          const results: (readonly LogicalConnection<M>[])[] = new Array(
            targets.length,
          );
          let remaining = results.length;
          if (!remaining) resolve(ok(results));
          targets.forEach((target, index) => {
            void manager
              .safeResolveConnections({ target, where: options.where })
              .then(
                (result) => {
                  if (result.isErr()) {
                    resolve(
                      err(mapConnectionAcquireError(result.error, { target })),
                    );
                  } else {
                    results[index] = result.value;
                    if (--remaining === 0) resolve(ok(results));
                  }
                },
                (error) =>
                  resolve(err(mapConnectionAcquireError(error, { target }))),
              );
          });
        }),
        deadline.promise,
      ]);
      if (resolved.isErr()) return resolved;
      groups = resolved.value;
    }
    const sessions = [...new Set(groups.flat())];
    for (const session of sessions) {
      if (
        !session.isReady() ||
        (options.where &&
          !options.where(session.remoteIdentity!, session.context.connection))
      ) {
        const context: Record<string, unknown> = {
          connectionId: session.connectionId,
        };
        if (options.targets !== undefined) {
          const index = groups.findIndex((group) => group.includes(session));
          context.target = options.targets[index];
        }
        return err(
          new NexusServiceError(
            "A selected session is no longer available.",
            "E_SERVICE_UNAVAILABLE",
            { context },
          ),
        );
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

type Deadline = { promise: Promise<never>; cleanup(): void };

/** Owns only this caller's timer and abort listener; never cancels shared bootstrap or dialing. */
function createDeadline(
  timeout: number | undefined,
  signal: AbortSignal | undefined,
  finiteDefault = true,
): Deadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reject!: (error: Error) => void;
  /** Settles this wait with an acquisition abort without closing its connection. */
  const onAbort = () =>
    reject(
      new NexusServiceError("Connection acquisition was aborted.", "E_ABORTED"),
    );
  const promise = new Promise<never>((_, rejectPromise) => {
    reject = rejectPromise;
    if (timeout !== undefined || finiteDefault) {
      timer = setTimeout(
        () =>
          reject(
            new NexusServiceError(
              "Connection acquisition timed out.",
              "E_SERVICE_ACQUISITION_TIMEOUT",
            ),
          ),
        timeout ?? 30_000,
      );
    }
  });
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    /** Releases the request-scoped timer and listener after any terminal outcome. */
    cleanup() {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Subscribes before rescanning to avoid losing a connection published between scans. */
function waitForAvailabilityAndRescan<M extends AdapterModel>(
  manager: ConnectionManager<M>,
  deadline: Deadline,
  hasMatch: () => unknown,
): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  const event = new Promise<void>((resolve) => {
    unsubscribe = manager.subscribeAvailabilityChanged(resolve);
    if (hasMatch()) resolve();
  });
  return Promise.race([event, deadline.promise]).finally(() => unsubscribe?.());
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
