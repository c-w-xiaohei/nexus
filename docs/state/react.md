# Nexus State React Guide

This page covers the Nexus State bindings in `@nexus-js/react`. For Nexus
providers, typed React scopes, and service proxy status, see [React](../react.md).

## Public Surface

```ts
import {
  createRemoteStoreScope,
  NexusProvider,
  useRemoteStore,
  useStoreStatus,
} from "@nexus-js/react";
import type { RemoteStore } from "@nexus-js/core/state";
import { useStore } from "zustand";
```

The examples reuse `counterStore`, `CounterState`, and `CounterActions` from
shared contract code, plus an already configured `nexus` instance.

## Shared Subtree Ownership

Use `createRemoteStoreScope()` when several components consume one Store. One
Provider owns one side-effectful RemoteStore handle and remote subscription for
its subtree. Consumers use the scope hooks and never acquire another handle.

```tsx
const CounterScope = createRemoteStoreScope(counterStore);

function CounterPanel() {
  return (
    <NexusProvider nexus={nexus}>
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
  return (
    <button disabled={!actions} onClick={() => actions?.increment(1)}>
      {count}
    </button>
  );
}

function CounterStatus() {
  const { pending, error } = CounterScope.useRemoteStore();
  const phase = CounterScope.useStatus((status) => status.type);
  return <span>{pending ? "connecting" : (error?.message ?? phase)}</span>;
}
```

`useSelector(selector, { fallback })` returns the explicit fallback whenever
the current scoped RemoteStore handle is `null`, including before acquisition,
during replacement, and after a failed attempt. It does not retain selected
values from an old handle. `useRemoteStore`, `useActions`, and `useError` read
the Provider's acquisition result. `useStatus(selector?)` independently observes
the current handle's lifecycle and returns `null` without a handle or during SSR.

The Provider's context value stays stable across remote snapshots and lifecycle
notifications. Only data/status consumers whose selected values change rerender
because of those notifications. Select `status.type` for phase-only UI; observing
the complete status also observes its version, which advances with snapshots.

Each different Store needs its own RemoteStore handle. Consumers of the same
Store should share a scope rather than each calling `useRemoteStore()`.

## Direct Handle Selection

`useRemoteStore(definition, options)` owns async IPC acquisition, replacement,
latest-wins behavior, and cleanup. It returns `{ store, pending, error, reconnect }`
and does not subscribe to data or lifecycle updates. While acquiring, `pending`
is true and `store`/`error` are null. An attempt finishes with either a store or
an acquisition error. A later disconnect does not change this acquisition result.

Use Zustand's `useStore(store, selector?)` directly for a concrete local or remote
Store. Nexus does not export its own `useStore` or selector cache. Add `zustand`
to your application's dependencies when importing it.

Both direct selection and the scope's `useSelector` follow Zustand 5 snapshot
stability rules. Select existing state references or primitives; use `useShallow`
from `zustand/react/shallow` when a selector constructs an object or array whose
shallow-equal output should remain stable. Structural stores must return stable
state references between updates, not clone state on every read.

The current React bindings require Core ~1.2.0 and the callback-based State
contract. Upgrade both packages and all State endpoints together. Acquired
`RemoteStore` handles include `getInitialState`, `getStatus`, and `subscribeStatus`.
Use `useStoreStatus(store, selector?)` for explicit lifecycle observation, not
status polling. Host stores are ordinary
Zustand stores bound with `createNexusStore(...)` or `bindNexusStore(...)`; no
`withNexusState` middleware is shipped.

Render a child only after a concrete RemoteStore handle exists so Hooks remain
unconditional in each component.

```tsx
function CounterRemote() {
  const remote = useRemoteStore(counterStore, {
    target: chromeTarget.background(),
  });

  if (!remote.store) {
    return <span>{remote.pending ? "connecting" : remote.error.message}</span>;
  }

  return <CounterValue store={remote.store} />;
}

function CounterValue({
  store,
}: {
  store: RemoteStore<CounterState, CounterActions>;
}) {
  const count = useStore(store, (state) => state.count);
  const phase = useStoreStatus(store, (status) => status.type);
  if (phase !== "ready") return <span>{phase}</span>;
  return <button onClick={() => store.actions.increment(1)}>{count}</button>;
}
```

`useStoreStatus` only observes; it never acquires or destroys a handle. It returns
`null` without a handle and during SSR, then reads the current status on the
client. Its selector follows the same stable-output rule as data selectors.

## Lifecycle Controls

Change `reconnectKey` when application code knows the same target has a new
connection session. Call `remote.reconnect()` from an event handler, callback,
or timer to request replacement. Both create a new RemoteStore handle using the
latest inputs; neither revives a terminal handle, replays actions, nor
guarantees availability. Overlapping attempts are latest-wins.

Changing the target value, definition, Nexus instance, or timeout also starts a
new attempt. A new inline `where` function alone does not reconnect; the next
attempt uses the current predicate. Keep shared definitions outside render.

Replacement immediately hides the previous handle and shows selector fallback.
Effect cleanup destroys that handle without waiting for the next attempt to
finish. Handles returned by an obsolete or unmounted request are destroyed too.
React does not retain an old handle in `stale` while waiting for replacement.

```tsx
function ReconnectButton() {
  const { reconnect } = CounterScope.useRemoteStore();
  return <button onClick={reconnect}>Reconnect</button>;
}
```

`RemoteStore` handles are session-bound. Observe `disconnected`, `stale`, and
`destroyed` through `useStoreStatus` or the scope's `useStatus`, and acquire a
replacement through the owner hook or scope Provider. `remote.error` and
`Scope.useError()` report acquisition failures, not a later transport loss or
action failure. Core can still mark a handle `stale` when its selected remote
identity no longer matches; React prop changes instead dispose the old handle.
