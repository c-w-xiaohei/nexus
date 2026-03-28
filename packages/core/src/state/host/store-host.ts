import { createStore } from "zustand/vanilla";
import {
  NexusStoreActionError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
} from "../errors";
import { ResultAsync, err, errAsync, ok, type Result } from "neverthrow";
import type {
  ActionArgs,
  ActionResult,
  NexusStoreDefinition,
  NexusStoreServiceContract,
} from "../types";
import {
  DispatchRequestEnvelopeSchema,
  type DispatchResultEnvelope,
} from "../protocol";

interface SubscriptionRecord<TState extends object> {
  readonly onSync: (event: {
    type: "snapshot";
    storeInstanceId: string;
    version: number;
    state: TState;
  }) => void;
  readonly ownerConnectionId?: string;
}

export interface StoreHostRuntime<
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
> extends NexusStoreServiceContract<TState, TActions> {
  bindSubscriptionToConnection(
    subscriptionId: string,
    connectionId: string,
  ): void;
  cleanupConnection(connectionId: string): void;
  destroy(): void;
}

interface StoreCell<TState extends object> {
  readonly snapshot: TState;
}

let subscriptionSequence = 0;

export const createStoreHost = <
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
>(
  definition: NexusStoreDefinition<TState, TActions>,
): StoreHostRuntime<TState, TActions> => {
  const storeInstanceId = `store-instance:${globalThis.crypto.randomUUID()}`;
  let version = 0;
  let destroyed = false;
  let dispatchChain: Promise<void> = Promise.resolve();
  const subscriptions = new Map<string, SubscriptionRecord<TState>>();
  const localStore = createStore<StoreCell<TState>>(() => ({
    snapshot: definition.state(),
  }));

  let workingSnapshot = localStore.getState().snapshot;
  const actions = definition.actions({
    getState: () => workingSnapshot,
    setState: (
      updaterOrState: TState | ((currentState: TState) => TState),
    ): void => {
      workingSnapshot =
        typeof updaterOrState === "function"
          ? updaterOrState(workingSnapshot)
          : updaterOrState;
    },
  });

  const safeEnsureActive = (): Result<void, NexusStoreDisconnectedError> => {
    if (destroyed) {
      return err(
        new NexusStoreDisconnectedError(
          "Nexus State host is destroyed and can no longer be used.",
        ),
      );
    }

    return ok(undefined);
  };

  const safeResolveAction = (
    action: keyof TActions & string,
  ): Result<TActions[keyof TActions & string], NexusStoreProtocolError> => {
    const actionFn = actions[action];
    if (typeof actionFn !== "function") {
      return err(
        new NexusStoreProtocolError(`Unknown store action: ${String(action)}`),
      );
    }

    return ok(actionFn);
  };

  const emitSnapshot = (snapshot: TState): void => {
    // Listener throw isolation is intentional: one broken remote callback
    // should not poison fanout, and it is treated as an orphaned subscription.
    for (const [subscriptionId, subscription] of subscriptions.entries()) {
      try {
        subscription.onSync({
          type: "snapshot",
          storeInstanceId,
          version,
          state: snapshot,
        });
      } catch {
        subscriptions.delete(subscriptionId);
      }
    }
  };

  const subscribe: StoreHostRuntime<TState, TActions>["subscribe"] = async (
    onSync,
  ) => {
    return ResultAsync.fromSafePromise(Promise.resolve(safeEnsureActive()))
      .andThen((active) =>
        active.isErr()
          ? errAsync(active.error)
          : ResultAsync.fromSafePromise(Promise.resolve(undefined)),
      )
      .map(() => {
        const subscriptionId = `store-subscription:${++subscriptionSequence}`;
        subscriptions.set(subscriptionId, {
          onSync,
        });

        const baselineSnapshot = localStore.getState().snapshot;
        return {
          storeInstanceId,
          subscriptionId,
          version,
          state: baselineSnapshot,
        };
      })
      .match(
        (value) => value,
        (error) => {
          throw error;
        },
      );
  };

  const unsubscribe: StoreHostRuntime<TState, TActions>["unsubscribe"] = async (
    subscriptionId,
  ) => {
    subscriptions.delete(subscriptionId);
  };

  const dispatch: StoreHostRuntime<TState, TActions>["dispatch"] = async (
    action,
    args,
  ) => {
    const safeParseDispatchRequest = (): Result<
      void,
      NexusStoreProtocolError
    > => {
      const parsedDispatchRequest = DispatchRequestEnvelopeSchema.safeParse({
        type: "dispatch-request",
        action,
        args,
      });
      if (!parsedDispatchRequest.success) {
        return err(
          new NexusStoreProtocolError("Invalid dispatch request envelope.", {
            cause: parsedDispatchRequest.error,
          }),
        );
      }

      return ok(undefined);
    };

    const execute = async (): Promise<
      DispatchResultEnvelope & {
        result: ActionResult<TActions, typeof action>;
      }
    > => {
      const actionFnResult = safeEnsureActive()
        .andThen(safeParseDispatchRequest)
        .andThen(() => safeResolveAction(action));

      const previousSnapshot = localStore.getState().snapshot;
      workingSnapshot = previousSnapshot;

      const run = await (
        actionFnResult.isErr()
          ? ResultAsync.fromPromise<
              ActionResult<TActions, typeof action>,
              NexusStoreProtocolError | NexusStoreDisconnectedError
            >(Promise.reject(actionFnResult.error), (error) => error as any)
          : ResultAsync.fromPromise(
              Promise.resolve().then(() =>
                actionFnResult.value(
                  ...((args ?? []) as ActionArgs<TActions, typeof action>),
                ),
              ),
              (error) =>
                new NexusStoreActionError("Store action failed.", {
                  cause: error,
                }),
            )
      )
        .map((result) => {
          const committedSnapshot = workingSnapshot;

          localStore.setState({ snapshot: committedSnapshot });
          version += 1;
          emitSnapshot(committedSnapshot);

          return {
            type: "dispatch-result" as const,
            committedVersion: version,
            result,
          };
        })
        .mapErr((error) => {
          workingSnapshot = previousSnapshot;
          return error;
        });

      if (run.isErr()) {
        throw run.error;
      }

      return run.value;
    };

    const run = dispatchChain.then(execute, execute);
    dispatchChain = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  };

  const cleanupConnection = (connectionId: string): void => {
    for (const [subscriptionId, subscription] of subscriptions.entries()) {
      if (subscription.ownerConnectionId === connectionId) {
        subscriptions.delete(subscriptionId);
      }
    }
  };

  const bindSubscriptionToConnection = (
    subscriptionId: string,
    connectionId: string,
  ): void => {
    const existing = subscriptions.get(subscriptionId);
    if (!existing) {
      return;
    }

    subscriptions.set(subscriptionId, {
      ...existing,
      ownerConnectionId: connectionId,
    });
  };

  const destroy = (): void => {
    subscriptions.clear();
    destroyed = true;
  };

  return {
    subscribe,
    unsubscribe,
    dispatch,
    bindSubscriptionToConnection,
    cleanupConnection,
    destroy,
  };
};
