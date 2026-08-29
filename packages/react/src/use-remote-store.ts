import { useEffect, useReducer, useRef, useState } from "react";
import type { AdapterModel, NexusInstance } from "@nexus-js/core";
import {
  connectNexusStore,
  type ConnectNexusStoreOptions,
  type NexusStoreDefinition,
  type RemoteStore,
  type RemoteStoreStatus,
} from "@nexus-js/core/state";
import { useNexus } from "./use-nexus.js";
import {
  clearStoreAsAdapterStale,
  markStoreAsAdapterStale,
} from "./use-store-selector.js";

const MARK_REMOTE_STORE_STALE_SYMBOL = Symbol.for(
  "nexus.state.remote-store.mark-stale",
);

type ActionFunction = (...args: any[]) => any;

export type NexusStoreNexus<M extends AdapterModel> = Pick<
  NexusInstance<M>,
  "create" | "safeCreate"
>;

interface TargetIdentity {
  readonly targetKey: string;
}

export interface UseRemoteStoreResult<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> {
  readonly store: RemoteStore<TState, TActions> | null;
  readonly status: RemoteStoreStatus;
  readonly error: Error | null;
  readonly reconnect: () => void;
}

export type UseRemoteStoreOptions<M extends AdapterModel = AdapterModel> =
  ConnectNexusStoreOptions<M> & {
    readonly reconnectKey?: string | number | boolean | null;
  };

const INITIALIZING_STATUS: RemoteStoreStatus = { type: "initializing" };

const toTargetIdentity = (
  options: ConnectNexusStoreOptions<any>,
): TargetIdentity => ({
  targetKey: JSON.stringify({
    target: options.target ?? null,
  }),
});

const sameTarget = (left: TargetIdentity, right: TargetIdentity): boolean =>
  left.targetKey === right.targetKey;

const getLastKnownVersion = (status: RemoteStoreStatus): number | null => {
  if (status.type === "ready") {
    return status.version;
  }

  if (status.type === "disconnected" || status.type === "stale") {
    return status.lastKnownVersion;
  }

  return null;
};

const sameStatus = (
  left: RemoteStoreStatus,
  right: RemoteStoreStatus,
): boolean => {
  switch (left.type) {
    case "ready":
      return (
        right.type === "ready" &&
        left.storeInstanceId === right.storeInstanceId &&
        left.version === right.version
      );
    case "disconnected":
      return (
        right.type === "disconnected" &&
        left.lastKnownVersion === right.lastKnownVersion &&
        left.cause === right.cause
      );
    case "stale":
      return (
        right.type === "stale" &&
        left.lastKnownVersion === right.lastKnownVersion &&
        left.reason === right.reason
      );
    default:
      return left.type === right.type;
  }
};

const markStoreStale = (target: RemoteStore<any, any>): void => {
  const marker = (target as unknown as Record<symbol, unknown>)[
    MARK_REMOTE_STORE_STALE_SYMBOL
  ];
  if (typeof marker === "function") {
    marker.call(target);
  }

  markStoreAsAdapterStale(target);
};

const clearStoreStale = (target: RemoteStore<any, any>): void => {
  clearStoreAsAdapterStale(target);
};

export const useRemoteStore = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
>(
  definition: NexusStoreDefinition<TState, TActions, AdapterModel>,
  options: UseRemoteStoreOptions<AdapterModel> = {},
): UseRemoteStoreResult<TState, TActions> => {
  return useRemoteStoreWithNexus(useNexus(), definition, options);
};

