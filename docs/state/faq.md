# Nexus State FAQ

## Why not just use Zustand directly across contexts?

Because Zustand solves local state management, not cross-context transport, lifecycle, disconnect semantics, or subscription ownership cleanup.

Nexus State can use `zustand/vanilla` internally, but the cross-context protocol and lifecycle semantics still have to come from Nexus.

## Why is `getState()` sync if the real state is remote?

Because it reads from the local mirror, not from the remote host directly.

That gives you local-store ergonomics while keeping the remote nature explicit in writes and lifecycle.

## Why are actions async?

Because they execute on the host.

Also, `await action()` gives you a stronger guarantee than "remote call returned": the local mirror has observed the committed version.

## Why does a target change create stale handles instead of auto-rebinding?

Because Nexus handles are intentionally explicit and connection-bound.

Auto-rebinding would hide lifecycle changes and make state behavior much harder to reason about.

## Do raw Nexus proxies automatically heal after session replacement?

No.

Raw `nexus.create()` unicast proxies are session-bound handles. If the remote session is replaced, create a new proxy for that new session.

Higher-layer code can automate a rebuild flow, but the old raw proxy is not silently revived in place.

## Are `nexus.ref()` resources durable across reconnects?

No.

`nexus.ref()` capabilities are connection-bound transient resources. When the connection is replaced or closed, reacquire those capabilities on the new connection.

Treat refs as lifecycle-scoped ownership handles, not global durable identities.

## Why does React sometimes keep the last selected value?

Because keeping continuity during replacement or a failed new connection attempt can be more useful than falling back immediately.

But this does not mean old target data is silently reused for a new target. Cross-target replacement is handled differently.

## Does `useRemoteStore()` guarantee same-target auto-rebuild after session loss?

No.

`useRemoteStore()` is a higher-layer orchestration API over terminal raw-handle semantics. Same-target session loss does not guarantee automatic retry/rebuild unless your app remounts the consumer, changes hook inputs, or explicitly triggers a reconnect flow.

## Does Nexus State v1 support patches?

Not as a public protocol.

Nexus State v1 is snapshot-first.

## Does Nexus State v1 include Jotai?

No. The design leaves room for it, but the implemented public package is focused on the core runtime and the React adapter first.
