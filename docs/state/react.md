# Nexus State React Guide

This page covers the Nexus State-specific bindings in `@nexus-js/react`. For
providing a Nexus instance, typed React scopes, and service proxy status,
see the [general React integration guide](../react.md).

## Public Surface

```ts
import {
  createRemoteStoreScope,
  useRemoteStore,
  useStoreSelector,
} from "@nexus-js/react";
```

## `createRemoteStoreScope()`

Use a remote store scope when several components need the same store. Place one scope provider inside `NexusProvider` near the subtree, then read state, actions, status, errors, or the `UseRemoteStoreResult` from its children.

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

The provider manages one shared `RemoteStore` handle for its subtree. Its `options` accept `reconnectKey`, and every `CounterScope.useRemoteStore()` consumer receives the same stable `reconnect` function. The scope does not retry calls or replay actions. `useActions()` returns `null` until a `RemoteStore` handle exists, so the UI decides when actions are available.

## `useRemoteStore()`

Use this lower-level hook when one component should create and destroy its own `RemoteStore` handle, or when it needs the full `UseRemoteStoreResult`. For a shared subtree, prefer `createRemoteStoreScope()` so child components do not create separate handles.

The component must be rendered under `NexusProvider`. The direct-hook examples
below assume that provider is already present.

Change `reconnectKey` when the application learns that the same target has a new connection session, such as after a background restart. Call `remote.reconnect()` from an event handler, callback, or timer when the application should try again. Either action starts an attempt to create a new `RemoteStore` handle with the latest Nexus instance, definition, target, and options. If attempts overlap, only the newest result is used. `reconnectKey` is a React option and is not passed to the Core store API.

Neither control revives an old `RemoteStore` handle, replays an action, or guarantees that the target is available. The `reconnect` function keeps the same identity across renders. The `UseRemoteStoreResult` object may change.

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
- while creating a replacement: `store` is `null`
- failed connect or replacement attempts are explicit, not disguised as ongoing initialization
- a terminal `RemoteStore` handle does not become usable again
- changing `reconnectKey` or calling `reconnect()` starts an attempt to create a replacement for the same target

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

For direct use, branch on `status`, `store`, and `error` from the `UseRemoteStoreResult`.

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

When using a remote store scope, prefer `CounterScope.useSelector(...)`; it reads from the shared `UseRemoteStoreResult`.

### Fallback semantics

- fallback is used before a usable store exists
- after a store has been ready, temporary replacement setup for the same target may preserve the last selected value
- if a same-target replacement attempt fails, the selector may still preserve that last ready value while `status` is `disconnected` and `error` explains the failed attempt; the value does not make a handle usable or indicate successful replacement
- a target change is a stale handoff: selectors use their fallback until the new target is ready, rather than presenting the old target's value as the new target's value

## What To Do When A `RemoteStore` Handle Becomes `disconnected` Or `stale`

Treat those as explicit Nexus State lifecycle signals.

- `disconnected` usually means the current connection is gone or a new connection attempt failed
- `stale` means the `RemoteStore` handle no longer matches the requested target

React code usually renders fallback UI and lets `useRemoteStore()` create a new `RemoteStore` handle when its inputs change. The terminal handle remains terminal.

When the connection session for the same target ends, the hook does not retry automatically. A remount, changed hook input, changed `reconnectKey`, or `reconnect()` starts an attempt to create a replacement `RemoteStore` handle. The target may still be unavailable, and the attempt may fail.

### Create A Replacement For The Same Target

If the application must stay on the same target after its connection session changes, update `reconnectKey` or call `reconnect()`. The following components assume an enclosing `NexusProvider`:

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
        <p>Connection ended. Create a new RemoteStore handle.</p>
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

The old `RemoteStore` handle remains terminal. The React hook starts a separate attempt to create a replacement.

## Scope Reconnect From A Child

Use the same scope-owned command when a child renders a recovery control:

```tsx
function CounterReconnectButton() {
  const { reconnect } = CounterScope.useRemoteStore();
  return <button onClick={reconnect}>Reconnect</button>;
}
```

## Limits

- These bindings do not create a second State runtime.
- They do not provide Jotai integration.
- They do not hide `RemoteStore` status or replacement.
