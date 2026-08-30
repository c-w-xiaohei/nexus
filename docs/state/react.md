# Nexus State React Guide

This Nexus State guide covers `@nexus-js/react`.

## Public Surface

```ts
import {
  createNexusScope,
  createRemoteStoreScope,
  NexusProvider,
  useNexus,
  useProxyStatus,
  useRemoteStore,
  useStoreSelector,
} from "@nexus-js/react";
```

## `NexusProvider`

Inject a Nexus instance into the React tree.

```tsx
<NexusProvider nexus={nexus}>
  <App />
</NexusProvider>
```

## `useNexus()`

Reads the injected Nexus instance.

```tsx
function RuntimeName() {
  useNexus();
  return <span>Nexus context is available.</span>;
}
```

It fails fast outside `NexusProvider` on purpose.

## `createNexusScope()`

Use a model-bound React scope when the same application contains multiple adapter models and the provider, hooks, store definitions, and targeting options must stay associated at compile time:

```tsx
import { createNexusScope } from "@nexus-js/react";
import {
  usingBackgroundScript,
  type ChromeAdapterModel,
} from "@nexus-js/chrome";

const ChromeNexus = createNexusScope<ChromeAdapterModel>();
const chromeNexus = usingBackgroundScript();

function ChromeApp() {
  return (
    <ChromeNexus.NexusProvider nexus={chromeNexus}>
      <App />
    </ChromeNexus.NexusProvider>
  );
}
```

Use `ChromeNexus.useNexus()`, `ChromeNexus.useRemoteStore()`, and `ChromeNexus.createRemoteStoreScope()` inside that tree. The default `NexusProvider` and hooks remain the simpler path when the application does not need model-specific React context typing.

## `createRemoteStoreScope()`

Recommended React pattern for shared remote stores. Declare the store connection once near the subtree that needs it, then consume selector, actions, status, or the raw remote result from children.

```tsx
import { createRemoteStoreScope, NexusProvider } from "@nexus-js/react";
import { usingBackgroundScript, chromeTarget } from "@nexus-js/chrome";
import { counterStore } from "./counter-store";

const CounterScope = createRemoteStoreScope(counterStore);
const chromeNexus = usingBackgroundScript();

function CounterPanel() {
  return (
    <NexusProvider nexus={chromeNexus}>
      <CounterScope.Provider options={{ target: chromeTarget.background() }}>
        <CounterButton />
        <CounterStatus />
      </CounterScope.Provider>
    </NexusProvider>
  );
}

function CounterButton() {
  const count = CounterScope.useSelector((state) => state.count, {
    fallback: 0,
  });
  const actions = CounterScope.useActions();
  const status = CounterScope.useStatus();

  if (!actions || status.type !== "ready") {
    return <button disabled>{count}</button>;
  }

  return <button onClick={() => actions.increment(1)}>{count}</button>;
}

function CounterStatus() {
  const status = CounterScope.useStatus();
  const error = CounterScope.useError();

  if (status.type === "disconnected") {
    return <span>Disconnected: {error?.message}</span>;
  }

  return <span>{status.type}</span>;
}
```

Scope hooks fail fast outside `RemoteStoreScope.Provider`. The scope provider still depends on `NexusProvider` because it delegates to `useRemoteStore()` internally.

The provider owns one shared acquisition for its subtree. Its `options` accept `reconnectKey`, and every `CounterScope.useRemoteStore()` consumer receives the same stable `reconnect` command. The scope does not add a registry, retry manager, replay policy, or action fallback. `useActions()` returns `null` until the underlying remote store exists, so callers keep explicit control over disabled UI, recovery, and replay decisions.

## `useProxyStatus()`

Observe the lifecycle of an already-acquired exact ordinary unicast root proxy.
This hook needs no `NexusProvider` and does not acquire, release, reconnect, or
replace the proxy.

```tsx
import { useProxyStatus } from "@nexus-js/react";

function OrderStatus({ orders }: { orders: object | null }) {
  const status = useProxyStatus(orders);
  return <span>{status?.type ?? "unavailable"}</span>;
}
```

Pass a selector to subscribe a component to a derived value. React compares
the selected snapshot with `Object.is`.

```tsx
const connected = useProxyStatus(orders, (status) => status.type === "active");
```

