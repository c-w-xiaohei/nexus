# Nexus State React Guide

This Nexus State guide covers `@nexus-js/react`.

## Public Surface

```ts
import {
  createRemoteStoreScope,
  NexusProvider,
  useNexus,
  useNexusService,
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
const nexus = useNexus();
```

It fails fast outside `NexusProvider` on purpose.

## `useNexusService()`

React helper for one-shot Nexus service calls. It reads the injected Nexus instance and creates a fresh session-bound proxy for each call, which keeps service usage aligned with the core `nexus.create(Token, options?)` lifecycle.

```tsx
const greeting = useNexusService(GreetingServiceToken, {
  target: { descriptor: { context: "background" } },
});

async function greetAda() {
  return await greeting.call((service) => service.greet("Ada"));
}
```

Safe-style usage returns a `ResultAsync` and does not invoke the callback when proxy creation fails.

```tsx
const result = await greeting.safeCall((service) => service.greet("Ada"));

if (result.isErr()) {
  return <span>{result.error.message}</span>;
}

return <span>{result.value}</span>;
```

The hook deliberately does not cache service proxies, track pending state, retry, or apply app-specific error policy. Render loading and error UI in your component, and use `create()` or `safeCreate()` directly when you need to compose proxy creation yourself.

## `createRemoteStoreScope()`

Recommended React pattern for shared remote stores. Declare the store connection once near the subtree that needs it, then consume selector, actions, status, or the raw remote result from children.

```tsx
import { createRemoteStoreScope } from "@nexus-js/react";
import { counterStore } from "./counter-store";

const CounterScope = createRemoteStoreScope(counterStore);

function CounterPanel() {
  return (
    <CounterScope.Provider
      options={{ target: { descriptor: { context: "background" } } }}
    >
      <CounterButton />
      <CounterStatus />
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

The scope does not add a registry, retry manager, replay policy, or action fallback. `useActions()` returns `null` until the underlying remote store exists, so callers keep explicit control over disabled UI, recovery, and replay decisions.

## `useRemoteStore()`

Low-level hook for connecting directly to a remote Nexus State store. Use it when one component owns the connection lifecycle or when you need direct composition around the raw remote result. For shared subtree usage, prefer `createRemoteStoreScope()` so leaf components do not each start their own store connection.

```tsx
const remote = useRemoteStore(counterStore, {
  target: { descriptor: { context: "background" } },
});
```

Pass `reconnectKey` when the same target should be explicitly reacquired, for example after your app observes a background restart or session replacement. The key is React-only orchestration state; it is not forwarded to the core store connector.

Changing `reconnectKey` only asks the React hook to acquire a new remote store handle for the same definition and connector options. It does not replay store actions, revive old handles, or retry failed business actions.

```tsx
const remote = useRemoteStore(counterStore, {
  target: { descriptor: { context: "background" } },
  reconnectKey: sessionEpoch,
});
```

Return shape:

```ts
type UseRemoteStoreResult<TState, TActions> = {
  store: RemoteStore<TState, TActions> | null;
  status: RemoteStoreStatus;
  error: Error | null;
};
```

### Important semantics

- before first ready: `store` may be `null`
- on target replacement: the old handle becomes stale internally, while the hook result moves back through replacement setup with `store: null`
- failed connect or replacement attempts are explicit, not disguised as ongoing initialization
- raw handles do not auto-heal; hook behavior is orchestration that may acquire a replacement handle
- changing `reconnectKey` rebuilds the handle for the same target without changing core session-bound semantics

## Loading And Error UI

With a scope, branch on `useStatus()`, `useActions()`, and `useError()` in the leaf components that render lifecycle UI.

```tsx
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
    target: { descriptor: { context: "background" } },
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
const count = useStoreSelector(remote, (state) => state.count, {
  fallback: 0,
});
```

When using a remote store scope, prefer `CounterScope.useSelector(...)`; it delegates to this hook with the shared remote result from context.

### Fallback semantics

- fallback is used before a usable store exists
- after a store has been ready, temporary replacement setup for the same target may preserve the last selected value
- cross-target replacement does not silently reuse the old target's value as if it were the new one

## What To Do When A Handle Becomes `disconnected` Or `stale`

Treat those as explicit Nexus State lifecycle signals.

- `disconnected` usually means the current connection is gone or a new connection attempt failed
- `stale` means the old handle no longer matches the target semantics you asked for

In practice, React code usually responds by rendering fallback UI and letting `useRemoteStore()` create a replacement handle path when inputs change.

This is higher-layer rebuild behavior. It should not be interpreted as raw handle auto-healing: old terminal handles remain terminal.

For same-target session loss, do not assume guaranteed automatic retry/rebuild from the hook alone. Reacquisition is guaranteed only when the consumer remounts, hook inputs change, or your app explicitly changes `reconnectKey`.

### Same-target session loss pattern (explicit reacquire)

If your app must stay on the same target (for example `{ context: "background" }`) after a restart/session-loss event, reacquire by changing `reconnectKey` and letting the hook create a new handle.

```tsx
function CounterBoundary() {
  const [sessionEpoch, setSessionEpoch] = useState(0);

  return (
    <CounterRemote
      reconnectKey={sessionEpoch}
      onReconnect={() => setSessionEpoch((value) => value + 1)}
    />
  );
}

function CounterRemote({
  reconnectKey,
  onReconnect,
}: {
  reconnectKey: number;
  onReconnect(): void;
}) {
  const remote = useRemoteStore(counterStore, {
    target: { descriptor: { context: "background" } },
    reconnectKey,
  });

  const count = useStoreSelector(remote, (state) => state.count, {
    fallback: 0,
  });

  if (remote.status.type === "disconnected" || remote.status.type === "stale") {
    return (
      <div>
        <p>Session lost. Reconnect to rebuild store handle.</p>
        <button onClick={onReconnect}>Reconnect</button>
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

This preserves the raw core rule (old handle is terminal) while giving React a concrete orchestration path for same-target rebuilds.

## Example

```tsx
const CounterScope = createRemoteStoreScope(counterStore);

function Counter() {
  return (
    <CounterScope.Provider
      options={{ target: { descriptor: { context: "background" } } }}
    >
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

## What This Package Does Not Do

- It does not create a second state runtime.
- It does not expose Jotai integration yet.
- It does not hide remote lifecycle semantics.

Its job is to make the Nexus State headless runtime usable in React, not to redefine it.
