import type { NexusInstance } from "../api/types";
import type { ConnectOptions } from "../api/types/config";
import type { AdapterModel } from "../types/adapter-model";
import { Result, type InferErr } from "better-result";
import { TimeoutError, withTimeout } from "es-toolkit";
import {
  NexusStoreConnectError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
  normalizeNexusStoreError,
  NexusStoreActionError,
} from "./errors";
import type { RemoteStore, StoreActionKeys, StoreToken } from "./contract";
import { createRemoteStore } from "./remote-store";

/** Preserves terminal State failures while adding context to subscription setup errors. */
const normalizeConnectHandshakeError = (error: unknown) => {
  if (error instanceof TimeoutError || isCallTimeout(error)) {
    return new NexusStoreConnectError("Store subscribe handshake timed out.", {
      cause: error,
    });
  }
  if (error instanceof NexusStoreConnectError) return error;
  const normalized = normalizeNexusStoreError(error);
  if (
    normalized instanceof NexusStoreProtocolError ||
    normalized instanceof NexusStoreDisconnectedError
  )
    return normalized;
  return new NexusStoreConnectError("Store subscribe handshake failed.", {
    cause: normalized,
  });
};

/**
 * Acquires a session-bound service and waits for its init callback to be applied.
 * Failure destroys the mirror; its callback still reclaims capabilities in a late init.
 * The service must already be published. A supplied timeout bounds connection
 * acquisition and then the subscription handshake; signal controls acquisition only.
 * State observes later identity mismatch as stale without closing the shared session.
 */
export const safeConnectNexusStore = async <
  Store extends object,
  M extends AdapterModel,
>(
  nexus: Pick<NexusInstance<M>, "safeConnect">,
  token: StoreToken<Store, M>,
  options: ConnectOptions<M> = {},
): Promise<
  Result<RemoteStore<Store>, ReturnType<typeof normalizeConnectHandshakeError>>
> => {
  /** Maps connection and catalog failures to the State acquisition boundary. */
  const createError = (cause: unknown) =>
    new NexusStoreConnectError("Failed to acquire store service.", { cause });
  const acquisition = await Result.tryPromise({
    try: () => nexus.safeConnect(options),
    catch: createError,
  });
  if (acquisition.isErr()) return acquisition;
  const connected = acquisition.value.mapError(createError);
  if (connected.isErr()) return connected;
  const connection = connected.value;
  // Core owns ConnectOptions validation; the same accepted budget separately
  // bounds State initialization after connection acquisition succeeds.
  const { timeout } = options;
  const created = connection.safeGet(token).mapError(createError);
  if (created.isErr()) return created;
  const service = created.value;

  const remoteResult = Result.try({
    try: () => createRemoteStore<Store>(token.validation),
    catch: normalizeConnectHandshakeError,
  });
  if (remoteResult.isErr()) return remoteResult;
  const remote = remoteResult.value;

  // Observe the session before subscribe can deliver init or any update.
  const handshake = await Result.tryPromise({
    try: async () => {
      remote.addCleanup(
        connection.onDisconnected(() =>
          remote.disconnect("Remote store connection disconnected."),
        ),
      );
      // State owns selection staleness; a shared Connection does not retain the
      // acquisition predicate or apply it to unrelated RPC calls.
      if (options.where) {
        const where = options.where;
        remote.addCleanup(
          connection.subscribeIdentity((meta) => {
            if (!where(meta, connection.connectionMeta)) remote.stale();
          }),
        );
      }

      // Immediate lifecycle delivery can invalidate the mirror before subscribe.
      // Do not start remote business work after its local owner became terminal.
      if (remote.store.getStatus().type !== "initializing") return;

      // Init arrives through the callback, not the response. A successful response
      // is only useful when init completed and the session is still usable.
      const subscribed = Promise.resolve(service.subscribe(remote.onSync));
      return timeout !== undefined
        ? withTimeout(() => subscribed, timeout)
        : subscribed;
    },
    catch: normalizeConnectHandshakeError,
  });
  // Recheck after the asynchronous boundary: disconnect may follow the init ACK.
  return handshake
    .andThen(() => remote.safeReady())
    .map(() => remote.store)
    .tapError(() => remote.store.destroy());
};

/** Acquires and initializes a State mirror, throwing the safe entry's structured errors. */
export const connectNexusStore = async <
  Store extends object,
  M extends AdapterModel,
>(
  nexus: Pick<NexusInstance<M>, "safeConnect">,
  token: StoreToken<Store, M>,
  options: ConnectOptions<M> = {},
): Promise<RemoteStore<Store>> => {
  const result = await safeConnectNexusStore(nexus, token, options);
  if (result.isErr()) throw result.error;
  return result.value;
};

/** Captures action rejection without changing the underlying core callback's lifecycle. */
export const safeInvokeStoreAction = <
  Store extends object,
  K extends StoreActionKeys<Store>,
>(
  remoteStore: RemoteStore<Store>,
  action: K,
  args: Store[K] extends (...args: infer Args) => unknown ? Args : never,
) =>
  Result.tryPromise({
    try: () => {
      const invoke = remoteStore.actions[action];
      return Promise.resolve(
        (invoke as unknown as (...values: typeof args) => PromiseLike<unknown>)(
          ...args,
        ),
      );
    },
    catch: (error) =>
      error instanceof NexusStoreDisconnectedError ||
      error instanceof NexusStoreProtocolError ||
      error instanceof NexusStoreActionError
        ? error
        : new NexusStoreActionError("Store action failed.", { cause: error }),
  });

export type SafeInvokeStoreActionError = InferErr<
  Awaited<ReturnType<typeof safeInvokeStoreAction>>
>;

/** Recognizes Core timeouts by their stable code rather than diagnostic text. */
const isCallTimeout = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "E_CALL_TIMEOUT";
