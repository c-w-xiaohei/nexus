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
- broadcasts snapshot updates
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

Nexus State makes the remote nature explicit without forcing you to hand-write subscribe/dispatch protocol boilerplate each time.

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
- React hook orchestration (`useRemoteStore` and selector hooks)

Headless core behavior:

- initial connect failure means `connectNexusStore(...)` rejects (or safe API returns `Err`)
- no `RemoteStore` instance exists from that failed attempt
- once a `RemoteStore` reaches a terminal state (`disconnected`, `stale`, `destroyed`), replacement means creating a new instance

Hook-level behavior:

- hooks expose UI-oriented lifecycle (`status`, `store`, `error`) during initial load and replacement
- hook code can keep rendering continuity while replacement is in progress
- same-target session loss does not imply guaranteed automatic retry/rebuild unless the app remounts, changes hook inputs, or explicitly orchestrates reconnect
- this is higher-layer orchestration, not in-place healing of a terminal raw handle

## Stale vs Disconnected

These are different failures in Nexus State.

### `disconnected`

Use this when the underlying transport/connection is gone, or a new connection attempt fails.

### `stale`

Use this when the handle itself no longer matches the target you meant to talk to.

Typical example:

- you connect to "the active tab"
- the active tab changes
- your old remote store is now stale, not magically rebound

## Snapshot-Only v1

Nexus State v1 synchronizes full snapshots, not public patch streams.

That means:

- simpler semantics
- easier validation
- stronger correctness story
- fewer protocol edge cases

The implementation keeps room for future patch-like optimization, but the public model is snapshot-based today.

## Why Actions Wait For Observed Commit

When you call:

```ts
await remoteStore.actions.increment(1);
```

the promise does not resolve just because the host said "I handled it".

It resolves after the client mirror has observed the committed version.

That gives you a stronger guarantee:

- after the `await`, `getState()` is already consistent with that action's committed update

This is one of the most important semantics in the system.

## What Does Not Happen Automatically

Nexus State `RemoteStore` instances do not silently recover forever.

If a handle becomes:

- `disconnected`
- `stale`
- `destroyed`

that instance is terminal.

Recovery means creating a new handle, not reviving the old one in place.

This lines up with core semantics:

- raw `nexus.create()` proxies are session-bound
- `nexus.ref()` capabilities are connection-bound transient resources

Higher-level state or React orchestration can trigger rebuild flows, but those flows create replacement handles rather than healing terminal ones.
