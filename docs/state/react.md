# Nexus State React Guide

This page covers the Nexus State bindings in `@nexus-js/react`. For Nexus
providers, typed React scopes, and service proxy status, see [React](../react.md).

## Public Surface

```ts
import {
  createRemoteStoreScope,
  useRemoteStore,
  useStore,
  type RemoteStoreWithInitialState,
} from "@nexus-js/react";
```

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
```

`useSelector(selector, { fallback })` returns the explicit fallback whenever
the current scoped RemoteStore handle is `null`, including before acquisition,
during replacement, and after a failed attempt. It does not retain selected
values from an old handle. `useRemoteStore`, `useActions`, `useStatus`, and
`useError` share the Provider's single result.

Each different Store needs its own RemoteStore handle. Consumers of the same
Store should share a scope rather than each calling `useRemoteStore()`.

## Direct Handle Selection

`useRemoteStore(definition, options)` owns async IPC acquisition, status,
replacement, latest-wins behavior, and cleanup. Use it when one component owns
that lifecycle or needs the complete `UseRemoteStoreResult`.

`useStore(store, selector?)` is the direct Store selection hook, shaped like
Zustand. It accepts only a concrete structural Store with `getState`,
`getInitialState`, and `subscribe`. With no selector it returns whole state;
with a selector it returns the selected value. It has no fallback, status,
error, target, reconnect, replacement, equality, or cache options.

`useStore` is an optional Core 1.1 capability. `@nexus-js/react` keeps its
`@nexus-js/core >=1.0.0` peer range because existing owner and scope APIs work
with Core 1.0. Calling `useStore` with a Core 1.0 handle throws
`useStore requires Core >=1.1.0` on both client and server rendering.

Render a child only after a concrete RemoteStore handle exists so Hooks remain
unconditional in each component.

```tsx
function CounterRemote() {
  const remote = useRemoteStore(counterStore, {
    target: chromeTarget.background(),
  });

  if (!remote.store || remote.status.type !== "ready") {
    return <span>{remote.status.type}</span>;
  }

  return <CounterValue store={remote.store} />;
}

function CounterValue({
  store,
}: {
  store: RemoteStoreWithInitialState<CounterState, CounterActions>;
}) {
  const count = useStore(store, (state) => state.count);
  return <button onClick={() => store.actions.increment(1)}>{count}</button>;
}
```

## Lifecycle Controls

Change `reconnectKey` when application code knows the same target has a new
connection session. Call `remote.reconnect()` from an event handler, callback,
or timer to request replacement. Both create a new RemoteStore handle using the
latest inputs; neither revives a terminal handle, replays actions, nor
guarantees availability. Overlapping attempts are latest-wins.

```tsx
function ReconnectButton() {
  const { reconnect } = CounterScope.useRemoteStore();
  return <button onClick={reconnect}>Reconnect</button>;
}
```

`RemoteStore` handles are session-bound. Treat `disconnected` and `stale` as
explicit lifecycle signals, render availability UI from `status` and `error`,
and acquire a replacement through the owner hook or scope Provider.
