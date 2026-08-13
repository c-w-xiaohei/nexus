import { createStore } from "zustand/vanilla";
import {
  NexusStoreActionError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
} from "../errors.js";
import { Result } from "better-result";
const { err, ok } = Result;
import type {
  ActionArgs,
  ActionResult,
  ActionFunction,
  NexusStoreDefinition,
  NexusStoreServiceContract,
  NexusStoreValidationSchemas,
} from "../types.js";
import {
  DispatchRequestEnvelopeSchema,
  type DispatchResultEnvelope,
} from "../protocol.js";
import type { ServiceInvocationContext } from "../../service/service-invocation-hooks.js";
import { RELEASE_PROXY_SYMBOL } from "../../types/symbols.js";

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
  getSnapshot(): {
    storeInstanceId: string;
    version: number;
    state: TState;
  };
  subscribeLocal(
    onSync: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: TState;
    }) => void,
  ): string;
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
  onInvokeStart(
    invocationContext: ServiceInvocationContext | string,
  ): ServiceInvocationContext;
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
let storeInstanceSequence = 0;

const createStoreInstanceId = (): string => {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return `store-instance:${randomUuid}`;
  }

  storeInstanceSequence += 1;
  return `store-instance:fallback-${storeInstanceSequence}`;
};

class StoreHostEntity<
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
> implements StoreHostRuntime<TState, TActions> {
  private readonly storeInstanceId = createStoreInstanceId();
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

  public constructor(definition: NexusStoreDefinition<TState, TActions, any>) {
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

  public onInvokeStart(
    invocationContext: ServiceInvocationContext | string,
  ): ServiceInvocationContext {
    const normalizedInvocationContext: ServiceInvocationContext =
      typeof invocationContext === "string"
        ? {
            sourceConnectionId: invocationContext,
            sourceIdentity: undefined,
            localIdentity: undefined,
            platform: undefined,
          }
        : invocationContext;

    const sourceConnectionId = normalizedInvocationContext.sourceConnectionId;
    this.disconnectedConnections.delete(sourceConnectionId);
    const current =
      this.activeInvocationsByConnection.get(sourceConnectionId) ?? 0;
    this.activeInvocationsByConnection.set(sourceConnectionId, current + 1);
    return normalizedInvocationContext;
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

  public getSnapshot(): {
    storeInstanceId: string;
    version: number;
    state: TState;
  } {
    return {
      storeInstanceId: this.storeInstanceId,
      version: this.version,
      state: this.cloneSnapshot(this.localStore.getState().snapshot),
    };
  }

  public subscribeLocal(
    onSync: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: TState;
    }) => void,
  ): string {
    const active = this.safeEnsureActive();
    if (active.isErr()) {
      throw active.error;
    }

    return this.addSubscription(onSync).subscriptionId;
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
    const active = this.safeEnsureActive();
    if (active.isErr()) throw active.error;
    if (
      options?.ownerConnectionId &&
      this.disconnectedConnections.has(options.ownerConnectionId)
    ) {
      throw new NexusStoreDisconnectedError(
        "Nexus State host subscription owner connection is already disconnected.",
      );
    }
    return this.addSubscription(onSync, options?.ownerConnectionId);
  }

  public async unsubscribe(subscriptionId: string): Promise<void> {
    this.deleteSubscription(subscriptionId);
  }

  public async dispatch<K extends keyof TActions & string>(
    action: K,
    args: ActionArgs<TActions, K>,
    _invocationContext?: ServiceInvocationContext,
  ): Promise<
    DispatchResultEnvelope & {
      result: ActionResult<TActions, K>;
    }
  > {
    const safeParseDispatchRequest = (): Result<
      void,
      NexusStoreProtocolError
    > => {
      const parsedDispatchRequestResult = Result.try({
        try: () =>
          DispatchRequestEnvelopeSchema.safeParse({
            type: "dispatch-request",
            action,
            args,
          }),
        catch: (error) => error,
      });
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

      const run = actionFnResult.isErr()
        ? actionFnResult
        : await Result.tryPromise({
            try: () =>
              Promise.resolve().then(() =>
                actionFnResult.value(
                  ...((args ?? []) as ActionArgs<TActions, K>),
                ),
              ),
            catch: (error) =>
              new NexusStoreActionError("Store action failed.", {
                cause: error,
              }),
          });
      const completed: Result<
        DispatchResultEnvelope & { result: ActionResult<TActions, K> },
        Error
      > = run.isErr()
        ? err(run.error)
        : (() => {
            try {
              const result = run.value;
              const activeBeforeCommit = this.safeEnsureActive();
              if (activeBeforeCommit.isErr()) {
                throw activeBeforeCommit.error;
              }

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

              return ok({
                type: "dispatch-result" as const,
                committedVersion: this.version,
                result: validatedResult,
              });
            } catch (error) {
              return err(
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          })();

      if (completed.isErr()) {
        this.workingSnapshot = this.cloneSnapshot(previousSnapshot);
        throw completed.error;
      }

      return completed.value;
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
          state: this.cloneSnapshot(snapshot),
        });
      } catch {
        this.deleteSubscription(subscriptionId);
      }
    }
  }

  private addSubscription(
    onSync: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: TState;
    }) => void,
    ownerConnectionId?: string,
  ): {
    storeInstanceId: string;
    subscriptionId: string;
    version: number;
    state: TState;
  } {
    const subscriptionId = `store-subscription:${++subscriptionSequence}`;
    const baselineSnapshot = this.localStore.getState().snapshot;
    const baselineState = this.cloneSnapshot(baselineSnapshot);

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
      this.subscriptionsByConnection.set(ownerConnectionId, ownedSubscriptions);
    }

    return {
      storeInstanceId: this.storeInstanceId,
      subscriptionId,
      version: this.version,
      state: baselineState,
    };
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
  TActions extends Record<string, ActionFunction>,
>(
  definition: NexusStoreDefinition<TState, TActions, any>,
): StoreHostRuntime<TState, TActions> => {
  return new StoreHostEntity(definition);
};