export const useRemoteStoreWithNexus = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  M extends AdapterModel,
>(
  nexus: NexusStoreNexus<M>,
  definition: NexusStoreDefinition<TState, TActions, M>,
  options: UseRemoteStoreOptions<M> = {},
): UseRemoteStoreResult<TState, TActions> => {
  const { reconnectKey = null, ...connectOptions } = options;
  const [store, setStore] = useState<RemoteStore<TState, TActions> | null>(
    null,
  );
  const [status, setStatus] = useState<RemoteStoreStatus>(INITIALIZING_STATUS);
  const [error, setError] = useState<Error | null>(null);
  const [manualReconnectRevision, reconnect] = useReducer(
    (revision: number) => revision + 1,
    0,
  );
  const activeStoreRef = useRef<RemoteStore<TState, TActions> | null>(null);
  const staleStoreRef = useRef<RemoteStore<TState, TActions> | null>(null);
  const activeTargetRef = useRef<TargetIdentity | null>(null);
  const lastConnectedStoreRef = useRef<RemoteStore<TState, TActions> | null>(
    null,
  );
  const lastConnectedTargetRef = useRef<TargetIdentity | null>(null);
  const effectTargetRef = useRef<TargetIdentity | null>(null);
  const lastStatusRef = useRef<RemoteStoreStatus>(INITIALIZING_STATUS);
  const connectVersionRef = useRef(0);
  const latestConnectOptionsRef = useRef(connectOptions);

  const target = toTargetIdentity(connectOptions);
  const timeout = connectOptions.timeout ?? null;
  const targetChangedBeforeEffect =
    effectTargetRef.current !== null &&
    !sameTarget(effectTargetRef.current, target);
  const renderStatus: RemoteStoreStatus = targetChangedBeforeEffect
    ? {
        type: "stale",
        lastKnownVersion: getLastKnownVersion(lastStatusRef.current),
        reason: "target-changed",
      }
    : status;

  useEffect(() => {
    latestConnectOptionsRef.current = connectOptions;
  });

  useEffect(() => {
    effectTargetRef.current = target;
    connectVersionRef.current += 1;
    const version = connectVersionRef.current;

    const previousStore = activeStoreRef.current;
    const previousStatus = previousStore?.getStatus();
    const previousLastKnownVersion = previousStatus
      ? getLastKnownVersion(previousStatus)
      : null;

    if (previousStore && previousStatus) {
      if (
        (previousStatus.type === "ready" ||
          previousStatus.type === "stale" ||
          previousStatus.type === "disconnected") &&
        activeTargetRef.current !== null &&
        !sameTarget(activeTargetRef.current, target)
      ) {
        markStoreStale(previousStore);

        staleStoreRef.current = previousStore;
      } else {
        clearStoreStale(previousStore);
        previousStore.destroy();
      }

      activeStoreRef.current = null;
      activeTargetRef.current = null;
    } else if (
      lastConnectedStoreRef.current &&
      lastConnectedTargetRef.current !== null &&
      !sameTarget(lastConnectedTargetRef.current, target)
    ) {
      markStoreStale(lastConnectedStoreRef.current);
    }

    setStore(null);

    setStatus(INITIALIZING_STATUS);
    lastStatusRef.current = INITIALIZING_STATUS;
    setError(null);

    let cancelled = false;

    void connectNexusStore(nexus, definition, latestConnectOptionsRef.current)
      .then((remote) => {
        if (cancelled || version !== connectVersionRef.current) {
          remote.destroy();
          return;
        }

        if (staleStoreRef.current && staleStoreRef.current !== remote) {
          clearStoreStale(staleStoreRef.current);
          staleStoreRef.current.destroy();
          staleStoreRef.current = null;
        }

        clearStoreStale(remote);
        activeStoreRef.current = remote;
        activeTargetRef.current = target;
        lastConnectedStoreRef.current = remote;
        lastConnectedTargetRef.current = target;
        setStore(remote);
        const nextStatus = remote.getStatus();
        setStatus(nextStatus);
        lastStatusRef.current = nextStatus;
      })
      .catch((nextError) => {
        if (cancelled || version !== connectVersionRef.current) {
          return;
        }

        if (staleStoreRef.current) {
          staleStoreRef.current.destroy();
          staleStoreRef.current = null;
        }

        setStore(null);
        const normalizedError =
          nextError instanceof Error ? nextError : new Error(String(nextError));
        const failedStatus: RemoteStoreStatus = {
          type: "disconnected",
          lastKnownVersion: previousLastKnownVersion,
          cause: normalizedError,
        };
        setStatus(failedStatus);
        lastStatusRef.current = failedStatus;
        setError(normalizedError);
      });

    return () => {
      cancelled = true;
    };
  }, [
    definition,
    manualReconnectRevision,
    nexus,
    reconnectKey,
    target.targetKey,
    timeout,
  ]);

  useEffect(() => {
    return () => {
      const activeStore = activeStoreRef.current;
      if (activeStore) {
        activeStoreRef.current = null;
        activeTargetRef.current = null;
        clearStoreStale(activeStore);
        activeStore.destroy();
      }

      if (staleStoreRef.current) {
        clearStoreStale(staleStoreRef.current);
        staleStoreRef.current.destroy();
        staleStoreRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!store) {
      return;
    }

    const publishStatusIfNeeded = (): void => {
      if (store !== activeStoreRef.current) {
        return;
      }

      const nextStatus = store.getStatus();
      if (sameStatus(lastStatusRef.current, nextStatus)) {
        return;
      }

      lastStatusRef.current = nextStatus;
      setStatus(nextStatus);
    };

    publishStatusIfNeeded();

    if (store.subscribeStatus) {
      return store.subscribeStatus(publishStatusIfNeeded);
    }

    const statusPoll = setInterval(publishStatusIfNeeded, 25);
    const unsubscribeState = store.subscribe(publishStatusIfNeeded);

    return () => {
      clearInterval(statusPoll);
      unsubscribeState();
    };
  }, [store]);

  return {
    store: targetChangedBeforeEffect ? null : store,
    status: renderStatus,
    error,
    reconnect,
  };
};
