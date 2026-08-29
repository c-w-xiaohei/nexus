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

type ProxyLifecycleDetails = {
  owner: object;
  snapshot: ProxyDebugSnapshot;
  listeners: Set<{ notify: () => void }>;
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
  const transitionTo = (status: ProxyStatus): void => {
    details.snapshot = snapshot(status);
    for (const listener of [...details.listeners]) {
      if (details.snapshot.status !== status) {
        return;
      }
      if (!details.listeners.has(listener)) {
        continue;
      }
      try {
        listener.notify();
      } catch (error) {
        console.error("Nexus: proxy lifecycle listener failed.", error);
      }
    }
  };
  Object.defineProperty(proxy, lifecycleDetails, {
    value: details,
  });
  const stopStale: () => void = subscribeStale(() => {
    if (
      details.snapshot.status.type !== "active" ||
      details.snapshot.status.selection !== "current"
    ) {
      return;
    }
    transitionTo(activeStale);
  });
  const stopDisconnect: () => void = subscribeDisconnect(() => {
    if (details.snapshot.status.type === "disconnected") {
      return;
    }
    stopStale();
    stopDisconnect();
    const error = Object.freeze(
      new NexusDisconnectedError("Nexus connection disconnected."),
    );
    transitionTo(
      Object.freeze({
        type: "disconnected",
        error,
      }),
    );
    details.listeners.clear();
  });
};

export const getProxyStatus = (proxy: object): ProxyStatus =>
  requireDetails(proxy).snapshot.status;

export const subscribeProxyStatus = (
  proxy: object,
  listener: () => void,
): (() => void) => {
  const details = requireDetails(proxy);
  if (details.snapshot.status.type === "disconnected") {
    return noop;
  }
  const subscription = { notify: listener };
  details.listeners.add(subscription);
  return () => details.listeners.delete(subscription);
};

export const inspectProxy = (proxy: object): ProxyDebugSnapshot =>
  requireDetails(proxy).snapshot;
