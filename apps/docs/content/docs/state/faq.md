---
title: Nexus State FAQ
description: Answers to common questions about synchronized remote state.
---

## Why not just use Zustand directly across contexts?

Because Zustand solves local state management, not cross-context transport, lifecycle, disconnect semantics, or subscription ownership cleanup.

Nexus State can use `zustand/vanilla` internally, but the cross-context protocol and lifecycle semantics still have to come from Nexus.

## Why is `getState()` sync if the real state is remote?

Because it reads from the local mirror, not from the remote host directly.

That gives you local-store ergonomics while keeping the remote nature explicit in writes and lifecycle.

## Why are actions async?

Because they execute on the host.

Also, `await action()` waits for the caller's targeted snapshot acknowledgement,
not just the remote function result. It is not a transactional commit receipt;
the action may already have mutated the host if synchronization fails. See
[Lifecycle and errors](/nexus/docs/state/lifecycle-and-errors/) for the full
action and disconnect rules.

## Why does a target change create stale handles instead of auto-rebinding?

Because a `RemoteStore` handle is tied to one target and connection session.
Auto-rebinding would hide lifecycle changes. See [Lifecycle and
errors](/nexus/docs/state/lifecycle-and-errors/) for the State rules, and
[Core concepts](/nexus/docs/concepts/#session-bound-handles) for related Core
handles.

## What does scope selector fallback mean?

`RemoteStoreScope.useSelector()` returns its explicit fallback whenever the
scope has no current RemoteStore handle. It never retains a previous handle's
selected value during replacement or failure.

## Does `useRemoteStore()` automatically rebuild when a connection session ends?

No. Replacement requires an input change or an explicit application request.
See the [Nexus State React guide](/nexus/docs/state/react/) for the exact
behavior.

## Does a remote store scope support both reconnect controls?

Yes. The scope provider accepts `reconnectKey`, and its children share the same
`reconnect()` function. See the [Nexus State React guide](/nexus/docs/state/react/).

## Does Nexus State v1 support patches?

Not as a public protocol.

Nexus State v1 is snapshot-first.

## Does State use a transaction, draft, or rollback queue?

No. The source is a normal Zustand store. Actions are not serialized or
automatically rolled back, and State does not ship a draft/rollback/queue
protocol or `withNexusState` middleware.

## Does Nexus State v1 include Jotai?

No. `@nexus-js/react` does not provide Jotai integration.
