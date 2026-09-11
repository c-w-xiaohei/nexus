import {
  createStore,
  type Mutate,
  type StateCreator,
  type StoreApi,
  type StoreMutatorIdentifier,
} from "zustand/vanilla";
import { Result, type InferErr } from "better-result";
import { withTimeout } from "es-toolkit";
import { z } from "zod";
import type { ServiceProvider } from "../api/types/config";
import type { AdapterModel } from "../types/adapter-model";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import {
  SERVICE_INVOKE_START,
  SERVICE_ON_DISCONNECT,
  type ServiceInvocationContext,
} from "@/service/service-invocation-hooks";
import { Logger } from "@/logger";
import {
  NexusStoreActionError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
} from "./errors";
import { safeParsePayload, safeValidateState } from "./protocol";
import type { SyncEnvelope, TerminalReason } from "./protocol";
import type {
  ActionFunction,
  NexusStoreDefinition,
  NexusStoreServiceContract,
  RemoteActions,
} from "./contract";

const PublicationOptionsSchema = z.object({
  /** Fixed window starting at the first change, not a debounce. Default: 200ms. */
  publishWindowMs: z.number().min(0).max(2_147_483_647).default(200),
  /** Maximum unacknowledged deliveries per subscription. Default: 32. */
  maxPendingSnapshots: z.number().int().positive().default(32),
});

export interface BindNexusStoreOptions<
  T,
  S,
  A,
  Keys extends readonly (keyof A & string)[] = readonly (keyof A & string)[],
> extends z.input<typeof PublicationOptionsSchema> {
  /** Pure projection of the data this provider may share. */
  snapshot(state: T): S;
  /** Only these local action keys become remote capabilities. */
  expose: Keys &
    (Exclude<keyof A, Keys[number]> extends never ? unknown : never);
}

export interface NexusStoreBinding<
  S extends object,
  A extends Record<string, ActionFunction>,
  M extends AdapterModel,
> extends Disposable {
  provider: ServiceProvider<NexusStoreServiceContract<S, A>, M>;
  /** Stops this binding and its remote sessions; the original store remains usable. */
  destroy(): void;
}