Only `null` and `undefined` mean no proxy and return `null`. Other invalid
values are passed to Core validation and throw its original `NexusUsageError`.
The proxy remains session-bound: this hook only observes it; application code
owns any explicit replacement acquisition.

During server rendering the hook returns `null` without reading Core. Hydration
starts from that same `null` snapshot, then reads and observes the client proxy.
Supplying a proxy on the client requires `@nexus-js/core` >= 1.1.0; the React
package otherwise remains compatible with Core >= 1.0.0 for its existing APIs.

## `useRemoteStore()`

Low-level hook for connecting directly to a remote Nexus State store. Use it when one component owns the connection lifecycle or when you need direct composition around the raw remote result. For shared subtree usage, prefer `createRemoteStoreScope()` so leaf components do not each start their own store connection.

Use `reconnectKey` for an external committed session or lifecycle revision, such as a background restart notification. Use `remote.reconnect()` from an event handler, callback, or timer. Both controls feed the same hook-owned replacement acquisition path using the latest committed Nexus instance, definition, target, and connector options. Updates from one React commit may coalesce into one attempt; a later commit starts a newer generation and only its result can publish. `reconnectKey` is React-only orchestration state and is not forwarded to the core store connector.

Both controls trigger a replacement acquisition attempt. They do not revive an old handle, replay store actions, retry failed business actions, or guarantee that the remote target is available or that the attempt succeeds. The `reconnect` function reference is stable; the `UseRemoteStoreResult` object is not promised to be stable.

```tsx
import { chromeTarget } from "@nexus-js/chrome";

function CounterRemote({ sessionEpoch }: { sessionEpoch: number }) {
  const remote = useRemoteStore(counterStore, {
    target: chromeTarget.background(),
    reconnectKey: sessionEpoch,
  });

  return <button onClick={remote.reconnect}>Reconnect</button>;
}
```

Return shape:

```ts
type UseRemoteStoreResult<TState, TActions> = {
  store: RemoteStore<TState, TActions> | null;
  status: RemoteStoreStatus;
  error: Error | null;
  reconnect(): void;
};
```

### Important semantics

- before first ready: `store` may be `null`
- on replacement: the hook result moves through replacement setup with `store: null`
- failed connect or replacement attempts are explicit, not disguised as ongoing initialization
- raw handles do not auto-heal; hook behavior is orchestration that may acquire a replacement handle
- changing `reconnectKey` or calling `reconnect()` triggers a same-target replacement attempt without changing core session-bound semantics

## Loading And Error UI

With a scope, branch on `useStatus()`, `useActions()`, and `useError()` in the leaf components that render lifecycle UI.

```tsx
import { chromeTarget } from "@nexus-js/chrome";

function CounterView() {
  const count = CounterScope.useSelector((state) => state.count, {
    fallback: 0,
  });
  const actions = CounterScope.useActions();
  const status = CounterScope.useStatus();
  const error = CounterScope.useError();

  if (status.type === "initializing") {
    return <span>Loading...</span>;
  }

  if (status.type === "disconnected") {
    return <span>Disconnected: {error?.message}</span>;
  }

  if (!actions || status.type !== "ready") {
    return <span>Unavailable</span>;
  }

  return <button onClick={() => actions.increment(1)}>{count}</button>;
}
```

For direct low-level usage, branch on `status`, `store`, and `error` from `useRemoteStore()`.

```tsx
function CounterView() {
  const remote = useRemoteStore(counterStore, {
    target: chromeTarget.background(),
  });

  const count = useStoreSelector(remote, (state) => state.count, {
    fallback: 0,
  });

  if (remote.status.type === "initializing") {
    return <span>Loading...</span>;
  }

  if (remote.status.type === "disconnected") {
    return <span>Disconnected: {remote.error?.message}</span>;
  }

  if (!remote.store || remote.status.type !== "ready") {
    return <span>Unavailable</span>;
  }

  return (
    <button onClick={() => remote.store.actions.increment(1)}>{count}</button>
  );
}
```

## `useStoreSelector()`

Nexus State selector hook on top of `useSyncExternalStore`.

