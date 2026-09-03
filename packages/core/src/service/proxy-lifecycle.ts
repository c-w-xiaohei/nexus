import { NexusDisconnectedError } from "../errors/call-errors.js";
import { NexusUsageError } from "../errors/usage-errors.js";
import {
  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
} from "@/types/symbols";

export type ProxyStatus =
  | { readonly type: "active"; readonly selection: "current" | "stale" }
  | { readonly type: "disconnected"; readonly error: NexusDisconnectedError };

export type ProxyDebugSnapshot = Readonly<{
  tokenId: string;
  connectionId: string;
  status: ProxyStatus;
}>;

const activeCurrent = Object.freeze({
  type: "active",
  selection: "current",
} as const);
const activeStale = Object.freeze({
  type: "active",
  selection: "stale",
} as const);
const noop = (): void => undefined;
const lifecycleDetails = Symbol("nexus.proxy.lifecycle.details");
const lifecycleFinalizer = new FinalizationRegistry<() => void>((cleanup) => {
  cleanup();
});

type ProxyLifecycleDetails = {
  owner: object;
  snapshot: ProxyDebugSnapshot;
  listeners: Set<{ notify: (status: ProxyStatus) => void }>;
};

const transitionTo = (
  details: ProxyLifecycleDetails,
  snapshot: (status: ProxyStatus) => ProxyDebugSnapshot,
  status: ProxyStatus,
): void => {
  details.snapshot = snapshot(status);
  for (const listener of [...details.listeners]) {
    if (details.snapshot.status !== status) {
      return;
    }
    if (!details.listeners.has(listener)) {
      continue;
    }
    try {
      listener.notify(status);
    } catch (error) {
      console.error("Nexus: proxy lifecycle listener failed.", error);
    }
  }
};

const requireDetails = (proxy: object): ProxyLifecycleDetails => {
  const objectLike =
    typeof proxy === "function" ||
    (typeof proxy === "object" && proxy !== null);
  const details = objectLike
    ? Object.getOwnPropertyDescriptor(proxy, lifecycleDetails)?.value
    : undefined;
  if (details?.owner !== proxy) {
    throw new NexusUsageError(
      "Nexus: proxy lifecycle requires an exact Nexus service root proxy.",
      "E_USAGE_INVALID",
    );
  }
  return details;
};

export const installProxyLifecycle = (
  proxy: object,
  tokenId: string,
  connectionId: string,
): void => {
  const subscribeDisconnect = Object.getOwnPropertyDescriptor(
    proxy,
    NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  )?.value;
  const subscribeStale = Object.getOwnPropertyDescriptor(
    proxy,
    NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
  )?.value;
  if (
    typeof subscribeDisconnect !== "function" ||
    typeof subscribeStale !== "function"
  ) {
    throw new NexusUsageError(
      "Nexus: proxy lifecycle requires connection lifecycle capabilities.",
      "E_USAGE_INVALID",
    );
  }

  const snapshot = (status: ProxyStatus): ProxyDebugSnapshot =>
    Object.freeze({ tokenId, connectionId, status });
  const details: ProxyLifecycleDetails = {
    owner: proxy,
    snapshot: snapshot(activeCurrent),
    listeners: new Set(),
  };
  Object.defineProperty(proxy, lifecycleDetails, {
    value: details,
  });
  const detailsRef = new WeakRef(details);
  const finalizerToken = {};
  let stopStale = noop;
  let stopDisconnect = noop;
  let stopped = false;
  const cleanup = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    stopStale();
    stopDisconnect();
    lifecycleFinalizer.unregister(finalizerToken);
  };
  lifecycleFinalizer.register(proxy, cleanup, finalizerToken);

  stopStale = subscribeStale(() => {
    const current = detailsRef.deref();
    if (!current) {
      cleanup();
      return;
    }
    if (
      current.snapshot.status.type !== "active" ||
      current.snapshot.status.selection !== "current"
    ) {
      return;
    }
    transitionTo(current, snapshot, activeStale);
  });
  if (stopped) {
    stopStale();
  }
  stopDisconnect = subscribeDisconnect(() => {
    const current = detailsRef.deref();
    if (!current) {
      cleanup();
      return;
    }
    if (current.snapshot.status.type === "disconnected") {
      return;
    }
    cleanup();
    const error = Object.freeze(
      new NexusDisconnectedError("Nexus connection disconnected."),
    );
    transitionTo(
      current,
      snapshot,
      Object.freeze({
        type: "disconnected",
        error,
      }),
    );
    current.listeners.clear();
  });
  if (stopped) {
    stopDisconnect();
  }
};

export const getProxyStatus = (proxy: object): ProxyStatus =>
  requireDetails(proxy).snapshot.status;

export const subscribeProxyStatus = (
  proxy: object,
  listener: (status: ProxyStatus) => void,
): (() => void) => {
  const details = requireDetails(proxy);
  if (details.snapshot.status.type === "disconnected") {
    try {
      listener(details.snapshot.status);
    } catch (error) {
      console.error("Nexus: proxy lifecycle listener failed.", error);
    }
    return noop;
  }
  const subscription = { notify: listener };
  details.listeners.add(subscription);
  try {
    listener(details.snapshot.status);
  } catch (error) {
    console.error("Nexus: proxy lifecycle listener failed.", error);
  }
  return () => details.listeners.delete(subscription);
};

export const inspectProxy = (proxy: object): ProxyDebugSnapshot =>
  requireDetails(proxy).snapshot;
