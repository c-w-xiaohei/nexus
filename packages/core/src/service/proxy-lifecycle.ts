import { NexusDisconnectedError } from "../errors/call-errors.js";
import { NexusUsageError } from "../errors/usage-errors.js";

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
const lifecycleDetails = new WeakMap<object, ProxyLifecycleDetails>();
const lifecycleFinalizer = new FinalizationRegistry<() => void>((cleanup) => {
  cleanup();
});

type ProxyLifecycleDetails = {
  snapshot: ProxyDebugSnapshot;
  listeners: Set<{ notify: (status: ProxyStatus) => void }>;
};

/** Publish one lifecycle transition while isolating listener failures and reentrancy. */
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

/** Require lifecycle metadata installed on this exact service root. */
const requireDetails = (proxy: object): ProxyLifecycleDetails => {
  const details = lifecycleDetails.get(proxy);
  if (!details) {
    throw new NexusUsageError(
      "Nexus: proxy lifecycle requires an exact Nexus service root proxy.",
      "E_USAGE_INVALID",
    );
  }
  return details;
};

/** Install weak lifecycle metadata and subscriptions on one exact service root. */
export const installProxyLifecycle = (
  proxy: object,
  tokenId: string,
  connectionId: string,
  subscriptions: {
    subscribeDisconnect(listener: () => void): () => void;
    subscribeStale(listener: () => void): () => void;
  },
): void => {
  const snapshot = (status: ProxyStatus): ProxyDebugSnapshot =>
    Object.freeze({ tokenId, connectionId, status });
  const details: ProxyLifecycleDetails = {
    snapshot: snapshot(activeCurrent),
    listeners: new Set(),
  };
  lifecycleDetails.set(proxy, details);
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

  stopStale = subscriptions.subscribeStale(() => {
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
  stopDisconnect = subscriptions.subscribeDisconnect(() => {
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

/** Read the current connection state of an exact service root proxy. */
export const getProxyStatus = (proxy: object): ProxyStatus =>
  requireDetails(proxy).snapshot.status;

export const subscribeProxyStatus = (
  proxy: object,
  listener: (status: ProxyStatus) => void,
): (() => void) => {
  const details = requireDetails(proxy);
  const subscription = { notify: listener };
  const active = details.snapshot.status.type === "active";
  if (active) details.listeners.add(subscription);
  try {
    listener(details.snapshot.status);
  } catch (error) {
    console.error("Nexus: proxy lifecycle listener failed.", error);
  }
  return active ? () => details.listeners.delete(subscription) : noop;
};

/** Return diagnostic identity and status without exposing mutable lifecycle state. */
export const inspectProxy = (proxy: object): ProxyDebugSnapshot =>
  requireDetails(proxy).snapshot;
