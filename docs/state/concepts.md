# Nexus State Concepts

This Nexus State guide explains the mental model behind synchronized remote state.

## Remote Store, Not Fake Local Store

Nexus State is not pretending that remote state is local memory.

Instead, Nexus State gives you a model with explicit rules:

- the host owns the authoritative state
- the client owns a mirrored local snapshot
- reads are synchronous from the mirror
- writes execute remotely on the host
- updates arrive through subscription events

That is why `getState()` is sync on the client, while actions are async.

## Host And Client

There are always two sides in Nexus State.

### Host

The host:

- owns the real store state
- executes actions
- advances versions
- publishes snapshot updates to subscribed clients
- cleans up connection-owned subscriptions on disconnect

### Client

The client:

- connects through ordinary Nexus targeting
- receives an atomic subscribe baseline
- receives an initial snapshot and a live subscription in one setup step
- maintains a local mirror
- exposes `getState()` and `subscribe()` like a local store
- turns connection loss into explicit lifecycle status

## One Concrete Flow

The smallest useful Nexus State end-to-end flow is:

1. define a store contract
2. host it in one Nexus context
3. connect to it from another context
4. receive an initial snapshot and create a local mirror
5. read from the mirror synchronously with `getState()`
6. call actions asynchronously on the host
7. receive later snapshots through subscription updates

## Why Not Just Proxy A Store Object?

Because a raw remote object proxy gives the wrong mental model.

If you proxy a store directly, users naturally assume:

- reads are local
- writes are immediate
- lifecycle is invisible

None of those are true across contexts.

Nexus State makes the remote nature explicit without forcing you to hand-write subscription and action protocol boilerplate each time.

## Status Model

`RemoteStore` in Nexus State has explicit lifecycle states.

- `initializing` - connect/subscribe handshake is in progress
- `ready` - mirror is active and receiving updates
- `disconnected` - the backing connection is gone or connect/reconnect failed
- `stale` - the handle is no longer valid for the target semantics you requested
- `destroyed` - the handle is intentionally closed and unusable

The important point is that `disconnected` and `stale` are not silent. They are observable states.

## Headless Core vs Hook-Level Lifecycle

Keep these two layers separate:

- headless core (`connectNexusStore` / `RemoteStore`)
- React ownership (`useRemoteStore` and scoped selection), with direct selection through Zustand's `useStore`

Headless core behavior:

- initial connect failure means `connectNexusStore(...)` rejects (or safe API returns `Err`)
- no `RemoteStore` instance exists from that failed attempt
- once a `RemoteStore` reaches a terminal state (`disconnected`, `stale`, `destroyed`), replacement means creating a new instance

Hook-level behavior:

- the owner hook exposes `pending`, `store`, and acquisition `error`; lifecycle status is observed separately with `useStoreStatus` or `Scope.useStatus`
- hooks may create a replacement `RemoteStore` handle, but they do not make a terminal handle usable again

See the [Nexus State React guide](react.md) for `reconnectKey`, `reconnect()`,
selector fallback, and target changes.

## Stale vs Disconnected

These are different failures in Nexus State.

### `disconnected`

Use this when an acquired handle's underlying transport/connection is gone.
An acquisition failure returns an error without a handle.

### `stale`

Use this when the handle itself no longer matches the target you meant to talk to.

Typical example:

- you acquire a handle with a `where` predicate
- the remote identity changes and no longer matches that predicate
- your old remote store becomes stale, not magically rebound

Changing React target props instead destroys the previous handle and starts
a new acquisition; the owner does not retain a stale handle during replacement.

## Full Snapshots

Nexus State synchronizes full snapshots, not public patch streams.

That means:

- simpler semantics
- easier validation
- stronger correctness story
- fewer protocol edge cases

The implementation keeps room for future patch-like optimization, but the public model is snapshot-based today.

## Why Actions Wait For Publication

When you call:

```ts
await remoteStore.actions.increment(1);
```

the promise waits for the caller's ordinary Core function call and its fixed
publication-window acknowledgement. It is not a receipt or waiter protocol.
The action may already have mutated the host if the call later fails; do not
automatically retry non-idempotent actions.

After a successful await, the caller's mirror has acknowledged the targeted
snapshot, but later host updates may already have been published or may still
be pending. Snapshots are complete projections, may skip intermediate
versions, and the client ignores older versions.

This is one of the most important semantics in the system.

## What Does Not Happen Automatically

Nexus State `RemoteStore` instances do not silently recover forever.

If a handle becomes:

- `disconnected`
- `stale`
- `destroyed`

that instance is terminal.

Recovery means creating a new handle, not reviving the old one in place.

This follows the Core lifecycle rules:

- a service proxy is tied to one connection session
- a remote resource is tied to the connection that created it

State or React code can create a replacement `RemoteStore` handle, but it does
not make a terminal handle usable again.
