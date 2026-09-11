import type { ServiceProvider } from "@/api/types/config";
import type { NexusInstance } from "@/api/types";
import { Token } from "@/api/token";
import { Logger } from "@/logger";
import { Result } from "better-result";
import {
  disposeSubscription,
  safeParsePayload,
  safeValidateState,
  SyncEnvelopeSchema,
} from "@/state/protocol";
import {
  SERVICE_INVOKE_END,
  SERVICE_INVOKE_START,
  SERVICE_ON_DISCONNECT,
  type ServiceInvocationContext,
} from "@/service/service-invocation-hooks";
import {
  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
  RELEASE_PROXY_SYMBOL,
} from "@/types/symbols";
import { isRefWrapper } from "@/types/ref-wrapper";
import type {
  AdapterModel,
  ConnectionTargetOf,
  ConnectionMetaOf,
  ContextMetaOf,
} from "@/types/adapter-model";
import {
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
} from "@/state/errors";
import type {
  NexusStoreDefinition,
  NexusStoreServiceContract,
  RemoteActions,
} from "@/state/contract";
import type {
  SyncEnvelope,
  TerminalEnvelope,
  TerminalReason,
} from "@/state/protocol";

export interface RelayBaseContext<M extends AdapterModel> {
  origin: ContextMetaOf<M>;
  relay: ContextMetaOf<M>;
  connection: ConnectionMetaOf<M>;
  tokenId: string;
}

export interface RelayServiceCallContext<
  M extends AdapterModel,
> extends RelayBaseContext<M> {
  path: (string | number)[];
  operation: "GET" | "SET" | "APPLY";
}

export type RelayStoreSubscribeContext<M extends AdapterModel> =
  RelayBaseContext<M>;

export interface RelayStoreDispatchContext<
  M extends AdapterModel,
> extends RelayBaseContext<M> {
  action: string;
}

export interface RelayServiceOptions<
  DownstreamM extends AdapterModel,
  UpstreamM extends AdapterModel,
> {
  forwardThrough: NexusInstance<UpstreamM>;
  forwardTarget: ConnectionTargetOf<UpstreamM>;
  policy?: {
    canCall?(
      context: RelayServiceCallContext<DownstreamM>,
    ): boolean | Promise<boolean>;
  };
  payload?: {
    mode?: "serializable";
  };
}

export interface RelayNexusStoreOptions<
  DownstreamM extends AdapterModel,
  UpstreamM extends AdapterModel,
> {
  forwardThrough: NexusInstance<UpstreamM>;
  forwardTarget: ConnectionTargetOf<UpstreamM>;
  policy?: {
    canSubscribe?(
      context: RelayStoreSubscribeContext<DownstreamM>,
    ): boolean | Promise<boolean>;
    canDispatch?(
      context: RelayStoreDispatchContext<DownstreamM>,
    ): boolean | Promise<boolean>;
  };
}

export class RelayError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.context = context;
  }
}

const SERIALIZABLE_MODE = "serializable" as const;

const createRelaySessionId = (): string => {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return randomUuid
    ? `relay-store-session:${randomUuid}`
    : `relay-store-session:${Date.now()}`;
};

const isInvocationContext = (
  value: unknown,
): value is ServiceInvocationContext =>
  typeof value === "object" &&
  value !== null &&
  "sourceConnectionId" in value &&
  "sourceIdentity" in value &&
  "localIdentity" in value &&
  "platform" in value;

const splitInvocationArg = (
  args: unknown[],
  activeInvocation?: ServiceInvocationContext,
): { callArgs: unknown[]; invocation?: ServiceInvocationContext } => {
  const lastArg = args.at(-1);
  if (isInvocationContext(lastArg)) {
    return {
      callArgs: args.slice(0, -1),
      invocation: lastArg,
    };
  }

  return {
    callArgs: args,
    invocation: activeInvocation,
  };
};

