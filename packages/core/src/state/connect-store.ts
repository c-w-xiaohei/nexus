import type { Asyncified, RuntimeCreateTokenParam } from "@/api/types";
import type { CreateOptions } from "@/api/types/config";
import type { AdapterModel } from "@/types/adapter-model";
import { Result } from "better-result";
const { err, ok } = Result;
import {
  NexusStoreConnectError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
  normalizeNexusStoreError,
  NexusStoreActionError,
} from "./errors";
import { ConnectNexusStoreOptionsSchema } from "./protocol";
import type {
  ActionArgs,
  ActionResult,
  ConnectNexusStoreOptions,
  NexusStoreDefinition,
  NexusStoreServiceContract,
  RemoteStore,
} from "./types";
import { RemoteStoreEntity } from "./client/remote-store";
import {
  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
} from "@/types/symbols";

type ActionFunction = (...args: any[]) => any;
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

type SafeActionError =
  | NexusStoreActionError
  | NexusStoreDisconnectedError
  | NexusStoreProtocolError;

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(onTimeout());
    }, timeoutMs);

    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
};

const extractSubscriptionId = (baseline: unknown): string | null => {
  if (typeof baseline !== "object" || baseline === null) {
    return null;
  }

  const maybeSubscriptionId = (baseline as { subscriptionId?: unknown })
    .subscriptionId;
  return typeof maybeSubscriptionId === "string" ? maybeSubscriptionId : null;
};

const normalizeConnectHandshakeError = (
  error: unknown,
):
  | NexusStoreConnectError
  | NexusStoreProtocolError
  | NexusStoreDisconnectedError => {
  if (
    error instanceof NexusStoreConnectError ||
    error instanceof NexusStoreProtocolError ||
    error instanceof NexusStoreDisconnectedError
  ) {
    return error;
  }

  const normalized = normalizeNexusStoreError(error);
  if (
    normalized instanceof NexusStoreProtocolError ||
    normalized instanceof NexusStoreDisconnectedError
  ) {
    return normalized;
  }

  return new NexusStoreConnectError("Store subscribe handshake failed.", {
    cause: normalized,
  });
};

export const safeConnectNexusStore = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  M extends AdapterModel,
>(
  nexus: SafeCreateNexusLike<M>,
  definition: NexusStoreDefinition<TState, TActions, M>,
  options: ConnectNexusStoreOptions<M> = {},
): Promise<
  Result<
    RemoteStore<TState, TActions>,
    | NexusStoreConnectError
    | NexusStoreProtocolError
    | NexusStoreDisconnectedError
  >
