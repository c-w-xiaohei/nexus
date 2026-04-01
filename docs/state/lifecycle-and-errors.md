# Nexus State Lifecycle And Errors

This Nexus State guide explains the most important runtime semantics.

## Status States

Nexus State `RemoteStoreStatus` is a discriminated union.

Main states:

- `initializing`
- `ready`
- `disconnected`
- `stale`
- `destroyed`

## `ready`

The store has:

- completed the subscribe handshake
- initialized the local mirror
- begun normal update processing

## `disconnected`

Use this when:

- the backing connection closes
- a new connection attempt fails
- an operation cannot continue because the transport is gone

The public disconnected status carries:

- `lastKnownVersion`
- optional `cause`

## `stale`

Use this when the handle itself is no longer the right handle.

Typical causes:

- target change in the React adapter
- store instance mismatch that is surfaced through the same public stale shape

Stale is not the same thing as disconnected.

## `destroyed`

The caller intentionally ended the handle's lifecycle.

After this:

- no more updates should be processed
- actions should fail
- local subscriptions should be cleaned up

## Action Semantics

This is one of the core Nexus State guarantees:

```ts
await remote.actions.increment(1);
```

resolves after the local mirror has observed the committed version.

That means this is safe:

```ts
await remote.actions.increment(1);
console.log(remote.getState());
```

## Disconnect During In-Flight Action

If the connection dies during an action, Nexus State does not pretend everything is fine.

The caller gets an explicit disconnect-oriented failure rather than silent ambiguity.

## Cleanup Semantics

Cleanup happens in more than one place:

- local listeners are cleaned up on `destroy()`
- terminal client states do best-effort `unsubscribe()`
- host-side disconnect cleanup removes connection-owned subscriptions
- final multi-context integration test verifies host-side cleanup behavior

## Replacement vs Recovery

These are different ideas:

- replacement: a new handle is created for a new attempt or new target input
- recovery: an old terminal handle becomes usable again

Nexus State supports replacement.

It does not treat a terminal `RemoteStore` instance as something that silently recovers in place.

## Error Types

Use these Nexus State errors to distinguish failure classes:

- `NexusStoreConnectError`
- `NexusStoreDisconnectedError`
- `NexusStoreActionError`
- `NexusStoreProtocolError`

Rule of thumb:

- connect/setup problem -> `NexusStoreConnectError`
- backing connection lost -> `NexusStoreDisconnectedError`
- remote action failed -> `NexusStoreActionError`
- malformed protocol payload/order issue -> `NexusStoreProtocolError`