const isCapabilityBearingValue = (value: unknown): boolean => {
  if (typeof value === "function") {
    return true;
  }

  if (isRefWrapper(value)) {
    return true;
  }

  if (value && typeof value === "object") {
    const record = value as Record<PropertyKey, unknown>;
    if (typeof record[RELEASE_PROXY_SYMBOL] === "function") {
      return true;
    }
  }

  return false;
};

const validateSerializable = (
  value: unknown,
  path: (string | number)[] = [],
): void => {
  if (isCapabilityBearingValue(value)) {
    throw new RelayError(
      "Relay payload contains unsupported capability-bearing value.",
      "E_RELAY_PAYLOAD_UNSUPPORTED",
      { path },
    );
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateSerializable(value[index], [...path, index]);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value)) {
      validateSerializable(nestedValue, [...path, key]);
    }
  }
};

const mapRelayUpstreamError = (error: unknown): RelayError => {
  if (error instanceof RelayError) {
    return error;
  }

  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;

  if (code === "E_TARGET_NO_MATCH" || code === "E_TARGET_UNEXPECTED_COUNT") {
    return new RelayError(
      "Relay upstream target could not be resolved.",
      "E_RELAY_UPSTREAM_TARGET_NOT_FOUND",
      { cause: error },
    );
  }

  if (code === "E_CONN_CLOSED") {
    return new RelayError(
      "Relay upstream connection is disconnected or stale.",
      "E_RELAY_UPSTREAM_DISCONNECTED",
      { cause: error },
    );
  }

  return new RelayError(
    "Relay upstream call failed.",
    "E_RELAY_UPSTREAM_FAILURE",
    {
      cause: error,
    },
  );
};

const toDisconnectedError = (
  reason: TerminalReason,
  cause?: unknown,
): NexusStoreDisconnectedError =>
  new NexusStoreDisconnectedError(
    `Relay upstream store became unavailable (${reason}).`,
    typeof cause === "undefined" ? undefined : { cause },
  );

export const relayService = <
  TService extends object,
  DownstreamM extends AdapterModel,
  UpstreamM extends AdapterModel,
>(
  token: Token<TService, DownstreamM> | Token<TService>,
  options: RelayServiceOptions<DownstreamM, UpstreamM>,
): ServiceProvider<TService, DownstreamM> => {
  const upstreamToken = new Token<TService, UpstreamM>(token.id);
  let activeInvocation: ServiceInvocationContext | undefined;

  const createPathProxy = (path: (string | number)[]): unknown =>
    new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === "then") {
          return undefined;
        }

        if (typeof prop === "symbol") {
          return undefined;
        }

        return createPathProxy([...path, prop]);
      },
      set() {
        throw new RelayError(
          "Relay operation SET is not supported.",
          "E_RELAY_OPERATION_UNSUPPORTED",
          { tokenId: token.id, path, operation: "SET" },
        );
      },
      async apply(_target, _thisArg, callArgs) {
        const { callArgs: forwardedArgs, invocation } = splitInvocationArg(
          callArgs,
          activeInvocation,
        );

        if (!invocation) {
          throw new RelayError(
            "Relay invocation context is unavailable.",
            "E_RELAY_UPSTREAM_FAILURE",
            { tokenId: token.id, path },
          );
        }

        const policyContext: RelayServiceCallContext<DownstreamM> = {
          origin: invocation.sourceIdentity as ContextMetaOf<DownstreamM>,
          relay: invocation.localIdentity as ContextMetaOf<DownstreamM>,
          connection: invocation.platform as ConnectionMetaOf<DownstreamM>,
          tokenId: token.id,
          path,
          operation: "APPLY",
        };

        const allowed = await options.policy?.canCall?.(policyContext);
        if (allowed === false) {
          throw new RelayError(
            "Relay policy denied service call.",
            "E_RELAY_POLICY_DENIED",
            { tokenId: token.id, path, operation: "APPLY" },
          );
        }

        if (
          (options.payload?.mode ?? SERIALIZABLE_MODE) === SERIALIZABLE_MODE
        ) {
          validateSerializable(forwardedArgs);
        }

        try {
          const upstream = await options.forwardThrough.create(upstreamToken, {
            target: options.forwardTarget,
          });
          let cursor: any = upstream;
          for (const segment of path) {
            cursor = cursor[segment];
          }

          const result = await cursor(...forwardedArgs);
          if (
            (options.payload?.mode ?? SERIALIZABLE_MODE) === SERIALIZABLE_MODE
          ) {
            validateSerializable(result);
          }
          return result;
        } catch (error) {
          throw mapRelayUpstreamError(error);
        }
      },
    });

  const rootTarget: Record<PropertyKey, unknown> = {
    [SERVICE_INVOKE_START]: (invocationContext: ServiceInvocationContext) => {
      activeInvocation = invocationContext;
      return invocationContext;
    },
    [SERVICE_INVOKE_END]: () => {
      activeInvocation = undefined;
    },
  };

  const service = new Proxy(rootTarget, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }

      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }

      return createPathProxy([prop]);
    },
    set() {
      throw new RelayError(
        "Relay operation SET is not supported.",
        "E_RELAY_OPERATION_UNSUPPORTED",
        { tokenId: token.id, operation: "SET", path: [] },
      );
    },
  }) as TService;

  return {
    token,
    service,
  };
};

