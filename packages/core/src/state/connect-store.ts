import type { NexusInstance } from "@/api/types";
import {
  ResultAsync,
  err,
  errAsync,
  ok,
  type Result,
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
import { NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL } from "@/types/symbols";

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

  return nexus
    .safeCreate(definition.token, createOptions as any)
    .mapErr(
      (error) =>
        new NexusStoreConnectError("Failed to create store proxy.", {
          cause: error,
        }),
    )
    .andThen((service) => {
      const remote = new RemoteStoreEntity<TState, TActions>(
        service as unknown as NexusStoreServiceContract<TState, TActions>,
        definition.state(),
      );

      const subscribeDisconnect = (
        service as {
          [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]?: (
            callback: () => void,
          ) => () => void;
        }
      )[NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL];

      if (typeof subscribeDisconnect === "function") {
        const unsubscribeDisconnect = subscribeDisconnect(() => {
          remote.onTransportDisconnect("Remote store connection disconnected.");
        });
        remote.setDisconnectSubscriptionCleanup(unsubscribeDisconnect);
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

      return ResultAsync.fromPromise(
        withTimeout(
          (
            service as unknown as NexusStoreServiceContract<TState, TActions>
          ).subscribe((event) => {
            remote.onSync(event);
          }),
          validatedOptions.data.timeout ?? 0,
          () =>
            new NexusStoreConnectError("Store subscribe handshake timed out."),
        ),
        (error) => {
          if (error instanceof NexusStoreConnectError) {
            return error;
          }

          if (error instanceof NexusStoreProtocolError) {
            return error;
          }

          if (error instanceof NexusStoreDisconnectedError) {
            return error;
          }

          const normalized = normalizeNexusStoreError(error);
          if (normalized instanceof NexusStoreDisconnectedError) {
            return normalized;
          }

          if (normalized instanceof NexusStoreProtocolError) {
            return normalized;
          }

          return new NexusStoreConnectError(
            "Store subscribe handshake failed.",
            {
              cause: normalized,
            },
          );
        },
      )
        .map((baseline) => {
          remote.completeHandshake(baseline);
          return baseline;
        })
        .andThen(() => {
          const validated = safeValidateHandshakeStatus();
          if (validated.isErr()) {
            return errAsync(validated.error);
          }

          return ResultAsync.fromSafePromise(Promise.resolve(validated.value));
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
  ResultAsync.fromPromise(remoteStore.actions[action](...args), (error) => {
    if (error instanceof NexusStoreDisconnectedError) {
      return error;
    }

    if (error instanceof NexusStoreProtocolError) {
      return error;
    }

    if (error instanceof NexusStoreActionError) {
      return error;
    }

    return new NexusStoreActionError("Store action failed.", { cause: error });
  });

export type SafeInvokeStoreActionError = SafeActionError;
