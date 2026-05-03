import type { TargetCriteria, ServiceRegistration } from "@/api/types/config";
import type { NexusInstance } from "@/api/types";
import type { Token } from "@/api/token";
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
import type { PlatformMetadata, UserMetadata } from "@/types/identity";
import {
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
} from "@/state/errors";
import type {
  NexusStoreDefinition,
  NexusStoreServiceContract,
} from "@/state/types";
import type {
  SnapshotEnvelope,
  TerminalEnvelope,
  TerminalReason,
} from "@/state/protocol";

export interface RelayBaseContext<U, P> {
  origin: U;
  relay: U;
  platform: P;
  tokenId: string;
}

export interface RelayServiceCallContext<U, P> extends RelayBaseContext<U, P> {
  path: (string | number)[];
  operation: "GET" | "SET" | "APPLY";
}

export interface RelayStoreSubscribeContext<U, P> extends RelayBaseContext<
  U,
  P
> {}

export interface RelayStoreDispatchContext<U, P> extends RelayBaseContext<
  U,
  P
> {
  action: string;
}

export interface RelayServiceOptions<
  DownstreamU extends UserMetadata,
  DownstreamP extends PlatformMetadata,
  UpstreamU extends UserMetadata,
  UpstreamP extends PlatformMetadata,
> {
  forwardThrough: NexusInstance<UpstreamU, UpstreamP>;
  forwardTarget: TargetCriteria<UpstreamU, string, string>;
  policy?: {
    canCall?(
      context: RelayServiceCallContext<DownstreamU, DownstreamP>,
    ): boolean | Promise<boolean>;
  };
  payload?: {
    mode?: "serializable";
  };
}

export interface RelayNexusStoreOptions<
  DownstreamU extends UserMetadata,
  DownstreamP extends PlatformMetadata,
  UpstreamU extends UserMetadata,
  UpstreamP extends PlatformMetadata,