/**
 * Projects one upstream State session into the downstream graph. Each subscriber
 * owns its upstream callbacks, so action acknowledgement remains caller-specific.
 * Upstream replacement ends this provider; acquire a newly registered relay session.
 */
export const relayNexusStore = <
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
  DownstreamM extends AdapterModel,
  UpstreamM extends AdapterModel,
>(
  definition:
    | NexusStoreDefinition<TState, TActions, DownstreamM>
    | NexusStoreDefinition<TState, TActions>,
  options: RelayNexusStoreOptions<DownstreamM, UpstreamM>,
): ServiceProvider<
  NexusStoreServiceContract<TState, TActions>,
  DownstreamM
> => {
  const upstreamToken = new Token<
    NexusStoreServiceContract<TState, TActions>,
    UpstreamM
  >(definition.token.id);
  const relayStoreInstanceId = createRelaySessionId();
  const logger = new Logger("L3 -> RelayStore");
  let identity: string | undefined;
  let latestVersion = 0;
  let terminalError: NexusStoreDisconnectedError | null = null;
  type Subscription = {
    onSync: Parameters<
      NexusStoreServiceContract<TState, TActions>["subscribe"]
    >[0];
    owner?: string;
    cleanup: Set<() => void>;
    stop(): void;
  };
  const subscriptions = new Set<Subscription>();
  const contexts = new WeakMap<ServiceInvocationContext, symbol>();
  const connections = new Map<string, symbol>();
  const closedError = () =>
    terminalError ??
    new NexusStoreDisconnectedError("Relay store subscription closed.");
  const safeActive = (subscription: Subscription) =>
    terminalError || !subscriptions.has(subscription)
      ? Result.err(closedError())
      : Result.ok(undefined);

  // Each downstream subscriber owns an upstream subscription. Its action already
  // waits for this callback's ACK, so no relay waiter or all-subscriber barrier exists.
  const emitTerminal = (reason: TerminalReason, cause?: unknown): void => {
    if (terminalError) return;
    terminalError = toDisconnectedError(reason, cause);
    const event: TerminalEnvelope = {
      type: "terminal",
      storeInstanceId: relayStoreInstanceId,
      lastKnownVersion: latestVersion,
      reason,
      error: cause,
    };
    for (const subscription of subscriptions) {
      void Result.tryPromise({
        try: async () => {
          await subscription.onSync(event);
        },
        catch: mapRelayUpstreamError,
      }).then((sent) => {
        if (sent.isErr())
          logger.error("Relay terminal notification failed", sent.error);
      });
      subscription.stop();
    }
  };
  const buildBaseContext = (
    invocationContext: ServiceInvocationContext,
  ): RelayBaseContext<DownstreamM> => ({
    origin: invocationContext.sourceIdentity as ContextMetaOf<DownstreamM>,
    relay: invocationContext.localIdentity as ContextMetaOf<DownstreamM>,
    connection: invocationContext.platform as ConnectionMetaOf<DownstreamM>,
    tokenId: definition.token.id,
  });

  const safeAuthorize = async (
    invocation: ServiceInvocationContext | undefined,
    action?: string,
  ) => {
    const policy =
      action === undefined
        ? options.policy?.canSubscribe
        : options.policy?.canDispatch;
    if (!policy) return Result.ok(undefined);
    if (!invocation)
      return Result.err(
        new RelayError(
          "Relay policy requires a trusted caller.",
          "E_RELAY_POLICY_DENIED",
        ),
      );
    const allowed = await Result.tryPromise({
      try: async () => {
        const context = {
          ...buildBaseContext(invocation),
          action: action ?? "",
        };
        return policy(context);
      },
      catch: mapRelayUpstreamError,
    });
    return allowed.andThen((value) =>
      value === false
        ? Result.err(
            new RelayError(
              "Relay policy denied store operation.",
              "E_RELAY_POLICY_DENIED",
              { action },
            ),
          )
        : Result.ok(undefined),
    );
  };

  const service = {
    async subscribe(
      onSync: Subscription["onSync"],
      ...args: unknown[]
    ): Promise<void> {
      const candidate = args.at(-1) as ServiceInvocationContext | undefined;
      const invocation =
        candidate && contexts.has(candidate) ? candidate : undefined;
      const subscription: Subscription = {
        onSync,
        owner: invocation?.sourceConnectionId,
        cleanup: new Set(),
        stop() {
          if (!subscriptions.delete(subscription)) return;
          for (const stop of subscription.cleanup) {
            subscription.cleanup.delete(stop);
            try {
              stop();
            } catch {
              /* Complete all ownership cleanup. */
            }
          }
          if (![...subscriptions].some((other) => other.onSync === onSync)) {
            try {
              (
                onSync as typeof onSync & {
                  [RELEASE_PROXY_SYMBOL]?: () => void;
                }
              )[RELEASE_PROXY_SYMBOL]?.();
            } catch {
              /* best effort */
            }
          }
        },
      };
      // Register before any async policy/acquisition so disconnect can close it.
      subscriptions.add(subscription);
      let initialized = false;
      let observedVersion: number | undefined;
      const safeReceive = (input: unknown) =>
        Result.gen(async function* () {
          yield* Result.try({
            try: () => {
              if (
                input &&
                typeof input === "object" &&
                (input as { type?: unknown }).type === "init"
              ) {
                if (!subscriptions.has(subscription))
                  disposeSubscription(input);
                else subscription.cleanup.add(() => disposeSubscription(input));
              }
            },
            catch: (cause) =>
              new NexusStoreProtocolError("Invalid relay state event.", {
                cause,
              }),
          });
          yield* safeActive(subscription);
          const event = yield* safeParsePayload(
            SyncEnvelopeSchema,
            input,
            "Invalid relay state event.",
          );
          if (identity && identity !== event.storeInstanceId) {
            emitTerminal("target-replaced");
            return Result.err(closedError());
          }
          if (event.type === "terminal") {
            emitTerminal(event.reason, event.error);
            return Result.err(closedError());
          }
          if (event.type === "init" && initialized)
            return Result.err(
              new NexusStoreProtocolError("Duplicate relay init."),
            );
          if (
            event.type === "snapshot" &&
            observedVersion !== undefined &&
            event.version <= observedVersion
          )
            return Result.ok(undefined);
          const state = yield* safeValidateState(
            event.state,
            definition.validation?.state,
            "Invalid relay state.",
          );
          if (!identity) {
            identity = event.storeInstanceId;
          }
          observedVersion = Math.max(observedVersion ?? 0, event.version);
          // Concurrent subscriptions can deliver older baselines after newer
          // ones. Keep upstream versions rather than subtracting an arrival-order baseline.
          const version = event.version;
          latestVersion = Math.max(latestVersion, version);
          const snapshot = yield* Result.try({
            try: () => structuredClone(state),
            catch: (cause) =>
              new NexusStoreProtocolError("Invalid relay state.", {
                cause,
              }),
          });
          let projected: SyncEnvelope<TState, TActions> = {
            type: "snapshot",
            storeInstanceId: relayStoreInstanceId,
            version,
            state: snapshot,
          };
          if (event.type === "init") {
            initialized = true;
            const actions: Record<
              string,
              (...args: unknown[]) => Promise<unknown>
            > = Object.create(null);
            for (const name of Object.keys(event.actions)) {
              actions[name] = async (...callArgs) => {
                const caller = callArgs.at(-1) as
                  | ServiceInvocationContext
                  | undefined;
                if (caller && contexts.has(caller)) callArgs.pop();
                const activeCaller =
                  caller && contexts.has(caller) ? caller : invocation;
                const called = await Result.gen(async function* () {
                  yield* safeActive(subscription);
                  if (activeCaller?.sourceConnectionId !== subscription.owner)
                    return Result.err(
                      new RelayError(
                        "Relay action belongs to another caller.",
                        "E_RELAY_POLICY_DENIED",
                      ),
                    );
                  yield* Result.await(safeAuthorize(activeCaller, name));
                  yield* safeActive(subscription);
                  const value = yield* Result.await(
                    Result.tryPromise({
                      try: () => event.actions[name](...callArgs),
                      catch: (error) =>
                        error instanceof Error
                          ? error
                          : mapRelayUpstreamError(error),
                    }),
                  );
                  yield* safeActive(subscription);
                  return Result.ok(value);
                });
                if (called.isErr()) throw called.error;
                return called.value;
              };
            }
            projected = {
              ...projected,
              type: "init",
              actions: actions as RemoteActions<TActions>,
              unsubscribe: subscription.stop,
            };
          }
          // The downstream mirror already buffers updates that arrive before init.
          // Forward directly so relay delivery does not add another ordering queue.
          yield* Result.await(
            Result.tryPromise({
              try: async () => {
                await onSync(projected);
              },
              catch: mapRelayUpstreamError,
            }),
          );
          return safeActive(subscription);
        });

      const result = await Result.gen(async function* () {
        yield* safeActive(subscription);
        if (
          invocation &&
          contexts.get(invocation) !==
            connections.get(invocation.sourceConnectionId)
        )
          return Result.err(closedError());
        yield* Result.await(safeAuthorize(invocation));
        yield* safeActive(subscription);
        const upstream = yield* Result.await(
          Result.tryPromise({
            try: () =>
              options.forwardThrough.create(upstreamToken, {
                target: options.forwardTarget,
              }),
            catch: mapRelayUpstreamError,
          }),
        );
        yield* safeActive(subscription);
        yield* Result.await(
          Result.tryPromise({
            try: async () => {
              const hooks = [
                [
                  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
                  "source-disconnected",
                ],
                [
                  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
                  "target-changed",
                ],
              ] as const;
              for (const [symbol, reason] of hooks) {
                const register = (
                  upstream as typeof upstream & {
                    [key: symbol]:
                      | ((notify: () => void) => (() => void) | void)
                      | undefined;
                  }
                )[symbol];
                const stop = register?.(() => emitTerminal(reason));
                if (stop) {
                  if (!subscriptions.has(subscription)) stop();
                  else subscription.cleanup.add(stop);
                }
              }
              await upstream.subscribe(async (input) => {
                const received = await safeReceive(input);
                if (received.isErr()) {
                  if (received.error instanceof NexusStoreProtocolError)
                    emitTerminal("source-disconnected", received.error);
                  subscription.stop();
                  throw received.error;
                }
              });
            },
            catch: mapRelayUpstreamError,
          }),
        );
        yield* safeActive(subscription);
        return initialized
          ? Result.ok(undefined)
          : Result.err(
              new NexusStoreProtocolError("Relay upstream did not initialize."),
            );
      });
      if (result.isErr()) {
        subscription.stop();
        throw result.error;
      }
    },
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
        if (subscription.owner === id) subscription.stop();
    },
  };

  return {
    token: definition.token as Token<
      NexusStoreServiceContract<TState, TActions>,
      DownstreamM
    >,
    service,
  };
};
