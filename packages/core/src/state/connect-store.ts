import type { Asyncified, RuntimeCreateTokenParam } from "../api/types";
import type { CreateOptions } from "../api/types/config";
import type { AdapterModel } from "../types/adapter-model";
import { Result, type InferErr } from "better-result";
import { TimeoutError, withTimeout } from "es-toolkit";
import { z } from "zod";
import { safeParsePayload } from "./protocol";
import {
  NexusStoreConnectError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
  normalizeNexusStoreError,
  NexusStoreActionError,
} from "./errors";
import type {
  NexusStoreServiceContract,
  RemoteStore,
  StoreActionKeys,
  StoreToken,
} from "./contract";
import { createRemoteStore } from "./remote-store";
import {
  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
} from "@/types/symbols";

const ConnectNexusStoreOptionsSchema = z.object({
  target: z
    .custom<object>(
      (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    )
    .optional(),
  where: z.function().optional(),
  timeout: z.number().nonnegative().optional(),
});

export type ConnectNexusStoreOptions<M extends AdapterModel = AdapterModel> =
  Partial<
    Pick<CreateOptions<M>, keyof z.input<typeof ConnectNexusStoreOptionsSchema>>
  >;

type SafeCreateNexusLike<M extends AdapterModel> = {
  safeCreate<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options?: CreateOptions<M>,
  ): Promise<Result<Asyncified<T>, Error>>;
};
type CreateNexusLike<M extends AdapterModel> = {
  create<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options?: CreateOptions<M>,
  ): Promise<Asyncified<T>>;
};

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
 */
export const safeConnectNexusStore = async <
  Store extends object,
  M extends AdapterModel,
>(
  nexus: SafeCreateNexusLike<M>,
  token: StoreToken<Store, M>,
  options: ConnectNexusStoreOptions<M> = {},
): Promise<
  Result<RemoteStore<Store>, ReturnType<typeof normalizeConnectHandshakeError>>
> => {
  const createError = (cause: unknown) =>
    new NexusStoreConnectError("Failed to create store proxy.", { cause });
  const parsed = safeParsePayload(
    ConnectNexusStoreOptionsSchema,
    options,
    "Invalid connect store options.",
  ).mapError(
    (error) =>
      new NexusStoreConnectError(error.message, { cause: error.cause }),
  );
  if (parsed.isErr()) return parsed;
  const { target, where, timeout } = parsed.value;
  const acquisition = Result.try({
    try: () => ({
      pending: nexus.safeCreate(token, {
        target,
        where,
        timeout,
      } as CreateOptions<M>),
    }),
    catch: createError,
  });
  if (acquisition.isErr()) return acquisition;
  // Catch both throw-style implementations and returned Errs without delaying
  // subscription behind another async composition boundary after acquisition.
  const created = await acquisition.value.pending.then(
    (result) => result.mapError(createError),
    (cause) => Result.err(createError(cause)),
  );
  if (created.isErr()) return created;
  const service = created.value as NexusStoreServiceContract<Store>;

  const remoteResult = Result.try({
    try: () => createRemoteStore<Store>(token.validation),
    catch: normalizeConnectHandshakeError,
  });
  if (remoteResult.isErr()) return remoteResult;
  const remote = remoteResult.value;

  // Observe the session before subscribe can deliver init or any update.
  const handshake = await Result.tryPromise({
    try: async () => {
      const hooks = [
        [
          NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
          () => remote.disconnect("Remote store connection disconnected."),
        ],
        [NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL, () => remote.stale()],
      ] as const;
      for (const [symbol, notify] of hooks) {
        const subscribe = (
          service as typeof service & {
            [key: symbol]: ((callback: () => void) => unknown) | undefined;
          }
        )[symbol];
        if (typeof subscribe !== "function") continue;
        const cleanup = subscribe(notify);
        if (typeof cleanup === "function")
          remote.addCleanup(cleanup as () => void);
      }

      // Init arrives through the callback, not the response. A successful response
      // is only useful when init completed and the session is still usable.
      const subscribed = Promise.resolve(
        service.subscribe((event) => remote.onSync(event)),
      );
      // Zero retains State's existing unbounded-handshake meaning.
      return timeout && Number.isFinite(timeout)
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

export const connectNexusStore = async <
  Store extends object,
  M extends AdapterModel,
>(
  nexus: SafeCreateNexusLike<M> | CreateNexusLike<M>,
  token: StoreToken<Store, M>,
  options: ConnectNexusStoreOptions<M> = {},
): Promise<RemoteStore<Store>> => {
  const safeNexus: SafeCreateNexusLike<M> =
    "safeCreate" in nexus
      ? nexus
      : {
          safeCreate: (token, createOptions) =>
            Result.tryPromise({
              try: () => nexus.create(token, createOptions),
              catch: (error) =>
                error instanceof Error ? error : new Error(String(error)),
            }),
        };
  const result = await safeConnectNexusStore(safeNexus, token, options);
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
      return (
        invoke as unknown as (...values: typeof args) => Promise<unknown>
      )(...args);
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

const isCallTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  (("code" in error && error.code === "E_CALL_TIMEOUT") ||
    /^Call #\d+ timed out/.test(error.message));