```tsx
import { chromeTarget } from "@nexus-js/chrome";

function CounterValue() {
  const remote = useRemoteStore(counterStore, {
    target: chromeTarget.background(),
  });
  const count = useStoreSelector(remote, (state) => state.count, {
    fallback: 0,
  });

  return <span>{count}</span>;
}
```

When using a remote store scope, prefer `CounterScope.useSelector(...)`; it delegates to this hook with the shared remote result from context.

### Fallback semantics

- fallback is used before a usable store exists
- after a store has been ready, temporary replacement setup for the same target may preserve the last selected value
- if a same-target replacement attempt fails, the selector may still preserve that last ready value while `status` is `disconnected` and `error` explains the failed attempt; the value does not make a handle usable or indicate successful replacement
- a target change is a stale handoff: selectors use their fallback until the new target is ready, rather than presenting the old target's value as the new target's value

## What To Do When A Handle Becomes `disconnected` Or `stale`

Treat those as explicit Nexus State lifecycle signals.

- `disconnected` usually means the current connection is gone or a new connection attempt failed
- `stale` means the old handle no longer matches the target semantics you asked for

In practice, React code usually responds by rendering fallback UI and letting `useRemoteStore()` create a replacement handle path when inputs change.

This is higher-layer rebuild behavior. It should not be interpreted as raw handle auto-healing: old terminal handles remain terminal.

For same-target session loss, do not assume automatic retry or rebuild from the hook alone. A remount, changed hook input, changed `reconnectKey`, or `reconnect()` triggers a replacement acquisition attempt; target availability and success remain separate outcomes.

### Same-target session loss pattern (explicit reacquire)

If your app must stay on the same target (for example `chromeTarget.background()`) after a restart/session-loss event, reacquire by changing the external `reconnectKey` revision or calling `reconnect()` from an interaction.

```tsx
import { useEffect, useState } from "react";
import { chromeTarget } from "@nexus-js/chrome";

// Application- or adapter-owned subscription, not a Nexus export.
declare function observeBackgroundSession(
  onSessionChange: () => void,
): () => void;

function CounterBoundary() {
  const [sessionEpoch, setSessionEpoch] = useState(0);

  useEffect(() => {
    return observeBackgroundSession(() => {
      setSessionEpoch((value) => value + 1);
    });
  }, []);

  return <CounterRemote reconnectKey={sessionEpoch} />;
}

function CounterRemote({ reconnectKey }: { reconnectKey: number }) {
  const remote = useRemoteStore(counterStore, {
    target: chromeTarget.background(),
    reconnectKey,
  });

  const count = useStoreSelector(remote, (state) => state.count, {
    fallback: 0,
  });

  if (remote.status.type === "disconnected" || remote.status.type === "stale") {
    return (
      <div>
        <p>Session lost. Reconnect to rebuild store handle.</p>
        <button onClick={remote.reconnect}>Reconnect</button>
      </div>
    );
  }

  if (!remote.store || remote.status.type !== "ready") {
    return <span>Loading...</span>;
  }

  return (
    <button onClick={() => remote.store.actions.increment(1)}>{count}</button>
  );
}
```

This preserves the raw core rule: an old handle is terminal, while React provides an explicit path to request a replacement acquisition attempt.

## Example

```tsx
import { chromeTarget } from "@nexus-js/chrome";

const CounterScope = createRemoteStoreScope(counterStore);

function Counter() {
  return (
    <CounterScope.Provider options={{ target: chromeTarget.background() }}>
      <CounterButton />
    </CounterScope.Provider>
  );
}

function CounterButton() {
  const count = CounterScope.useSelector((state) => state.count, {
    fallback: 0,
  });
  const actions = CounterScope.useActions();
  const status = CounterScope.useStatus();

  if (!actions || status.type !== "ready") {
    return <span>Loading...</span>;
  }

  return <button onClick={() => actions.increment(1)}>{count}</button>;
}
```

### Scope reconnect from a child

Use the same scope-owned command when a child renders a recovery control:

```tsx
function CounterReconnectButton() {
  const { reconnect } = CounterScope.useRemoteStore();
  return <button onClick={reconnect}>Reconnect</button>;
}
```

## What This Package Does Not Do

- It does not create a second state runtime.
- It does not expose Jotai integration yet.
- It does not hide remote lifecycle semantics.

Its job is to make the Nexus State headless runtime usable in React, not to redefine it.
