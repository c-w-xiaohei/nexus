import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { RemoteStore } from "@nexus-js/core/state";
import type { UseRemoteStoreResult } from "./use-remote-store";

const isStoreStaleByAdapterMarker = (store: RemoteStore<any, any>): boolean => {
  if (staleStores.has(store)) {
    return true;
  }

  const marker = (store as unknown as Record<symbol, unknown>)[
    Symbol.for("nexus.state.remote-store.mark-stale")
  ];
  return typeof marker !== "undefined" && store.getStatus().type === "stale";
};

const staleStores = new WeakSet<RemoteStore<any, any>>();

export const markStoreAsAdapterStale = (store: RemoteStore<any, any>): void => {
  staleStores.add(store);
};

export const clearStoreAsAdapterStale = (
  store: RemoteStore<any, any>,
): void => {
  staleStores.delete(store);
};

type ActionFunction = (...args: any[]) => any;

export interface UseStoreSelectorOptions<TResult> {
  readonly fallback: TResult;
}

const noopSubscribe = () => () => undefined;

const createStoreSubscription =
  <TState extends object, TActions extends Record<string, ActionFunction>>(
    store: RemoteStore<TState, TActions>,
  ) =>
  (onStoreChange: () => void) =>
    store.subscribe(() => {
      onStoreChange();
    });

export const useStoreSelector = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  TResult,
>(
  remote: UseRemoteStoreResult<TState, TActions>,
  selector: (state: TState) => TResult,
  options: UseStoreSelectorOptions<TResult>,
): TResult => {
  const lastReadyRef = useRef<{
    store: RemoteStore<TState, TActions>;
    value: TResult;
  } | null>(null);
  const subscribe = useMemo(
    () =>
      remote.store ? createStoreSubscription(remote.store) : noopSubscribe,
    [remote.store],
  );

  const selectedFromStore = useSyncExternalStore(
    subscribe,
    () => {
      if (!remote.store) {
        if (!lastReadyRef.current) {
          return options.fallback;
        }

        if (isStoreStaleByAdapterMarker(lastReadyRef.current.store)) {
          return options.fallback;
        }

        const cachedStatus = lastReadyRef.current.store.getStatus();
        if (cachedStatus.type === "stale") {
          return options.fallback;
        }

        return lastReadyRef.current.value;
      }

      return selector(remote.store.getState());
    },
    () => options.fallback,
  );

  useEffect(() => {
    if (remote.status.type === "stale") {
      lastReadyRef.current = null;
      return;
    }

    if (remote.store && remote.status.type === "ready") {
      lastReadyRef.current = {
        store: remote.store,
        value: selector(remote.store.getState()),
      };
    }
  }, [remote.store, remote.status, selector]);

  return selectedFromStore;
};