/** Only public configuration and RPC boundaries convert an Err into an exception. */
function unwrapResultOrThrow<T>(result: Result<T, unknown>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

/**
 * Observes a completed vanilla store without replacing its API or middleware.
 * Remote actions wait for their caller's fixed publication batch, without transactions.
 */
export function bindNexusStore<
  T extends A,
  S extends object,
  A extends Record<string, ActionFunction>,
  M extends AdapterModel,
  const Keys extends readonly (keyof A & string)[],
>(
  definition: NexusStoreDefinition<S, A, M>,
  store: { getState(): T; subscribe: StoreApi<NoInfer<T>>["subscribe"] },
  options: BindNexusStoreOptions<NoInfer<T>, S, A, Keys>,
): NexusStoreBinding<S, A, M> {
  type Subscription = {
    callback: Parameters<NexusStoreServiceContract<S, A>["subscribe"]>[0];
    owner?: string;
    delivery: ReturnType<typeof createDelivery>;
    inFlight: Set<ReturnType<typeof createDelivery>>;
  };
  const names = [...new Set(options.expose)];
  const { publishWindowMs: windowMs, maxPendingSnapshots: limit } =
    unwrapResultOrThrow(
      safeParsePayload(
        PublicationOptionsSchema,
        options,
        "Invalid State publication limits.",
      ),
    );
  if (
    names.some(
      (name) => name === "then" || typeof store.getState()[name] !== "function",
    )
  )
    throw new NexusStoreProtocolError(
      "Exposed State actions must be callable and cannot be named then.",
    );

  const logger = new Logger("StateBinding");
  const storeInstanceId = crypto.randomUUID();
  const subscriptions = new Set<Subscription>();
  const connections = new Map<string, symbol>();
  const contexts = new WeakMap<ServiceInvocationContext, symbol>();
  let destroyed = false;
  let version = 0;
  let observed = store.getState();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<Subscription>();
  const disconnected = (cause?: unknown) =>
    new NexusStoreDisconnectedError(
      "State subscription closed before acknowledgement; the action may have executed.",
      { cause },
    );
  const safeActive = (subscription: Subscription) =>
    subscriptions.has(subscription)
      ? Result.ok(undefined)
      : Result.err(disconnected());
  const hasCallback = (callback: Subscription["callback"]) =>
    [...subscriptions].some(
      (subscription) => subscription.callback === callback,
    );
  const releaseCallback = (callback: Subscription["callback"]) => {
    if (hasCallback(callback)) return;
    try {
      (
        callback as typeof callback & {
          [RELEASE_PROXY_SYMBOL]?: () => void;
        }
      )[RELEASE_PROXY_SYMBOL]?.();
    } catch {
      /* Core may already have reclaimed the capability. */
    }
  };
  const safeCapture = () => {
    const source = store.getState();
    const snapshotVersion = version;
    return Result.try({
      try: () => ({ state: structuredClone(options.snapshot(source)) }),
      catch: (cause) =>
        new NexusStoreProtocolError("State snapshot failed.", { cause }),
    })
      .andThen(({ state }) =>
        safeValidateState(
          state,
          definition.validation?.state,
          "Invalid State snapshot.",
        ),
      )
      .andThen((state) => {
        if (
          source !== store.getState() ||
          snapshotVersion !== version ||
          destroyed
        )
          return Result.err(
            new NexusStoreProtocolError(
              "State changed during snapshot projection or validation.",
            ),
          );
        return Result.ok({ storeInstanceId, version: snapshotVersion, state });
      });
  };

  type DeliveryResult = Result<
    void,
    InferErr<ReturnType<typeof safeCapture>> | ReturnType<typeof disconnected>
  >;
  function createDelivery() {
    let complete!: (result: DeliveryResult) => void;
    const promise = new Promise<DeliveryResult>((resolve) => {
      complete = resolve;
    });
    return { promise, complete };
  }

  const safeNotify = (
    callback: Subscription["callback"],
    event: SyncEnvelope<S, A>,
  ) =>
    Result.tryPromise({
      // Direct callbacks need the same finite boundary and isolated data as RPC callbacks.
      try: () =>
        withTimeout(async () => {
          await callback(
            event.type === "terminal"
              ? event
              : {
                  ...event,
                  state: structuredClone(event.state),
                },
          );
        }, 5000),
      catch: disconnected,
    });

  const closeSubscription = (
    subscription: Subscription,
    error = disconnected(),
    reason?: TerminalReason,
  ) => {
    if (!subscriptions.delete(subscription)) return;
    const result = Result.err(error);
    subscription.delivery.complete(result);
    for (const delivery of subscription.inFlight) delivery.complete(result);
    subscription.inFlight.clear();
    pending.delete(subscription);
    if (!pending.size && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const { callback } = subscription;
    if (!reason) {
      releaseCallback(callback);
      return;
    }
    // A terminal callback can reenter subscribe. Only the final owner may release it.
    const lastOwner = !hasCallback(callback);
    void safeNotify(callback, {
      type: "terminal",
      storeInstanceId,
      lastKnownVersion: version,
      reason,
      error,
    }).then((sent) => {
      sent.tapError((cause) =>
        logger.error("State terminal delivery failed", cause),
      );
      if (lastOwner) releaseCallback(callback);
    });
  };

  const deliver = (
    subscription: Subscription,
    delivery: ReturnType<typeof createDelivery>,
    event: Result<
      Exclude<SyncEnvelope<S, A>, { type: "terminal" }>,
      InferErr<DeliveryResult>
    >,
  ) => {
    const ready = safeActive(subscription).andThen(() =>
      event.isOk() && subscription.inFlight.size >= limit
        ? Result.err(
            disconnected(
              "State subscriber exceeded its pending snapshot budget.",
            ),
          )
        : event,
    );
    const complete = (sent: DeliveryResult) => {
      subscription.inFlight.delete(delivery);
      if (sent.isErr())
        closeSubscription(subscription, sent.error, "source-disconnected");
      delivery.complete(sent);
    };
    if (ready.isErr()) complete(ready);
    else {
      subscription.inFlight.add(delivery);
      void safeNotify(subscription.callback, ready.value).then(complete);
    }
  };

  const publish = () => {
    timer = undefined;
    // Capture deliveries before callbacks: reentrant writes reserve a different batch.
    const batch = [...pending].map(
      (subscription) => [subscription, subscription.delivery] as const,
    );
    pending.clear();
    const snapshot = safeCapture().map((snapshot) => ({
      type: "snapshot" as const,
      ...snapshot,
    }));
    for (const [subscription, delivery] of batch)
      deliver(subscription, delivery, snapshot);
  };

  // Reserve a promise before publication so concurrent calls capture a fixed batch.
  const onChange = () => {
    const state = store.getState();
    if (destroyed || observed === state) return;
    observed = state;
    version++;
    for (const subscription of subscriptions) {
      if (pending.has(subscription)) continue;
      subscription.delivery = createDelivery();
      pending.add(subscription);
    }
    if (!pending.size || timer !== undefined) return;
    timer = setTimeout(publish, windowMs);
  };
  const unsubscribeStore = store.subscribe(onChange);

  const safeInvoke = async (
    subscription: Subscription,
    name: keyof A & string,
    values: unknown[],
  ) => {
    if (contexts.has(values.at(-1) as ServiceInvocationContext)) values.pop();
    // No async boundary may separate the liveness check from starting the action.
    const active = safeActive(subscription);
    if (active.isErr()) return active;
    const execution = await Result.tryPromise({
      try: async () => {
        const current = store.getState();
        return Reflect.apply(current[name], current, values);
      },
      catch: (cause) =>
        new NexusStoreActionError("Store action failed.", { cause }),
    });
    if (execution.isErr()) return execution;
    const schema = definition.validation?.actionResults?.[name];
    if (schema) {
      const validated = safeParsePayload(
        schema,
        execution.value,
        `Invalid result for ${name}.`,
      );
      if (validated.isErr()) return validated;
    }
    onChange();
    const delivered = await subscription.delivery.promise;
    return delivered
      .andThen(() => safeActive(subscription))
      .map(() => execution.value);
  };

  const safeSubscribe = async (
    callback: Subscription["callback"],
    context: ServiceInvocationContext,
  ) => {
    const connection = contexts.get(context);
    if (
      destroyed ||
      (connection && connections.get(context.sourceConnectionId) !== connection)
    ) {
      releaseCallback(callback);
      return Result.err(disconnected());
    }
    onChange();
    const snapshot = safeCapture().tapError(() => releaseCallback(callback));
    if (snapshot.isErr()) return snapshot;
    const initialized = createDelivery();
    const subscription: Subscription = {
      callback,
      owner: connection ? context.sourceConnectionId : undefined,
      delivery: initialized,
      inFlight: new Set(),
    };
    subscriptions.add(subscription);
    const actions: Record<string, ActionFunction> = Object.fromEntries(
      names.map((name) => [
        name,
        (...values: unknown[]) =>
          safeInvoke(subscription, name, values).then(unwrapResultOrThrow),
      ]),
    );
    // Reserve init before invoking the callback: its reentrant writes own a new delivery.
    deliver(
      subscription,
      initialized,
      Result.ok({
        type: "init",
        ...snapshot.value,
        actions: actions as RemoteActions<A>,
        unsubscribe: () => closeSubscription(subscription),
      }),
    );
    const delivered = await initialized.promise;
    return delivered.andThen(() => safeActive(subscription));
  };

  const service = {
    subscribe: (callback: Subscription["callback"], ...args: unknown[]) =>
      safeSubscribe(callback, args.at(-1) as ServiceInvocationContext).then(
        unwrapResultOrThrow,
      ),
    [SERVICE_INVOKE_START](context: ServiceInvocationContext) {
      const connection =
        connections.get(context.sourceConnectionId) ?? Symbol();
      connections.set(context.sourceConnectionId, connection);
      contexts.set(context, connection);
      return context;
    },
    [SERVICE_ON_DISCONNECT](id: string) {
      connections.delete(id);
      for (const subscription of subscriptions)
        if (subscription.owner === id) closeSubscription(subscription);
    },
  };
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    unsubscribeStore();
    if (timer !== undefined) clearTimeout(timer);
    for (const subscription of subscriptions)
      closeSubscription(subscription, disconnected(), "provider-shutdown");
    connections.clear();
  };
  return {
    provider: { token: definition.token, service },
    destroy,
    [Symbol.dispose]: destroy,
  };
}

/** Convenience creation; returns the original Zustand API, including middleware mutators. */
export function createNexusStore<
  S extends object,
  A extends Record<string, ActionFunction>,
  M extends AdapterModel,
  Mos extends [StoreMutatorIdentifier, unknown][] = [],
  const Keys extends readonly (keyof A & string)[] = readonly (keyof A &
    string)[],
>(
  definition: NexusStoreDefinition<S, A, M>,
  creator: StateCreator<S & A, [], Mos>,
  options: BindNexusStoreOptions<S & A, S, A, Keys>,
): NexusStoreBinding<S, A, M> & { store: Mutate<StoreApi<S & A>, Mos> } {
  const store = createStore<S & A>()(creator);
  return { store, ...bindNexusStore(definition, store, options) };
}
