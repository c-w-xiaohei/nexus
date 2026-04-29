# Nexus State React Guide

This Nexus State guide covers `@nexus-js/react`.

## Public Surface

```ts
import {
  NexusProvider,
  useNexus,
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

## `useRemoteStore()`

Main hook for connecting to a remote Nexus State store.

```tsx
const remote = useRemoteStore(counterStore, {
  target: { descriptor: { context: "background" } },
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

## Loading And Error UI

The simplest pattern is to branch on `status`, `store`, and `error` directly.

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

For same-target session loss, do not assume guaranteed automatic retry/rebuild from the hook alone. Reacquisition is guaranteed only when the consumer remounts, hook inputs change, or your app explicitly orchestrates a rebuild trigger.

### Same-target session loss pattern (explicit reacquire)

If your app must stay on the same target (for example `{ context: "background" }`) after a restart/session-loss event, reacquire by remounting the `useRemoteStore()` consumer and letting the hook create a new handle.

```tsx
function CounterBoundary() {
  const [sessionEpoch, setSessionEpoch] = useState(0);

  return (
    <CounterRemote
      key={`background-${sessionEpoch}`}
      onReconnect={() => setSessionEpoch((value) => value + 1)}
    />
  );
}

function CounterRemote({ onReconnect }: { onReconnect(): void }) {
  const remote = useRemoteStore(counterStore, {
    target: { descriptor: { context: "background" } },
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
function Counter() {
  const remote = useRemoteStore(counterStore, {
    target: { descriptor: { context: "background" } },
  });

  const count = useStoreSelector(remote, (state) => state.count, {
    fallback: 0,
  });

  if (!remote.store || remote.status.type !== "ready") {
    return <span>Loading...</span>;
  }

  return (
    <button onClick={() => remote.store.actions.increment(1)}>{count}</button>
  );
}
```

## What This Package Does Not Do

- It does not create a second state runtime.
- It does not expose Jotai integration yet.
- It does not hide remote lifecycle semantics.

Its job is to make the Nexus State headless runtime usable in React, not to redefine it.
