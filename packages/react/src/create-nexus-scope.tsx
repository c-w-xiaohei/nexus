import { createContext, useContext, type ReactNode } from "react";
import type { AdapterModel, NexusInstance } from "@nexus-js/core";
import type { StoreToken } from "@nexus-js/core/state";
import {
  useRemoteStoreWithNexus,
  type UseRemoteStoreOptions,
  type UseRemoteStoreResult,
} from "./use-remote-store.js";
import {
  createRemoteStoreScopeWithNexus,
  type RemoteStoreScope,
} from "./create-remote-store-scope.js";

export interface NexusScope<M extends AdapterModel> {
  readonly NexusProvider: (props: NexusProviderProps<M>) => ReactNode;
  useNexus(): NexusInstance<M>;
  useRemoteStore<Store extends object>(
    token: StoreToken<Store, M>,
    options?: UseRemoteStoreOptions<M>,
  ): UseRemoteStoreResult<Store>;
  createRemoteStoreScope<Store extends object>(
    token: StoreToken<Store, M>,
  ): RemoteStoreScope<Store, M>;
}

export interface NexusProviderProps<M extends AdapterModel = AdapterModel> {
  readonly nexus: NexusInstance<M>;
  readonly children?: ReactNode;
}

export const createNexusScope = <M extends AdapterModel>(): NexusScope<M> => {
  const NexusContext = createContext<NexusInstance<M> | null>(null);

  const NexusProvider = ({
    nexus,
    children,
  }: NexusProviderProps<M>): ReactNode => {
    return (
      <NexusContext.Provider value={nexus}>{children}</NexusContext.Provider>
    );
  };

  const useNexus = (): NexusInstance<M> => {
    const nexus = useContext(NexusContext);
    if (!nexus) {
      throw new Error("useNexus must be used inside NexusProvider.");
    }

    return nexus;
  };

  const useRemoteStore = <Store extends object>(
    token: StoreToken<Store, M>,
    options: UseRemoteStoreOptions<M> = {},
  ): UseRemoteStoreResult<Store> => {
    return useRemoteStoreWithNexus(useNexus(), token, options);
  };

  const createRemoteStoreScope = <Store extends object>(
    token: StoreToken<Store, M>,
  ): RemoteStoreScope<Store, M> => {
    return createRemoteStoreScopeWithNexus(token, useRemoteStore);
  };

  return { NexusProvider, useNexus, useRemoteStore, createRemoteStoreScope };
};
