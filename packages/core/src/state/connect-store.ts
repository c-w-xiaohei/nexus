import type { NexusInstance } from "@/api/types";
import {
  Result,
  ResultAsync,
  err,
  errAsync,
  ok,
  type ResultAsync as RA,
} from "neverthrow";
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
type SafeCreateNexusLike = Pick<NexusInstance<any, any>, "safeCreate">;
type CreateNexusLike = Pick<NexusInstance<any, any>, "create">;

type SafeActionError =
  | NexusStoreActionError
  | NexusStoreDisconnectedError
  | NexusStoreProtocolError;

const emptyTarget = { target: {} } as const;

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
>(
  nexus: SafeCreateNexusLike,
  definition: NexusStoreDefinition<TState, TActions>,
  options: ConnectNexusStoreOptions = {},
): RA<
  RemoteStore<TState, TActions>,
  NexusStoreConnectError | NexusStoreProtocolError | NexusStoreDisconnectedError
> => {
  const validatedOptions = ConnectNexusStoreOptionsSchema.safeParse(options);
  if (!validatedOptions.success) {
    return errAsync(
      new NexusStoreConnectError("Invalid connect store options.", {
        cause: validatedOptions.error,
      }),
    );
  }

  const createOptions =
    typeof validatedOptions.data.target === "undefined"
      ? ({
          ...emptyTarget,
          ...(typeof validatedOptions.data.timeout === "number"
            ? { timeout: validatedOptions.data.timeout }
            : {}),
        } as const)
      : ({
          target: validatedOptions.data.target,
          ...(typeof validatedOptions.data.timeout === "number"
            ? { timeout: validatedOptions.data.timeout }
            : {}),
        } as const);

  let safeCreateResult: RA<
    NexusStoreServiceContract<TState, TActions>,
    NexusStoreConnectError
  >;

  try {
    safeCreateResult = nexus
      .safeCreate(definition.token, createOptions as any)
      .mapErr(
        (error) =>
          new NexusStoreConnectError("Failed to create store proxy.", {
            cause: error,
          }),
      ) as RA<
      NexusStoreServiceContract<TState, TActions>,
      NexusStoreConnectError
    >;
  } catch (error) {
    return errAsync(
      new NexusStoreConnectError("Failed to create store proxy.", {
        cause: error,
      }),
    );
  }

  return safeCreateResult.andThen((service) => {
    const remoteResult = Result.fromThrowable(
      () =>
        new RemoteStoreEntity<TState, TActions>(
          service as unknown as NexusStoreServiceContract<TState, TActions>,
          definition.state(),
          definition.validation,
        ),
      normalizeConnectHandshakeError,
    )();
    if (remoteResult.isErr()) {
      return errAsync<
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

    const subscribeDisconnectResult = Result.fromThrowable(
      () =>
        (
          service as {
            [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]?: (
              callback: () => void,
            ) => unknown;
          }
        )[NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL],
      normalizeConnectHandshakeError,
    )();
    if (subscribeDisconnectResult.isErr()) {
      cleanupFailedHandshake();
      return errAsync<
        RemoteStore<TState, TActions>,
        | NexusStoreConnectError
        | NexusStoreProtocolError
        | NexusStoreDisconnectedError
      >(subscribeDisconnectResult.error);
    }

    const subscribeDisconnect = subscribeDisconnectResult.value;
    if (typeof subscribeDisconnect === "function") {
      const unsubscribeDisconnectResult = Result.fromThrowable(
        () =>
          subscribeDisconnect(() => {
            remote.onTransportDisconnect(
              "Remote store connection disconnected.",
            );
          }),
        normalizeConnectHandshakeError,
      )();

      if (unsubscribeDisconnectResult.isErr()) {
        cleanupFailedHandshake();
        return errAsync<
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

    const subscribeTargetStaleResult = Result.fromThrowable(
      () =>
        (
          service as {
            [NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL]?: (
              callback: () => void,
            ) => unknown;
          }
        )[NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL],
      normalizeConnectHandshakeError,
    )();
    if (subscribeTargetStaleResult.isErr()) {
      cleanupFailedHandshake();
      return errAsync<
        RemoteStore<TState, TActions>,
        | NexusStoreConnectError
        | NexusStoreProtocolError
        | NexusStoreDisconnectedError
      >(subscribeTargetStaleResult.error);
    }

    const subscribeTargetStale = subscribeTargetStaleResult.value;
    if (typeof subscribeTargetStale === "function") {
      const unsubscribeTargetStaleResult = Result.fromThrowable(
        () =>
          subscribeTargetStale(() => {
            remote.markStaleByTargetChange();
          }),
        normalizeConnectHandshakeError,
      )();

      if (unsubscribeTargetStaleResult.isErr()) {
        cleanupFailedHandshake();
        return errAsync<
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

    const subscribeCallResult = Result.fromThrowable(
      () =>
        (
          service as unknown as NexusStoreServiceContract<TState, TActions>
        ).subscribe((event) => {
          remote.onSync(event);
        }),
      normalizeConnectHandshakeError,
    )();

    const subscribePromise = subscribeCallResult.match(
      (promise) => Promise.resolve(promise),
      (error) => Promise.reject(error),
    );

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

    return ResultAsync.fromPromise(
      withTimeout(
        subscribePromiseWithLateCleanup,
        validatedOptions.data.timeout ?? 0,
        () =>
          new NexusStoreConnectError("Store subscribe handshake timed out."),
      ),
      normalizeConnectHandshakeError,
    )
      .map((baseline) => {
        baselineForFailedHandshakeCleanup = baseline;
        remote.completeHandshake(baseline);
        return baseline;
      })
      .andThen(() => {
        const validated = safeValidateHandshakeStatus();
        if (validated.isErr()) {
          return errAsync(validated.error);
        }

        return ResultAsync.fromPromise(
          Promise.resolve(validated.value),
          normalizeConnectHandshakeError,
        );
      })
      .mapErr((error) => {
        cleanupFailedHandshake();
        return error;
      });
  });
};

export const connectNexusStore = async <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
>(
  nexus: SafeCreateNexusLike | CreateNexusLike,
  definition: NexusStoreDefinition<TState, TActions>,
  options: ConnectNexusStoreOptions = {},
): Promise<RemoteStore<TState, TActions>> => {
  const safeNexus: SafeCreateNexusLike =
    "safeCreate" in nexus
      ? { safeCreate: nexus.safeCreate.bind(nexus) }
      : {
          safeCreate: (token, createOptions) =>
            ResultAsync.fromPromise(
              nexus.create(token as any, createOptions as any),
              (error) =>
                error instanceof Error ? error : new Error(String(error)),
            ),
        };

  return safeConnectNexusStore(safeNexus, definition, options).match(
    (value) => value,
    (error) => {
      throw error;
    },
  );
};

export const safeInvokeStoreAction = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  K extends keyof TActions & string,
>(
  remoteStore: RemoteStore<TState, TActions>,
  action: K,
  args: ActionArgs<TActions, K>,
): RA<ActionResult<TActions, K>, SafeActionError> =>
  ResultAsync.fromPromise(
    Result.fromThrowable(
      () => {
        const actions = remoteStore.actions;
        const invoke = actions[action] as (
          ...invokeArgs: ActionArgs<TActions, K>
        ) => Promise<ActionResult<TActions, K>>;
        return invoke(...args);
      },
      (error) => error,
    )().match(
      (promise) => promise,
      (error) => Promise.reject(error),
    ),
    (error) => {
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
  );

export type SafeInvokeStoreActionError = SafeActionError;
