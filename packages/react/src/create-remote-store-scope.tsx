import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { AdapterModel } from "@nexus-js/core";
import type {
  RemoteActions,
  RemoteStoreStatus,
  StoreData,
  StoreToken,
} from "@nexus-js/core/state";
import {
  useRemoteStore,
  type UseRemoteStoreOptions,
  type UseRemoteStoreResult,
} from "./use-remote-store.js";
import { useStoreStatus } from "./use-store-status.js";

const subscribeNone = () => () => {};

export interface RemoteStoreScope<
  Store extends object,
  U extends AdapterModel,
> {
  readonly Provider: (props: RemoteStoreScopeProviderProps<U>) => ReactNode;
  useRemoteStore(): UseRemoteStoreResult<Store>;
  useSelector<TResult>(
    selector: (state: StoreData<Store>) => TResult,
    options: { readonly fallback: TResult },
  ): TResult;
  useActions(): RemoteActions<Store> | null;
  useStatus(): RemoteStoreStatus | null;
  useStatus<T>(selector: (status: RemoteStoreStatus) => T): T | null;
  useError(): Error | null;
}

export type RemoteStoreHook<M extends AdapterModel> = <Store extends object>(
  token: StoreToken<Store, M>,
  options?: UseRemoteStoreOptions<M>,
) => UseRemoteStoreResult<Store>;

export interface RemoteStoreScopeProviderProps<
  U extends AdapterModel = AdapterModel,
> {
  readonly options?: UseRemoteStoreOptions<U>;
  readonly children: ReactNode;
}

export const createRemoteStoreScopeWithNexus = <
  Store extends object,
  M extends AdapterModel,
>(
  token: StoreToken<Store, M>,
  useBoundRemoteStore: RemoteStoreHook<M>,
): RemoteStoreScope<Store, M> => {
  const RemoteStoreContext = createContext<UseRemoteStoreResult<Store> | null>(
    null,
  );

  const useScopedRemoteStore = (): UseRemoteStoreResult<Store> => {
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
    const remote = useBoundRemoteStore(token, options);

    return (
      <RemoteStoreContext.Provider value={remote}>
        {children}
      </RemoteStoreContext.Provider>
    );
  };

  const useSelector = <TResult,>(
    selector: (state: StoreData<Store>) => TResult,
    options: { readonly fallback: TResult },
  ): TResult => {
    const { store } = useScopedRemoteStore();
    return useSyncExternalStore(
      store?.subscribe ?? subscribeNone,
      () => (store ? selector(store.getState()) : options.fallback),
      () => (store ? selector(store.getInitialState()) : options.fallback),
    );
  };

  const useActions = (): RemoteActions<Store> | null => {
    const remote = useScopedRemoteStore();
    return remote.store?.actions ?? null;
  };

  function useStatus(): RemoteStoreStatus | null;
  function useStatus<T>(selector: (status: RemoteStoreStatus) => T): T | null;
  function useStatus<T>(selector?: (status: RemoteStoreStatus) => T) {
    return useStoreStatus<T | RemoteStoreStatus>(
      useScopedRemoteStore().store,
      selector ?? ((status) => status),
    );
  }

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

export const createRemoteStoreScope = <Store extends object>(
  token: StoreToken<Store, AdapterModel>,
): RemoteStoreScope<Store, AdapterModel> => {
  return createRemoteStoreScopeWithNexus(token, useRemoteStore);
};
