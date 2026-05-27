import { createContext, useContext, type ReactNode } from "react";
import type {
  ConnectNexusStoreOptions,
  NexusStoreDefinition,
  RemoteActions,
  RemoteStoreStatus,
} from "@nexus-js/core/state";
import { useRemoteStore, type UseRemoteStoreResult } from "./use-remote-store";
import {
  useStoreSelector,
  type UseStoreSelectorOptions,
} from "./use-store-selector";

type ActionFunction = (...args: any[]) => any;

export interface RemoteStoreScope<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  U extends object,
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

export interface RemoteStoreScopeProviderProps<U extends object = object> {
  readonly options?: ConnectNexusStoreOptions<U>;
  readonly children: ReactNode;
}

export const createRemoteStoreScope = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  U extends object = object,
>(
  definition: NexusStoreDefinition<TState, TActions, U>,
): RemoteStoreScope<TState, TActions, U> => {
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
  }: RemoteStoreScopeProviderProps<U>): ReactNode => {
    const remote = useRemoteStore(definition, options);

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
