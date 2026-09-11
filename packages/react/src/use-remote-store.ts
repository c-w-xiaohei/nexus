import { useEffect, useMemo, useReducer, useState } from "react";
import type { AdapterModel, NexusInstance } from "@nexus-js/core";
import {
  connectNexusStore,
  type ActionFunction,
  type ConnectNexusStoreOptions,
  type NexusStoreDefinition,
  type RemoteStore,
} from "@nexus-js/core/state";
import { useNexus } from "./use-nexus.js";

export type NexusStoreNexus<M extends AdapterModel> = Pick<
  NexusInstance<M>,
  "create" | "safeCreate"
>;

/** Acquisition only. Observe the acquired handle with useStoreStatus or Zustand. */
export type UseRemoteStoreResult<
  S extends object,
  A extends Record<string, ActionFunction>,
> = (
  | { readonly pending: true; readonly store: null; readonly error: null }
  | {
      readonly pending: false;
      readonly store: RemoteStore<S, A>;
      readonly error: null;
    }
  | { readonly pending: false; readonly store: null; readonly error: Error }
) & { readonly reconnect: () => void };

export type UseRemoteStoreOptions<M extends AdapterModel = AdapterModel> =
  ConnectNexusStoreOptions<M> & {
    readonly reconnectKey?: string | number | boolean | null;
  };

/** Owns one session-bound handle; replacement and unmount release it immediately. */
export function useRemoteStore<
  S extends object,
  A extends Record<string, ActionFunction>,
>(
  definition: NexusStoreDefinition<S, A, AdapterModel>,
  options: UseRemoteStoreOptions<AdapterModel> = {},
): UseRemoteStoreResult<S, A> {
  return useRemoteStoreWithNexus(useNexus(), definition, options);
}

export function useRemoteStoreWithNexus<
  S extends object,
  A extends Record<string, ActionFunction>,
  M extends AdapterModel,
>(
  nexus: NexusStoreNexus<M>,
  definition: NexusStoreDefinition<S, A, M>,
  options: UseRemoteStoreOptions<M> = {},
): UseRemoteStoreResult<S, A> {
  const { reconnectKey = null, ...connectOptions } = options;
  const [revision, reconnect] = useReducer((value: number) => value + 1, 0);
  const targetKey = JSON.stringify(connectOptions.target ?? null);
  const timeout = connectOptions.timeout ?? null;
  // Associate the result with all acquisition inputs, including A -> B -> A.
  const request = useMemo(
    () => Symbol(),
    [nexus, definition, targetKey, timeout, reconnectKey, revision],
  );
  const [result, setResult] = useState<{
    request: typeof request;
    value: UseRemoteStoreResult<S, A>;
  }>();
  const pending = useMemo<UseRemoteStoreResult<S, A>>(
    () => ({ pending: true, store: null, error: null, reconnect }),
    [reconnect],
  );

  useEffect(() => {
    let cancelled = false;
    let store: RemoteStore<S, A> | undefined;
    // Use the current predicate on acquisition, not its changing inline identity.
    void connectNexusStore(nexus, definition, connectOptions).then(
      (remote) => {
        if (cancelled) {
          remote.destroy();
          return;
        }
        store = remote;
        setResult({
          request,
          value: { pending: false, store, error: null, reconnect },
        });
      },
      (cause: unknown) => {
        if (cancelled) return;
        setResult({
          request,
          value: {
            pending: false,
            store: null,
            error: cause instanceof Error ? cause : new Error(String(cause)),
            reconnect,
          },
        });
      },
    );
    return () => {
      cancelled = true;
      store?.destroy();
    };
  }, [request, reconnect]);

  // Hide an obsolete handle during render, before effect cleanup can run.
  return result?.request === request ? result.value : pending;
}
