import { useSyncExternalStore } from "react";
import type { RemoteStore, RemoteStoreStatus } from "@nexus-js/core/state";

type StatusSource = Pick<RemoteStore<object>, "getStatus" | "subscribeStatus">;
const subscribeNone = () => () => {};

/**
 * Observes a handle without acquiring or owning it. Returns null without a handle
 * and during SSR. Select a primitive or stable reference to avoid version-only renders.
 */
export function useStoreStatus(
  store: StatusSource | null,
): RemoteStoreStatus | null;
export function useStoreStatus<T>(
  store: StatusSource | null,
  selector: (status: RemoteStoreStatus) => T,
): T | null;
export function useStoreStatus<T>(
  store: StatusSource | null,
  selector?: (status: RemoteStoreStatus) => T,
): RemoteStoreStatus | T | null {
  return useSyncExternalStore(
    store?.subscribeStatus ?? subscribeNone,
    () => {
      if (!store) return null;
      const status = store.getStatus();
      return selector ? selector(status) : status;
    },
    () => null,
  );
}
