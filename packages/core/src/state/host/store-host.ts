import { createStore } from "zustand/vanilla";
import {
  NexusStoreActionError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
} from "../errors";
import { Result, ResultAsync, err, errAsync, ok } from "neverthrow";
import type {
  ActionArgs,
  ActionResult,
  NexusStoreDefinition,
  NexusStoreServiceContract,
  NexusStoreValidationSchemas,
} from "../types";
import {
  DispatchRequestEnvelopeSchema,
  type DispatchResultEnvelope,
} from "../protocol";
import type { ServiceInvocationContext } from "@/service/service-invocation-hooks";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";

interface SubscriptionRecord<TState extends object> {
  readonly onSync: (event: {
    type: "snapshot";
    storeInstanceId: string;
    version: number;
    state: TState;
  }) => void;
  readonly ownerConnectionId?: string;
}

interface SubscribeOptions {
  readonly ownerConnectionId?: string;
}

export interface StoreHostRuntime<
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
> extends NexusStoreServiceContract<TState, TActions> {
  subscribe(
    onSync: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: TState;
    }) => void,
    options?: SubscribeOptions,
  ): Promise<{
    storeInstanceId: string;
    subscriptionId: string;
    version: number;
    state: TState;
  }>;
  cleanupConnection(connectionId: string): void;
  onInvokeStart(sourceConnectionId: string): ServiceInvocationContext;
  onInvokeEnd(invocationContext?: ServiceInvocationContext): void;
  resolveSubscriptionOwner(
    invocationContext?: ServiceInvocationContext,
  ): string | undefined;
  destroy(): void;
}

interface StoreCell<TState extends object> {
  readonly snapshot: TState;
}

let subscriptionSequence = 0;

