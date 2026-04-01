import { useEffect, useMemo, useRef, useState } from "react";
import {
  connectNexusStore,
  type ConnectNexusStoreOptions,
  type NexusStoreDefinition,
  type RemoteStore,
  type RemoteStoreStatus,
} from "@nexus-js/core/state";
import { useNexus } from "./use-nexus";
import {
  clearStoreAsAdapterStale,
  markStoreAsAdapterStale,
} from "./use-store-selector";

const MARK_REMOTE_STORE_STALE_SYMBOL = Symbol.for(
  "nexus.state.remote-store.mark-stale",
);

type ActionFunction = (...args: any[]) => any;

export interface UseRemoteStoreResult<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> {
  readonly store: RemoteStore<TState, TActions> | null;
  readonly status: RemoteStoreStatus;
  readonly error: Error | null;
}

const INITIALIZING_STATUS: RemoteStoreStatus = { type: "initializing" };

const matcherIdentityMap = new WeakMap<Function, string>();
let matcherIdentitySequence = 0;

const toMatcherKey = (matcher: unknown): string | null => {
  if (typeof matcher === "undefined") {
    return null;
  }

  if (typeof matcher === "string") {
    return `named:${matcher}`;
  }

  if (typeof matcher !== "function") {
    return null;
  }

  const existing = matcherIdentityMap.get(matcher);
  if (existing) {
    return existing;
  }

  const next = `fn:${++matcherIdentitySequence}`;
  matcherIdentityMap.set(matcher, next);
  return next;
};

const toTargetKey = (options: ConnectNexusStoreOptions): string =>
  JSON.stringify({
    descriptor: options.target?.descriptor ?? null,
    matcher: toMatcherKey(options.target?.matcher),
  });

const toOptionKey = (options: ConnectNexusStoreOptions): string =>
  JSON.stringify({
    timeout: options.timeout ?? null,
    target: JSON.parse(toTargetKey(options)),
  });

const sameStatus = (
  left: RemoteStoreStatus,
  right: RemoteStoreStatus,
): boolean => JSON.stringify(left) === JSON.stringify(right);

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
  definition: NexusStoreDefinition<TState, TActions>,
  options: ConnectNexusStoreOptions = {},
): UseRemoteStoreResult<TState, TActions> => {
  const nexus = useNexus();
  const [store, setStore] = useState<RemoteStore<TState, TActions> | null>(
    null,
  );
  const [status, setStatus] = useState<RemoteStoreStatus>(INITIALIZING_STATUS);
  const [error, setError] = useState<Error | null>(null);
  const activeStoreRef = useRef<RemoteStore<TState, TActions> | null>(null);
  const staleStoreRef = useRef<RemoteStore<TState, TActions> | null>(null);
  const activeTargetKeyRef = useRef<string | null>(null);
  const lastStatusRef = useRef<RemoteStoreStatus>(INITIALIZING_STATUS);
  const connectVersionRef = useRef(0);

  const targetKey = useMemo(() => toTargetKey(options), [options]);
  const optionKey = useMemo(() => toOptionKey(options), [options]);

  useEffect(() => {
    connectVersionRef.current += 1;
    const version = connectVersionRef.current;

    const previousStore = activeStoreRef.current;
    let previousLastKnownVersion: number | null = null;
    let shouldSetStale = false;

    if (previousStore) {
      const previousStatus = previousStore.getStatus();
      if (previousStatus.type === "ready") {
        previousLastKnownVersion = previousStatus.version;
      } else if (
        previousStatus.type === "disconnected" ||
        previousStatus.type === "stale"
      ) {
        previousLastKnownVersion = previousStatus.lastKnownVersion;
      }
    }

    if (
      staleStoreRef.current !== null &&
      staleStoreRef.current !== previousStore
    ) {
      clearStoreStale(staleStoreRef.current);
      staleStoreRef.current.destroy();
      staleStoreRef.current = null;
    }

    if (previousStore) {
      const previousStatus = previousStore.getStatus();
      if (
        (previousStatus.type === "ready" ||
          previousStatus.type === "stale" ||
          previousStatus.type === "disconnected") &&
        activeTargetKeyRef.current !== null &&
        activeTargetKeyRef.current !== targetKey
      ) {
        markStoreStale(previousStore);

        staleStoreRef.current = previousStore;
        shouldSetStale = true;
      } else {
        clearStoreStale(previousStore);
        previousStore.destroy();
      }

      activeStoreRef.current = null;
      activeTargetKeyRef.current = null;
    }

    setStore(null);

    if (!shouldSetStale) {
      staleStoreRef.current = null;
    }
    setStatus(INITIALIZING_STATUS);
    lastStatusRef.current = INITIALIZING_STATUS;
    setError(null);

    let cancelled = false;

    void connectNexusStore(nexus, definition, options)
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
        activeTargetKeyRef.current = targetKey;
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
          clearStoreStale(staleStoreRef.current);
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
  }, [definition, nexus, optionKey, targetKey]);

  useEffect(() => {
    return () => {
      const activeStore = activeStoreRef.current;
      if (activeStore) {
        activeStoreRef.current = null;
        activeTargetKeyRef.current = null;
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

    const statusPoll = setInterval(() => {
      publishStatusIfNeeded();
    }, 25);

    const unsubscribe = store.subscribe(() => {
      publishStatusIfNeeded();
    });

    return () => {
      clearInterval(statusPoll);
      unsubscribe();
    };
  }, [store]);

  return {
    store,
    status,
    error,
  };
};
