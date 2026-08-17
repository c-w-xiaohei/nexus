import { createContext, useContext, type ReactNode } from "react";
import type { AdapterModel, NexusInstance } from "@nexus-js/core";
import type { NexusStoreDefinition } from "@nexus-js/core/state";
import {
  useRemoteStoreWithNexus,
  type UseRemoteStoreOptions,
  type UseRemoteStoreResult,
} from "./use-remote-store.js";
import {
  createRemoteStoreScopeWithNexus,
  type RemoteStoreScope,
} from "./create-remote-store-scope.js";

type ActionFunction = (...args: any[]) => any;

export interface NexusScope<M extends AdapterModel> {
  readonly NexusProvider: (props: NexusProviderProps<M>) => ReactNode;
  useNexus(): NexusInstance<M>;
  useRemoteStore<
    TState extends object,
    TActions extends Record<string, ActionFunction>,
  >(
    definition: NexusStoreDefinition<TState, TActions, M>,
    options?: UseRemoteStoreOptions<M>,
  ): UseRemoteStoreResult<TState, TActions>;
  createRemoteStoreScope<
    TState extends object,
    TActions extends Record<string, ActionFunction>,
  >(
    definition: NexusStoreDefinition<TState, TActions, M>,
  ): RemoteStoreScope<TState, TActions, M>;
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

  const useRemoteStore = <
    TState extends object,
    TActions extends Record<string, ActionFunction>,
  >(
    definition: NexusStoreDefinition<TState, TActions, M>,
    options: UseRemoteStoreOptions<M> = {},
  ): UseRemoteStoreResult<TState, TActions> => {
    return useRemoteStoreWithNexus(useNexus(), definition, options);
  };

  const createRemoteStoreScope = <
    TState extends object,
    TActions extends Record<string, ActionFunction>,
  >(
    definition: NexusStoreDefinition<TState, TActions, M>,
  ): RemoteStoreScope<TState, TActions, M> => {
    return createRemoteStoreScopeWithNexus(definition, useRemoteStore);
  };

  return { NexusProvider, useNexus, useRemoteStore, createRemoteStoreScope };
};