class StoreHostEntity<
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
> implements StoreHostRuntime<TState, TActions> {
  private readonly storeInstanceId = `store-instance:${globalThis.crypto.randomUUID()}`;
  private version = 0;
  private destroyed = false;
  private dispatchChain: Promise<void> = Promise.resolve();
  private readonly subscriptions = new Map<
    string,
    SubscriptionRecord<TState>
  >();
  private readonly subscriptionCallbackRefCounts = new Map<object, number>();
  private readonly subscriptionsByConnection = new Map<string, Set<string>>();
  private readonly disconnectedConnections = new Set<string>();
  private readonly activeInvocationsByConnection = new Map<string, number>();
  private readonly localStore;
  private workingSnapshot: TState;
  private readonly actions: TActions;
  private readonly validation?: NexusStoreValidationSchemas<TState, TActions>;

  public constructor(definition: NexusStoreDefinition<TState, TActions>) {
    this.validation = definition.validation;
    const initialSnapshot = this.validateStateOrThrow(
      definition.state(),
      "Invalid store state payload.",
    );

    this.localStore = createStore<StoreCell<TState>>(() => ({
      snapshot: initialSnapshot,
    }));

    this.workingSnapshot = this.localStore.getState().snapshot;
    this.actions = definition.actions({
      getState: () => this.cloneSnapshot(this.workingSnapshot),
      setState: (
        updaterOrState: TState | ((currentState: TState) => TState),
      ): void => {
        const nextState =
          typeof updaterOrState === "function"
            ? updaterOrState(this.cloneSnapshot(this.workingSnapshot))
            : updaterOrState;
        this.workingSnapshot = this.cloneSnapshot(nextState);
      },
    });
  }

  public onInvokeStart(sourceConnectionId: string): ServiceInvocationContext {
    this.disconnectedConnections.delete(sourceConnectionId);
    const current =
      this.activeInvocationsByConnection.get(sourceConnectionId) ?? 0;
    this.activeInvocationsByConnection.set(sourceConnectionId, current + 1);
    return { sourceConnectionId };
  }

  public onInvokeEnd(invocationContext?: ServiceInvocationContext): void {
    const sourceConnectionId = invocationContext?.sourceConnectionId;
    if (!sourceConnectionId) {
      return;
    }

    const current =
      this.activeInvocationsByConnection.get(sourceConnectionId) ?? 0;
    if (current <= 1) {
      this.activeInvocationsByConnection.delete(sourceConnectionId);
      this.disconnectedConnections.delete(sourceConnectionId);
      return;
    }

    this.activeInvocationsByConnection.set(sourceConnectionId, current - 1);
  }

  public resolveSubscriptionOwner(
    invocationContext?: ServiceInvocationContext,
  ): string | undefined {
    return invocationContext?.sourceConnectionId;
  }

  public async subscribe(
    onSync: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: TState;
    }) => void,
    options?: SubscribeOptions,
  ): Promise<{
    storeInstanceId: string;
    subscriptionId: string;
    version: number;
    state: TState;
  }> {
    return ResultAsync.fromSafePromise(Promise.resolve(this.safeEnsureActive()))
      .andThen((active) =>
        active.isErr()
          ? errAsync(active.error)
          : ResultAsync.fromSafePromise(Promise.resolve(undefined)),
      )
      .andThen(() => {
        const ownerConnectionId = options?.ownerConnectionId;
        if (
          ownerConnectionId &&
          this.disconnectedConnections.has(ownerConnectionId)
        ) {
          return errAsync(
            new NexusStoreDisconnectedError(
              "Nexus State host subscription owner connection is already disconnected.",
            ),
          );
        }

        return ResultAsync.fromSafePromise(Promise.resolve(undefined));
      })
      .map(() => {
        const subscriptionId = `store-subscription:${++subscriptionSequence}`;
        const ownerConnectionId = options?.ownerConnectionId;
        this.retainSubscriptionCallback(onSync as unknown as object);

        this.subscriptions.set(subscriptionId, {
          onSync,
          ...(ownerConnectionId ? { ownerConnectionId } : {}),
        });

        if (ownerConnectionId) {
          const ownedSubscriptions =
            this.subscriptionsByConnection.get(ownerConnectionId) ??
            new Set<string>();
          ownedSubscriptions.add(subscriptionId);
          this.subscriptionsByConnection.set(
            ownerConnectionId,
            ownedSubscriptions,
          );
        }

        const baselineSnapshot = this.localStore.getState().snapshot;
        return {
          storeInstanceId: this.storeInstanceId,
          subscriptionId,
          version: this.version,
          state: baselineSnapshot,
        };
      })
      .match(
        (value) => value,
        (error) => {
          throw error;
        },
      );
  }

  public async unsubscribe(subscriptionId: string): Promise<void> {
    this.deleteSubscription(subscriptionId);
  }

  public async dispatch<K extends keyof TActions & string>(
    action: K,
    args: ActionArgs<TActions, K>,
  ): Promise<
    DispatchResultEnvelope & {
      result: ActionResult<TActions, K>;
    }
  > {
    const safeParseDispatchRequest = (): Result<
      void,
      NexusStoreProtocolError
    > => {
      const parsedDispatchRequestResult = Result.fromThrowable(
        () =>
          DispatchRequestEnvelopeSchema.safeParse({
            type: "dispatch-request",
            action,
            args,
          }),
        (error) => error,
      )();
      if (parsedDispatchRequestResult.isErr()) {
        return err(
          new NexusStoreProtocolError("Invalid dispatch request envelope.", {
            cause: parsedDispatchRequestResult.error,
          }),
        );
      }

      const parsedDispatchRequest = parsedDispatchRequestResult.value;
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
        result: ActionResult<TActions, K>;
      }
    > => {
      const actionFnResult = this.safeEnsureActive()
        .andThen(safeParseDispatchRequest)
        .andThen(() => this.safeResolveAction(action));

      const previousSnapshot = this.cloneSnapshot(
        this.localStore.getState().snapshot,
      );
      this.workingSnapshot = this.cloneSnapshot(previousSnapshot);

      const run = await (
        actionFnResult.isErr()
          ? ResultAsync.fromPromise<
              ActionResult<TActions, K>,
              NexusStoreProtocolError | NexusStoreDisconnectedError
            >(Promise.reject(actionFnResult.error), (error) => error as any)
          : ResultAsync.fromPromise(
              Promise.resolve().then(() =>
                actionFnResult.value(
                  ...((args ?? []) as ActionArgs<TActions, K>),
                ),
              ),
              (error) =>
                new NexusStoreActionError("Store action failed.", {
                  cause: error,
                }),
            )
      )
        .map((result) => {
          const committedSnapshot = this.validateStateOrThrow(
            this.workingSnapshot,
            "Invalid store state payload.",
          );
          const validatedResult = this.validateActionResultOrThrow(
            action,
            result,
          );

          this.localStore.setState({ snapshot: committedSnapshot });
          this.version += 1;
          this.emitSnapshot(committedSnapshot);

          return {
            type: "dispatch-result" as const,
            committedVersion: this.version,
            result: validatedResult,
          };
        })
        .mapErr((error) => {
          this.workingSnapshot = this.cloneSnapshot(previousSnapshot);
          return error;
        });

      if (run.isErr()) {
        throw run.error;
      }

      return run.value;
    };

    const run = this.dispatchChain.then(execute, execute);
    this.dispatchChain = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  public cleanupConnection(connectionId: string): void {
    if (this.activeInvocationsByConnection.has(connectionId)) {
      this.disconnectedConnections.add(connectionId);
    } else {
      this.disconnectedConnections.delete(connectionId);
    }

    const ownedSubscriptions = this.subscriptionsByConnection.get(connectionId);
    if (!ownedSubscriptions) {
      return;
    }

    for (const subscriptionId of Array.from(ownedSubscriptions)) {
      this.deleteSubscription(subscriptionId);
    }
    this.subscriptionsByConnection.delete(connectionId);
  }

  public destroy(): void {
    for (const subscriptionId of Array.from(this.subscriptions.keys())) {
      this.deleteSubscription(subscriptionId);
    }

    this.subscriptions.clear();
    this.subscriptionsByConnection.clear();
    this.disconnectedConnections.clear();
    this.activeInvocationsByConnection.clear();
    this.destroyed = true;
  }

  private safeEnsureActive(): Result<void, NexusStoreDisconnectedError> {
    if (this.destroyed) {
      return err(
        new NexusStoreDisconnectedError(
          "Nexus State host is destroyed and can no longer be used.",
        ),
      );
    }

    return ok(undefined);
  }

  private safeResolveAction(
    action: keyof TActions & string,
  ): Result<TActions[keyof TActions & string], NexusStoreProtocolError> {
    const actionFn = this.actions[action];
    if (typeof actionFn !== "function") {
      return err(
        new NexusStoreProtocolError(`Unknown store action: ${String(action)}`),
      );
    }

    return ok(actionFn);
  }

  private emitSnapshot(snapshot: TState): void {
    // Listener throw isolation is intentional: one broken remote callback
    // should not poison fanout, and it is treated as an orphaned subscription.
    for (const [subscriptionId, subscription] of this.subscriptions.entries()) {
      try {
        subscription.onSync({
          type: "snapshot",
          storeInstanceId: this.storeInstanceId,
          version: this.version,
          state: snapshot,
        });
      } catch {
        this.deleteSubscription(subscriptionId);
      }
    }
  }

  private deleteSubscription(subscriptionId: string): void {
    const existing = this.subscriptions.get(subscriptionId);
    if (!existing) {
      return;
    }

    this.subscriptions.delete(subscriptionId);
    this.releaseSubscriptionCallback(existing);

    if (!existing.ownerConnectionId) {
      return;
    }

    const ownedSubscriptions = this.subscriptionsByConnection.get(
      existing.ownerConnectionId,
    );
    if (!ownedSubscriptions) {
      return;
    }

    ownedSubscriptions.delete(subscriptionId);
    if (ownedSubscriptions.size === 0) {
      this.subscriptionsByConnection.delete(existing.ownerConnectionId);
    }
  }

  private releaseSubscriptionCallback(
    subscription: SubscriptionRecord<TState>,
  ): void {
    const callback = subscription.onSync as unknown as object;
    const currentRefCount =
      this.subscriptionCallbackRefCounts.get(callback) ?? 0;
    if (currentRefCount > 1) {
      this.subscriptionCallbackRefCounts.set(callback, currentRefCount - 1);
      return;
    }

    if (currentRefCount > 0) {
      this.subscriptionCallbackRefCounts.delete(callback);
    }

    try {
      const release = (callback as any)[RELEASE_PROXY_SYMBOL];
      if (typeof release === "function") {
        release();
      }
    } catch {
      // best-effort release only
    }
  }

  private retainSubscriptionCallback(callback: object): void {
    const current = this.subscriptionCallbackRefCounts.get(callback) ?? 0;
    this.subscriptionCallbackRefCounts.set(callback, current + 1);
  }

  private validateStateOrThrow(state: unknown, message: string): TState {
    const stateSchema = this.validation?.state;
    if (stateSchema) {
      const parsed = stateSchema.safeParse(state);
      if (!parsed.success) {
        throw new NexusStoreProtocolError(message, { cause: parsed.error });
      }

      return parsed.data;
    }

    if (typeof state !== "object" || state === null) {
      throw new NexusStoreProtocolError(message, {
        cause: new TypeError("State payload must be a non-null object."),
      });
    }

    return state as TState;
  }

  private validateActionResultOrThrow<K extends keyof TActions & string>(
    action: K,
    result: unknown,
  ): ActionResult<TActions, K> {
    const actionSchema = this.validation?.actionResults?.[action];
    if (!actionSchema) {
      return result as ActionResult<TActions, K>;
    }

    const parsed = actionSchema.safeParse(result);
    if (!parsed.success) {
      throw new NexusStoreProtocolError(
        `Invalid dispatch result payload for action "${action}".`,
        { cause: parsed.error },
      );
    }

    return parsed.data as ActionResult<TActions, K>;
  }

  private cloneSnapshot(snapshot: TState): TState {
    if (typeof globalThis.structuredClone === "function") {
      return globalThis.structuredClone(snapshot);
    }

    return JSON.parse(JSON.stringify(snapshot)) as TState;
  }
}

export const createStoreHost = <
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
>(
  definition: NexusStoreDefinition<TState, TActions>,
): StoreHostRuntime<TState, TActions> => {
  return new StoreHostEntity(definition);
};
