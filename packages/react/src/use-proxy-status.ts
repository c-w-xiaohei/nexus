import { useMemo, useSyncExternalStore } from "react";
import { Nexus, type ProxyStatus } from "@nexus-js/core";

const subscribeNone = () => () => undefined;
const getServerSnapshot = () => null;

/**
 * Observes an already-acquired ordinary unicast root proxy without owning it.
 * Does not acquire, release, reconnect, or replace the proxy.
 * Requires the compatible `@nexus-js/core` peer dependency.
 */
export function useProxyStatus(
  proxy: object | null | undefined,
): ProxyStatus | null;
/**
 * Observes an already-acquired ordinary unicast root proxy without owning it.
 * Does not acquire, release, reconnect, or replace the proxy.
 * Requires the compatible `@nexus-js/core` peer dependency.
 */
export function useProxyStatus<TSelected>(
  proxy: object | null | undefined,
  selector: (status: ProxyStatus) => TSelected,
): TSelected | null;
export function useProxyStatus<TSelected>(
  proxy: object | null | undefined,
  selector?: (status: ProxyStatus) => TSelected,
): ProxyStatus | TSelected | null {
  const subscribe = useMemo(
    () =>
      proxy == null
        ? subscribeNone
        : (onStoreChange: () => void) => {
            return Nexus.subscribeProxyStatus(proxy, () => onStoreChange());
          },
    [proxy],
  );
  const getSnapshot = useMemo(() => {
    let cached:
      | { status: ProxyStatus; value: ProxyStatus | TSelected }
      | undefined;

    return () => {
      if (proxy == null) return null;

      const nextStatus = Nexus.getProxyStatus(proxy);
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
