import type { Asyncified, RuntimeCreateToken } from "../api/types/index.js";
import type { Token } from "../api/token.js";
import type { CreateOptions } from "../api/types/config.js";
import type { EndpointMeta, PlatformMeta } from "../types/identity.js";
import { Result } from "better-result";
const { err, ok } = Result;
import {
  NexusStoreConnectError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
  normalizeNexusStoreError,
  NexusStoreActionError,
} from "./errors.js";
import { ConnectNexusStoreOptionsSchema } from "./protocol.js";
import type {
  ActionArgs,
  ActionResult,
  ConnectNexusStoreOptions,
  NexusStoreDefinition,
  NexusStoreServiceContract,
  RemoteStore,
} from "./types.js";
import { RemoteStoreEntity } from "./client/remote-store.js";
import {
  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
} from "../types/symbols.js";

type ActionFunction = (...args: any[]) => any;
type SafeCreateNexusLike<U extends EndpointMeta, P extends PlatformMeta> = {
  safeCreate<TToken extends Token<any, any>>(
    token: TToken & RuntimeCreateToken<U, NoInfer<TToken>>,
    options?: CreateOptions<U, never, never>,
  ): Promise<
    Result<
      Asyncified<TToken extends Token<infer T, infer _U> ? T : never>,
      Error
    >
  >;
} & { readonly __platformMeta?: P };
type CreateNexusLike<U extends EndpointMeta, P extends PlatformMeta> = {
  create<TToken extends Token<any, any>>(
    token: TToken & RuntimeCreateToken<U, NoInfer<TToken>>,
    options?: CreateOptions<U, never, never>,
  ): Promise<Asyncified<TToken extends Token<infer T, infer _U> ? T : never>>;
} & { readonly __platformMeta?: P };

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
  U extends EndpointMeta,
  P extends PlatformMeta,
>(
  nexus: SafeCreateNexusLike<U, P>,
  definition: NexusStoreDefinition<TState, TActions, U>,
  options: ConnectNexusStoreOptions<U> = {},
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
      );
  } catch (error) {
    return Promise.resolve(
      err(
        new NexusStoreConnectError("Failed to create store proxy.", {
          cause: error,
        }),
      ),
    );
  }

  return safeCreateResult.then(async (createResult) => {
    if (createResult.isErr()) {
      return err(createResult.error);
    }

    const service = createResult.value;
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
      return err(remoteResult.error);
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
      return err(subscribeDisconnectResult.error);
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
        return err(unsubscribeDisconnectResult.error);
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
      return err(subscribeTargetStaleResult.error);
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
        return err(unsubscribeTargetStaleResult.error);
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

    let subscribePromise: ReturnType<
      NexusStoreServiceContract<TState, TActions>["subscribe"]
    >;
    try {
      subscribePromise = (
        service as unknown as NexusStoreServiceContract<TState, TActions>
      ).subscribe((event) => {
        remote.onSync(event);
      });
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

    return Result.tryPromise({
      try: () =>
        withTimeout(
          subscribePromiseWithLateCleanup,
          validatedOptions.data.timeout ?? 0,
          () =>
            new NexusStoreConnectError("Store subscribe handshake timed out."),
        ),
      catch: normalizeConnectHandshakeError,
    }).then((result) => {
      if (result.isErr()) {
        cleanupFailedHandshake();
        return err(result.error);
      }

      baselineForFailedHandshakeCleanup = result.value;
      remote.completeHandshake(result.value);
      const validated = safeValidateHandshakeStatus();
      if (validated.isErr()) {
        cleanupFailedHandshake();
        return err(validated.error);
      }

      return validated;
    });
  });
};

export const connectNexusStore = async <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  U extends EndpointMeta,
  P extends PlatformMeta,
>(
  nexus: SafeCreateNexusLike<U, P> | CreateNexusLike<U, P>,
  definition: NexusStoreDefinition<TState, TActions, U>,
  options: ConnectNexusStoreOptions<U> = {},
): Promise<RemoteStore<TState, TActions>> => {
  const safeNexus: SafeCreateNexusLike<U, P> =
    "safeCreate" in nexus
      ? { safeCreate: nexus.safeCreate.bind(nexus) }
      : {
          safeCreate: <TToken extends Token<any, any>>(
            token: TToken & RuntimeCreateToken<U, NoInfer<TToken>>,
            createOptions?: CreateOptions<U, never, never>,
          ) =>
            Result.tryPromise({
              try: () => nexus.create<TToken>(token, createOptions),
              catch: (error) =>
                error instanceof Error ? error : new Error(String(error)),
            }),
        };

  const result = await safeConnectNexusStore(safeNexus, definition, options);
  if (result.isErr()) {
    throw result.error;
  }
  return result.value;
};

export const safeInvokeStoreAction = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  K extends keyof TActions & string,
>(
  remoteStore: RemoteStore<TState, TActions>,
  action: K,
  args: ActionArgs<TActions, K>,
): Promise<Result<ActionResult<TActions, K>, SafeActionError>> => {
  let invocation: Promise<ActionResult<TActions, K>>;
  try {
    const actions = remoteStore.actions;
    const invoke = actions[action] as (
      ...invokeArgs: ActionArgs<TActions, K>
    ) => Promise<ActionResult<TActions, K>>;
    invocation = invoke(...args);
  } catch (error) {
    return Promise.resolve(
      err(
        error instanceof NexusStoreActionError ||
          error instanceof NexusStoreDisconnectedError ||
          error instanceof NexusStoreProtocolError
          ? error
          : new NexusStoreActionError("Store action failed.", { cause: error }),
      ),
    );
  }
  return invocation
    .then((value) => ok(value))
    .catch((error) => {
      return err(
        error instanceof NexusStoreDisconnectedError ||
          error instanceof NexusStoreProtocolError ||
          error instanceof NexusStoreActionError
          ? error
          : new NexusStoreActionError("Store action failed.", { cause: error }),
      );
    });
};

export type SafeInvokeStoreActionError = SafeActionError;
