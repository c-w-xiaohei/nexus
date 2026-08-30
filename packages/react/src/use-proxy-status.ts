import { useMemo, useSyncExternalStore } from "react";
import { Nexus, type NexusError } from "@nexus-js/core";

const subscribeNone = () => () => undefined;
const getServerSnapshot = () => null;
const missingLifecycleCapability = "useProxyStatus requires Core >=1.1.0";

type ProxyStatusView =
  | Readonly<{ type: "active"; selection: "current" | "stale" }>
  | Readonly<{ type: "disconnected"; error: NexusError }>;

type ProxyLifecycleCapability = {
  getProxyStatus(proxy: object): ProxyStatusView;
  subscribeProxyStatus(
    proxy: object,
    listener: (status: ProxyStatusView) => void,
  ): () => void;
};

function getLifecycleCapability(): ProxyLifecycleCapability {
  const lifecycle = Nexus as unknown as Partial<ProxyLifecycleCapability>;
  if (
    typeof lifecycle.getProxyStatus !== "function" ||
    typeof lifecycle.subscribeProxyStatus !== "function"
  ) {
    throw new Error(missingLifecycleCapability);
  }
  return lifecycle as ProxyLifecycleCapability;
}

/**
 * Observes an already-acquired ordinary unicast root proxy without owning it.
 * Does not acquire, release, reconnect, or replace the proxy.
 * Requires `@nexus-js/core` >= 1.1.0 when a proxy is supplied on the client.
 */
export function useProxyStatus(
  proxy: object | null | undefined,
): ProxyStatusView | null;
/**
 * Observes an already-acquired ordinary unicast root proxy without owning it.
 * Does not acquire, release, reconnect, or replace the proxy.
 * Requires `@nexus-js/core` >= 1.1.0 when a proxy is supplied on the client.
 */
export function useProxyStatus<TSelected>(
  proxy: object | null | undefined,
  selector: (status: ProxyStatusView) => TSelected,
): TSelected | null;
export function useProxyStatus<TSelected>(
  proxy: object | null | undefined,
  selector?: (status: ProxyStatusView) => TSelected,
): ProxyStatusView | TSelected | null {
  const subscribe = useMemo(
    () =>
      proxy == null
        ? subscribeNone
        : (onStoreChange: () => void) => {
            const lifecycle = getLifecycleCapability();
            return lifecycle.subscribeProxyStatus(proxy, () => onStoreChange());
          },
    [proxy],
  );
  const getSnapshot = useMemo(() => {
    let cached:
      | { status: ProxyStatusView; value: ProxyStatusView | TSelected }
      | undefined;

    return () => {
      if (proxy == null) return null;

      const nextStatus = getLifecycleCapability().getProxyStatus(proxy);
      if (cached?.status === nextStatus) return cached.value;

      const nextValue = selector ? selector(nextStatus) : nextStatus;
      if (cached && Object.is(cached.value, nextValue)) {
        cached.status = nextStatus;
        return cached.value;
      }

      cached = { status: nextStatus, value: nextValue };
      return nextValue;
    };
  }, [proxy, selector]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