> => {
  const validatedOptions = ConnectNexusStoreOptionsSchema.safeParse(options);
  if (!validatedOptions.success) {
    return Promise.resolve(
      err(
        new NexusStoreConnectError("Invalid connect store options.", {
          cause: validatedOptions.error,
        }),
      ),
    );
  }

  const createOptions: CreateOptions<M> =
    typeof validatedOptions.data.target === "undefined"
      ? ({
          ...(validatedOptions.data.where
            ? { where: validatedOptions.data.where }
            : {}),
          ...(typeof validatedOptions.data.timeout === "number"
            ? {
                timeout: validatedOptions.data.timeout,
                callTimeout: validatedOptions.data.timeout,
              }
            : {}),
        } as CreateOptions<M>)
      : ({
          target: validatedOptions.data.target,
          ...(validatedOptions.data.where
            ? { where: validatedOptions.data.where }
            : {}),
          ...(typeof validatedOptions.data.timeout === "number"
            ? {
                timeout: validatedOptions.data.timeout,
                callTimeout: validatedOptions.data.timeout,
              }
            : {}),
        } as CreateOptions<M>);

  let safeCreateResult: Promise<
    Result<NexusStoreServiceContract<TState, TActions>, NexusStoreConnectError>
  >;

  try {
    safeCreateResult = nexus
      .safeCreate(definition.token, createOptions)
      .then((result) =>
        result.mapError(
          (error) =>
            new NexusStoreConnectError("Failed to create store proxy.", {
              cause: error,
            }),
        ),
      ) as Promise<
      Result<
        NexusStoreServiceContract<TState, TActions>,
        NexusStoreConnectError
      >
    >;
  } catch (error) {
    return Promise.resolve(
      err(
        new NexusStoreConnectError("Failed to create store proxy.", {
          cause: error,
        }),
      ),
    );
  }

  return safeCreateResult.then(async (created) =>
    created.andThenAsync(async (service) => {
      const remoteResult = Result.try({
        try: () =>
          new RemoteStoreEntity<TState, TActions>(
            service as unknown as NexusStoreServiceContract<TState, TActions>,
            definition.state(),
            definition.validation,
          ),
        catch: normalizeConnectHandshakeError,
      });
      if (remoteResult.isErr()) {
        return err<
          RemoteStore<TState, TActions>,
          | NexusStoreConnectError
          | NexusStoreProtocolError
          | NexusStoreDisconnectedError
        >(remoteResult.error);
      }

      const remote = remoteResult.value;

      let handshakeFailed = false;
      let baselineForFailedHandshakeCleanup: unknown | null = null;

      const cleanupFailedHandshake = (): void => {
        handshakeFailed = true;

        const subscriptionId = extractSubscriptionId(
          baselineForFailedHandshakeCleanup,
        );
        if (subscriptionId) {
          try {
            void Promise.resolve(service.unsubscribe(subscriptionId)).catch(
              () => undefined,
            );
          } catch {
            // Best-effort cleanup only.
          }
        }

        remote.destroy();
      };

      const subscribeDisconnectResult = Result.try({
        try: () =>
          (
            service as {
              [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]?: (
                callback: () => void,
              ) => unknown;
            }
          )[NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL],
        catch: normalizeConnectHandshakeError,
      });
      if (subscribeDisconnectResult.isErr()) {
        cleanupFailedHandshake();
        return err<
          RemoteStore<TState, TActions>,
          | NexusStoreConnectError
          | NexusStoreProtocolError
          | NexusStoreDisconnectedError
        >(subscribeDisconnectResult.error);
      }

      const subscribeDisconnect = subscribeDisconnectResult.value;
      if (typeof subscribeDisconnect === "function") {
        const unsubscribeDisconnectResult = Result.try({
          try: () =>
            subscribeDisconnect(() => {
              remote.onTransportDisconnect(
                "Remote store connection disconnected.",
              );
            }),
          catch: normalizeConnectHandshakeError,
        });

        if (unsubscribeDisconnectResult.isErr()) {
          cleanupFailedHandshake();
          return err<
            RemoteStore<TState, TActions>,
            | NexusStoreConnectError
            | NexusStoreProtocolError
            | NexusStoreDisconnectedError
          >(unsubscribeDisconnectResult.error);
        }

        if (typeof unsubscribeDisconnectResult.value === "function") {
          remote.setDisconnectSubscriptionCleanup(
            unsubscribeDisconnectResult.value as () => void,
          );
        }
      }

      const subscribeTargetStaleResult = Result.try({
        try: () =>
          (
            service as {
              [NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL]?: (
                callback: () => void,
              ) => unknown;
            }
          )[NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL],
        catch: normalizeConnectHandshakeError,
      });
      if (subscribeTargetStaleResult.isErr()) {
        cleanupFailedHandshake();
        return err<
          RemoteStore<TState, TActions>,
          | NexusStoreConnectError
          | NexusStoreProtocolError
          | NexusStoreDisconnectedError
        >(subscribeTargetStaleResult.error);
      }

      const subscribeTargetStale = subscribeTargetStaleResult.value;
      if (typeof subscribeTargetStale === "function") {
        const unsubscribeTargetStaleResult = Result.try({
          try: () =>
            subscribeTargetStale(() => {
              remote.markStaleByTargetChange();
            }),
          catch: normalizeConnectHandshakeError,
        });

        if (unsubscribeTargetStaleResult.isErr()) {
          cleanupFailedHandshake();
          return err<
            RemoteStore<TState, TActions>,
            | NexusStoreConnectError
            | NexusStoreProtocolError
            | NexusStoreDisconnectedError
          >(unsubscribeTargetStaleResult.error);
        }

        if (typeof unsubscribeTargetStaleResult.value === "function") {
          remote.setDisconnectSubscriptionCleanup(
            unsubscribeTargetStaleResult.value as () => void,
          );
        }
      }

      const safeValidateHandshakeStatus = (): Result<
        RemoteStore<TState, TActions>,
        NexusStoreProtocolError | NexusStoreDisconnectedError
      > => {
        const status = remote.getStatus();
        if (status.type === "disconnected") {
          return err(
            remote.getTerminalError() ??
              new NexusStoreDisconnectedError(
                "Remote store disconnected during initial handshake.",
              ),
          );
        }

        if (status.type === "stale") {
          return err(
            remote.getTerminalError() ??
              new NexusStoreProtocolError(
                "Remote store became stale during initial handshake.",
              ),
          );
        }

        return ok(remote as RemoteStore<TState, TActions>);
      };

      let subscribePromise: Promise<unknown>;
      try {
        subscribePromise = Promise.resolve(
          (
            service as unknown as NexusStoreServiceContract<TState, TActions>
          ).subscribe((event) => {
            remote.onSync(event);
          }),
        );
      } catch (error) {
        cleanupFailedHandshake();
        return err(normalizeConnectHandshakeError(error));
      }

      const subscribePromiseWithLateCleanup = subscribePromise.then(
        (baseline) => {
          if (handshakeFailed) {
            const lateSubscriptionId = extractSubscriptionId(baseline);
            if (lateSubscriptionId) {
              try {
                void Promise.resolve(
                  service.unsubscribe(lateSubscriptionId),
                ).catch(() => undefined);
              } catch {
                // Best-effort cleanup only.
              }
            }
          }

          return baseline;
        },
      );

      const handshake = await Result.tryPromise({
        try: () =>
          withTimeout(
            subscribePromiseWithLateCleanup,
            validatedOptions.data.timeout ?? 0,
            () =>
              new NexusStoreConnectError(
                "Store subscribe handshake timed out.",
              ),
          ),
        catch: normalizeConnectHandshakeError,
      });
      return handshake
        .map((baseline) => {
          baselineForFailedHandshakeCleanup = baseline;
          remote.completeHandshake(baseline);
          return baseline;
        })
        .andThen(() => {
          const validated = safeValidateHandshakeStatus();
          if (validated.isErr()) {
            return err(validated.error);
          }

          return ok(validated.value);
        })
        .mapError((error) => {
          cleanupFailedHandshake();
          return isCallTimeout(error)
            ? new NexusStoreConnectError(
                "Store subscribe handshake timed out.",
                {
                  cause: error,
                },
              )
            : error;
        });
    }),
  );
};

