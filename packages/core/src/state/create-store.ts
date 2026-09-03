import type { ServiceProvider } from "@/api/types/config";
import type { AdapterModel } from "@/types/adapter-model";
import {
  type ServiceInvocationContext,
  SERVICE_INVOKE_END,
  SERVICE_INVOKE_START,
  SERVICE_ON_DISCONNECT,
} from "@/service/service-invocation-hooks";
import { createStoreHost } from "./host/store-host";
import type {
  ActionArgs,
  ActionResult,
  NexusStoreDefinition,
  NexusStoreServiceContract,
  RemoteActions,
} from "./types";

const ignoredActionProxyKeys = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "inspect",
  "valueOf",
  "toString",
]);

const cloneState = <TState extends object>(state: TState): TState => {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(state);
  }

  return JSON.parse(JSON.stringify(state)) as TState;
};

export type NexusStoreStatus =
  | { type: "ready"; storeInstanceId: string; version: number }
  | { type: "destroyed" };

export interface NexusStoreHandle<
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
> {
  getState(): TState;
  subscribe(listener: (state: TState) => void): () => void;
  getStatus(): NexusStoreStatus;
  destroy(): void;
  readonly actions: RemoteActions<TActions>;
}

/** A Core 1.1 local Store handle returned by `createNexusStore()`. */
export interface NexusStoreHandleWithInitialState<
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
>
  extends NexusStoreHandle<TState, TActions>, Disposable {
  getInitialState(): TState;
  [Symbol.dispose](): void;
}

export interface CreateNexusStoreResult<
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
  M extends AdapterModel,
> {
  readonly provider: ServiceProvider<
    NexusStoreServiceContract<TState, TActions>,
    M
  >;
  readonly store: NexusStoreHandleWithInitialState<TState, TActions>;
}

export const createNexusStore = <
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
  M extends AdapterModel,
>(
  definition: NexusStoreDefinition<TState, TActions, M>,
): CreateNexusStoreResult<TState, TActions, M> => {
  const host = createStoreHost(definition);
  const initialState = host.getSnapshot().state;
  let destroyed = false;

  const service: NexusStoreServiceContract<TState, TActions> = {
    subscribe: async (onSync, invocation?: ServiceInvocationContext) => {
      return host.subscribe(onSync, {
        ownerConnectionId: host.resolveSubscriptionOwner(invocation),
      });
    },
    unsubscribe: (subscriptionId) => host.unsubscribe(subscriptionId),
    dispatch: (action, args, invocation) =>
      host.dispatch(action, args, invocation),
  };

  const implementationWithHooks = service as NexusStoreServiceContract<
    TState,
    TActions
  > & {
    [SERVICE_INVOKE_START](
      invocationContext: ServiceInvocationContext,
    ): ServiceInvocationContext;
    [SERVICE_INVOKE_END](invocationContext?: ServiceInvocationContext): void;
    [SERVICE_ON_DISCONNECT](connectionId: string): void;
  };

  implementationWithHooks[SERVICE_INVOKE_START] = (invocationContext) =>
    host.onInvokeStart(invocationContext);
  implementationWithHooks[SERVICE_INVOKE_END] = (invocationContext) => {
    host.onInvokeEnd(invocationContext);
  };
  implementationWithHooks[SERVICE_ON_DISCONNECT] = (connectionId) => {
    host.cleanupConnection(connectionId);
  };

  const actions = new Proxy(
    {},
    {
      get: (_target, propertyKey) => {
        if (
          typeof propertyKey !== "string" ||
          ignoredActionProxyKeys.has(propertyKey)
        ) {
          return undefined;
        }

        return async <K extends keyof TActions & string>(
          ...args: ActionArgs<TActions, K>
        ): Promise<ActionResult<TActions, K>> => {
          const result = await host.dispatch(propertyKey as K, args);
          return result.result;
        };
      },
    },
  ) as unknown as RemoteActions<TActions>;

  const store: NexusStoreHandleWithInitialState<TState, TActions> = {
    getState: () => host.getSnapshot().state,
    getInitialState: () => cloneState(initialState),
    subscribe: (listener) => {
      const subscriptionId = host.subscribeLocal((event) => {
        if (event.type === "snapshot") {
          try {
            listener(event.state);
          } catch {
            // Local listeners follow normal subscription semantics: one broken
            // listener call should not unsubscribe it or block later updates.
          }
        }
      });

      return () => {
        if (subscriptionId) {
          void host.unsubscribe(subscriptionId).catch(() => undefined);
        }
      };
    },
    getStatus: () => {
      if (destroyed) {
        return { type: "destroyed" };
      }

      const snapshot = host.getSnapshot();
      return {
        type: "ready",
        storeInstanceId: snapshot.storeInstanceId,
        version: snapshot.version,
      };
    },
    destroy: () => {
      if (destroyed) {
        return;
      }

      destroyed = true;
      host.destroy();
    },
    [Symbol.dispose]() {
      this.destroy();
    },
    actions,
  };

  return {
    provider: {
      token: definition.token,
      service: implementationWithHooks,
    },
    store,
  };
};