> {
  forwardThrough: NexusInstance<UpstreamU, UpstreamP>;
  forwardTarget: TargetCriteria<UpstreamU, string, string>;
  policy?: {
    canSubscribe?(
      context: RelayStoreSubscribeContext<DownstreamU, DownstreamP>,
    ): boolean | Promise<boolean>;
    canDispatch?(
      context: RelayStoreDispatchContext<DownstreamU, DownstreamP>,
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

interface UpstreamStoreHandle<
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
> {
  service: NexusStoreServiceContract<TState, TActions> & {
    [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]?: (
      callback: () => void,
    ) => (() => void) | void;
    [NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL]?: (
      callback: () => void,
    ) => (() => void) | void;
  };
  upstreamStoreInstanceId: string;
  upstreamVersion: number;
  latestState: TState;
}

interface PendingDispatch<T> {
  committedUpstreamVersion: number;
  result: T;
  resolve: (value: {
    type: "dispatch-result";
    committedVersion: number;
    result: T;
  }) => void;
  reject: (error: Error) => void;
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

const cloneState = <TState extends object>(state: TState): TState => {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(state);
  }

  return JSON.parse(JSON.stringify(state)) as TState;
};

export const relayService = <
  TService extends object,
  DownstreamU extends UserMetadata,
  DownstreamP extends PlatformMetadata,
  UpstreamU extends UserMetadata,
  UpstreamP extends PlatformMetadata,
>(
  token: Token<TService>,
  options: RelayServiceOptions<DownstreamU, DownstreamP, UpstreamU, UpstreamP>,
): ServiceRegistration<TService> => {
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

        const policyContext: RelayServiceCallContext<DownstreamU, DownstreamP> =
          {
            origin: invocation.sourceIdentity as DownstreamU,
            relay: invocation.localIdentity as DownstreamU,
            platform: invocation.platform as DownstreamP,
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
          const upstream = await options.forwardThrough.create(token, {
            target: options.forwardTarget as any,
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

  const implementation = new Proxy(rootTarget, {
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
    implementation,
  };
};

export const relayNexusStore = <
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
  DownstreamU extends UserMetadata,
  DownstreamP extends PlatformMetadata,
  UpstreamU extends UserMetadata,
  UpstreamP extends PlatformMetadata,
>(
  definition: NexusStoreDefinition<TState, TActions>,
  options: RelayNexusStoreOptions<
    DownstreamU,
    DownstreamP,
    UpstreamU,
    UpstreamP
  >,
): ServiceRegistration<NexusStoreServiceContract<TState, TActions>> => {
  const relayStoreInstanceId = createRelaySessionId();
  let downstreamVersion = 0;
  let latestState: TState | null = null;
  let upstreamStoreInstanceId: string | null = null;
  let upstreamVersion: number | null = null;
  let upstreamHandlePromise: Promise<
    UpstreamStoreHandle<TState, TActions>
  > | null = null;
  let terminalError: Error | null = null;
  let nextSubscriptionId = 1;
  let dispatchChain = Promise.resolve();

  const subscriptions = new Map<
    string,
    {
      onSync: (
        event:
          | (Omit<SnapshotEnvelope, "state"> & { state: TState })
          | TerminalEnvelope,
      ) => void;
      ownerConnectionId?: string;
    }
  >();
  const subscriptionsByConnection = new Map<string, Set<string>>();
  const pendingDispatches = new Set<PendingDispatch<any>>();

  const ensureNotTerminal = (): void => {
    if (terminalError) {
      throw terminalError;
    }
  };

  const emitDownstreamSnapshot = (state: TState): number => {
    downstreamVersion += 1;
    const snapshot = {
      type: "snapshot" as const,
      storeInstanceId: relayStoreInstanceId,
      version: downstreamVersion,
      state: cloneState(state),
    };

    for (const [subscriptionId, subscription] of subscriptions.entries()) {
      try {
        subscription.onSync(snapshot);
      } catch {
        subscriptions.delete(subscriptionId);
      }
    }

    return downstreamVersion;
  };

  const emitTerminal = (reason: TerminalReason, cause?: unknown): void => {
    if (terminalError) {
      return;
    }

    terminalError = toDisconnectedError(reason, cause);
    const terminalEnvelope: TerminalEnvelope = {
      type: "terminal",
      storeInstanceId: relayStoreInstanceId,
      lastKnownVersion: downstreamVersion,
      reason,
      ...(typeof cause === "undefined" ? {} : { error: cause }),
    };

    for (const subscription of subscriptions.values()) {
      try {
        subscription.onSync(terminalEnvelope);
      } catch {
        // listener isolation only
      }
    }

    for (const pendingDispatch of Array.from(pendingDispatches)) {
      pendingDispatches.delete(pendingDispatch);
      pendingDispatch.reject(terminalError);
    }
  };

  const removeSubscription = (subscriptionId: string): void => {
    const existing = subscriptions.get(subscriptionId);
    if (!existing) {
      return;
    }

    subscriptions.delete(subscriptionId);
    if (!existing.ownerConnectionId) {
      return;
    }

    const owned = subscriptionsByConnection.get(existing.ownerConnectionId);
    if (!owned) {
      return;
    }

    owned.delete(subscriptionId);
    if (owned.size === 0) {
      subscriptionsByConnection.delete(existing.ownerConnectionId);
    }
  };

  const handleUpstreamSnapshot = (event: SnapshotEnvelope): void => {
    ensureNotTerminal();

    if (
      upstreamStoreInstanceId &&
      event.storeInstanceId !== upstreamStoreInstanceId
    ) {
      emitTerminal(
        "target-replaced",
        new NexusStoreProtocolError("Upstream store instance changed."),
      );
      return;
    }

    if (upstreamVersion !== null && event.version <= upstreamVersion) {
      return;
    }

    upstreamStoreInstanceId = event.storeInstanceId;
    upstreamVersion = event.version;
    latestState = cloneState(event.state as TState);

    const satisfied = Array.from(pendingDispatches).filter(
      (pendingDispatch) =>
        event.version >= pendingDispatch.committedUpstreamVersion,
    );

    if (satisfied.length > 0) {
      const committedVersion = emitDownstreamSnapshot(latestState);
      for (const pendingDispatch of satisfied) {
        pendingDispatches.delete(pendingDispatch);
        pendingDispatch.resolve({
          type: "dispatch-result",
          committedVersion,
          result: pendingDispatch.result,
        });
      }
      return;
    }

    emitDownstreamSnapshot(latestState);
  };

  const handleUpstreamSync = (event: unknown): void => {
    if (!event || typeof event !== "object") {
      emitTerminal(
        "provider-shutdown",
        new NexusStoreProtocolError("Invalid upstream sync envelope."),
      );
      return;
    }

    const typedEvent = event as SnapshotEnvelope | TerminalEnvelope;
    if (typedEvent.type === "terminal") {
      emitTerminal(typedEvent.reason, typedEvent.error);
      return;
    }

    handleUpstreamSnapshot(typedEvent as SnapshotEnvelope);
  };

  const ensureUpstream = async (): Promise<
    UpstreamStoreHandle<TState, TActions>
  > => {
    if (upstreamHandlePromise) {
      return upstreamHandlePromise;
    }

    upstreamHandlePromise = (async () => {
      try {
        const service = (await options.forwardThrough.create(definition.token, {
          target: options.forwardTarget as any,
        })) as UpstreamStoreHandle<TState, TActions>["service"];

        service[NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]?.(() => {
          emitTerminal("source-disconnected");
        });
        service[NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL]?.(() => {
          emitTerminal("target-changed");
        });

        const baseline = await service.subscribe(handleUpstreamSync);
        latestState = cloneState(baseline.state);
        upstreamStoreInstanceId = baseline.storeInstanceId;
        upstreamVersion = baseline.version;

        return {
          service,
          upstreamStoreInstanceId: baseline.storeInstanceId,
          upstreamVersion: baseline.version,
          latestState,
        };
      } catch (error) {
        throw mapRelayUpstreamError(error);
      }
    })();

    return upstreamHandlePromise;
  };

  const buildBaseContext = (
    invocationContext: ServiceInvocationContext,
  ): RelayBaseContext<DownstreamU, DownstreamP> => ({
    origin: invocationContext.sourceIdentity as DownstreamU,
    relay: invocationContext.localIdentity as DownstreamU,
    platform: invocationContext.platform as DownstreamP,
    tokenId: definition.token.id,
  });

  const implementation: NexusStoreServiceContract<TState, TActions> & {
    [SERVICE_INVOKE_START](
      invocationContext: ServiceInvocationContext,
    ): ServiceInvocationContext;
    [SERVICE_INVOKE_END](invocationContext?: ServiceInvocationContext): void;
    [SERVICE_ON_DISCONNECT](connectionId: string): void;
  } = {
    async subscribe(
      onSync: (
        event:
          | (Omit<SnapshotEnvelope, "state"> & { state: TState })
          | TerminalEnvelope,
      ) => void,
      invocationContext?: ServiceInvocationContext,
    ) {
      if (invocationContext && options.policy?.canSubscribe) {
        const allowed = await options.policy.canSubscribe(
          buildBaseContext(invocationContext),
        );
        if (allowed === false) {
          throw new RelayError(
            "Relay policy denied store subscription.",
            "E_RELAY_POLICY_DENIED",
            { tokenId: definition.token.id },
          );
        }
      }

      const upstream = await ensureUpstream();
      ensureNotTerminal();
      const subscriptionId = `relay-subscription:${nextSubscriptionId++}`;
      const ownerConnectionId = invocationContext?.sourceConnectionId;
      subscriptions.set(subscriptionId, {
        onSync,
        ...(ownerConnectionId ? { ownerConnectionId } : {}),
      });
      if (ownerConnectionId) {
        const owned =
          subscriptionsByConnection.get(ownerConnectionId) ?? new Set<string>();
        owned.add(subscriptionId);
        subscriptionsByConnection.set(ownerConnectionId, owned);
      }

      return {
        storeInstanceId: relayStoreInstanceId,
        subscriptionId,
        version: 0,
        state: cloneState(upstream.latestState),
      };
    },
    async unsubscribe(subscriptionId: string) {
      removeSubscription(subscriptionId);
    },
    async dispatch<K extends keyof TActions & string>(
      action: K,
      args: TActions[K] extends (...callArgs: infer TArgs) => any
        ? TArgs
        : never,
      invocationContext?: ServiceInvocationContext,
    ) {
      if (!invocationContext) {
        throw new RelayError(
          "Relay store dispatch requires invocation context.",
          "E_RELAY_UPSTREAM_FAILURE",
        );
      }

      const run = async () => {
        ensureNotTerminal();

        if (options.policy?.canDispatch) {
          const allowed = await options.policy.canDispatch({
            ...buildBaseContext(invocationContext),
            action,
          });
          if (allowed === false) {
            throw new RelayError(
              "Relay policy denied store dispatch.",
              "E_RELAY_POLICY_DENIED",
              { tokenId: definition.token.id, action },
            );
          }
        }

        const upstream = await ensureUpstream();
        ensureNotTerminal();

        const upstreamResult = await upstream.service.dispatch(
          action,
          args,
          invocationContext,
        );
        ensureNotTerminal();

        if ((upstreamVersion ?? -1) >= upstreamResult.committedVersion) {
          const committedVersion = emitDownstreamSnapshot(
            latestState ?? upstream.latestState,
          );
          return {
            type: "dispatch-result" as const,
            committedVersion,
            result: upstreamResult.result,
          };
        }

        return await new Promise<{
          type: "dispatch-result";
          committedVersion: number;
          result: typeof upstreamResult.result;
        }>((resolve, reject) => {
          pendingDispatches.add({
            committedUpstreamVersion: upstreamResult.committedVersion,
            result: upstreamResult.result,
            resolve,
            reject,
          });
        });
      };

      const currentRun = dispatchChain.then(run, run);
      dispatchChain = currentRun.then(
        () => undefined,
        () => undefined,
      );
      return currentRun;
    },
    [SERVICE_INVOKE_START](invocationContext) {
      return invocationContext;
    },
    [SERVICE_INVOKE_END]() {
      return undefined;
    },
    [SERVICE_ON_DISCONNECT](connectionId) {
      const owned = subscriptionsByConnection.get(connectionId);
      if (!owned) {
        return;
      }

      for (const subscriptionId of Array.from(owned)) {
        removeSubscription(subscriptionId);
      }
      subscriptionsByConnection.delete(connectionId);
    },
  };

  return {
    token: definition.token,
    implementation,
  };
};