export const connectNexusStore = async <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  M extends AdapterModel,
>(
  nexus: SafeCreateNexusLike<M> | CreateNexusLike<M>,
  definition: NexusStoreDefinition<TState, TActions, M>,
  options: ConnectNexusStoreOptions<M> = {},
): Promise<RemoteStore<TState, TActions>> => {
  const safeNexus: SafeCreateNexusLike<M> =
    "safeCreate" in nexus
      ? { safeCreate: nexus.safeCreate.bind(nexus) }
      : {
          safeCreate: <T extends object>(
            token: RuntimeCreateTokenParam<T, M>,
            createOptions?: CreateOptions<M>,
          ) =>
            Result.tryPromise({
              try: () => nexus.create<T>(token, createOptions),
              catch: (error) =>
                error instanceof Error ? error : new Error(String(error)),
            }),
        };

  const result = await safeConnectNexusStore(safeNexus, definition, options);
  if (result.isErr()) throw result.error;
  return result.value;
};

export const safeInvokeStoreAction = async <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  K extends keyof TActions & string,
>(
  remoteStore: RemoteStore<TState, TActions>,
  action: K,
  args: ActionArgs<TActions, K>,
): Promise<Result<ActionResult<TActions, K>, SafeActionError>> => {
  try {
    const actions = remoteStore.actions;
    const invoke = actions[action] as (
      ...invokeArgs: ActionArgs<TActions, K>
    ) => Promise<ActionResult<TActions, K>>;
    return await Result.tryPromise({
      try: () => invoke(...args),
      catch: (error) => {
        if (error instanceof NexusStoreDisconnectedError) {
          return error;
        }

        if (error instanceof NexusStoreProtocolError) {
          return error;
        }

        if (error instanceof NexusStoreActionError) {
          return error;
        }

        return new NexusStoreActionError("Store action failed.", {
          cause: error,
        });
      },
    });
  } catch (error) {
    return err(
      error instanceof NexusStoreDisconnectedError ||
        error instanceof NexusStoreProtocolError ||
        error instanceof NexusStoreActionError
        ? error
        : new NexusStoreActionError("Store action failed.", { cause: error }),
    );
  }
};

export type SafeInvokeStoreActionError = SafeActionError;

const isCallTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  (("code" in error && error.code === "E_CALL_TIMEOUT") ||
    /^Call #\d+ timed out/.test(error.message));
