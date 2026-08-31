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

Because a `RemoteStore` handle is tied to one target and connection session.

Auto-rebinding would hide lifecycle changes and make state behavior much harder to reason about.

This follows the Core lifecycle rules. See
[Service Proxy Lifecycle](../proxy-lifecycle.md) for service proxies and
[Core concepts](../concepts.md#session-bound-handles) for remote resources.

## Why does React sometimes keep the last selected value?

It can avoid a loading state while creating a replacement for the same target.
See the [Nexus State React guide](react.md#fallback-semantics) for failure and
target-change behavior.

## Does `useRemoteStore()` automatically rebuild when a connection session ends?

No. The hook only creates a replacement after an input changes or the
application requests one. See the [Nexus State React guide](react.md) for the
exact behavior.

## Does a remote store scope support both reconnect controls?

Yes. The scope provider accepts `reconnectKey`, and its children share the same
`reconnect()` function. See the [Nexus State React guide](react.md).

## Does Nexus State v1 support patches?

Not as a public protocol.

Nexus State v1 is snapshot-first.

## Does Nexus State v1 include Jotai?

No. `@nexus-js/react` does not provide Jotai integration.
