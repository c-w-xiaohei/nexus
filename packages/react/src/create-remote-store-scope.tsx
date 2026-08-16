import { createContext, useContext, type ReactNode } from "react";
import type { AdapterModel } from "@nexus-js/core";
import type {
  NexusStoreDefinition,
  RemoteActions,
  RemoteStoreStatus,
} from "@nexus-js/core/state";
import {
  useRemoteStore,
  type UseRemoteStoreOptions,
  type UseRemoteStoreResult,
} from "./use-remote-store.js";
import {
  useStoreSelector,
  type UseStoreSelectorOptions,
} from "./use-store-selector.js";

type ActionFunction = (...args: any[]) => any;

export interface RemoteStoreScope<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  U extends AdapterModel,
> {
  readonly Provider: (props: RemoteStoreScopeProviderProps<U>) => ReactNode;
  useRemoteStore(): UseRemoteStoreResult<TState, TActions>;
  useSelector<TResult>(
    selector: (state: TState) => TResult,
    options: UseStoreSelectorOptions<TResult>,
  ): TResult;
  useActions(): RemoteActions<TActions> | null;
  useStatus(): RemoteStoreStatus;
  useError(): Error | null;
}

export type RemoteStoreHook<M extends AdapterModel> = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
>(
  definition: NexusStoreDefinition<TState, TActions, M>,
  options?: UseRemoteStoreOptions<M>,
) => UseRemoteStoreResult<TState, TActions>;

export interface RemoteStoreScopeProviderProps<
  U extends AdapterModel = AdapterModel,
> {
  readonly options?: UseRemoteStoreOptions<U>;
  readonly children: ReactNode;
}

export const createRemoteStoreScopeWithNexus = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  M extends AdapterModel,
>(
  definition: NexusStoreDefinition<TState, TActions, M>,
  useBoundRemoteStore: RemoteStoreHook<M>,
): RemoteStoreScope<TState, TActions, M> => {
  const RemoteStoreContext = createContext<UseRemoteStoreResult<
    TState,
    TActions
  > | null>(null);

  const useScopedRemoteStore = (): UseRemoteStoreResult<TState, TActions> => {
    const remote = useContext(RemoteStoreContext);
    if (!remote) {
      throw new Error(
        "Remote store scope hooks must be used within RemoteStoreScope.Provider.",
      );
    }

    return remote;
  };

  const Provider = ({
    options = {},
    children,
  }: RemoteStoreScopeProviderProps<M>): ReactNode => {
    const remote = useBoundRemoteStore(definition, options);

    return (
      <RemoteStoreContext.Provider value={remote}>
        {children}
      </RemoteStoreContext.Provider>
    );
  };

  const useSelector = <TResult,>(
    selector: (state: TState) => TResult,
    options: UseStoreSelectorOptions<TResult>,
  ): TResult => {
    const remote = useScopedRemoteStore();
    return useStoreSelector(remote, selector, options);
  };

  const useActions = (): RemoteActions<TActions> | null => {
    const remote = useScopedRemoteStore();
    return remote.store?.actions ?? null;
  };

  const useStatus = (): RemoteStoreStatus => {
    const remote = useScopedRemoteStore();
    return remote.status;
  };

  const useError = (): Error | null => {
    const remote = useScopedRemoteStore();
    return remote.error;
  };

  return {
    Provider,
    useRemoteStore: useScopedRemoteStore,
    useSelector,
    useActions,
    useStatus,
    useError,
  };
};

export const createRemoteStoreScope = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
>(
  definition: NexusStoreDefinition<TState, TActions, AdapterModel>,
): RemoteStoreScope<TState, TActions, AdapterModel> => {
  return createRemoteStoreScopeWithNexus(definition, useRemoteStore);
};
