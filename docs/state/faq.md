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

For a same-target replacement, keeping the last ready selected value can avoid unnecessary loading flicker while the replacement is pending or after that attempt fails.

After a failed same-target attempt, `status: "disconnected"` and `error` still mean there is no ready replacement; the retained value does not make a handle usable or indicate success. It does not apply to a target change. A target change is a stale handoff: selectors immediately return their configured fallback until the new target is ready, so old target data cannot appear as the new target's value.

## Does `useRemoteStore()` automatically rebuild after session loss?

No.

`useRemoteStore()` is a higher-layer orchestration API over terminal raw-handle semantics. Change `reconnectKey` for an external committed session/lifecycle revision or call its stable `reconnect()` command to trigger a replacement acquisition attempt. This does not revive the old handle, replay actions, guarantee target availability, or add automatic retry/backoff behavior.

## Does a remote store scope support both reconnect controls?

Yes. `createRemoteStoreScope(definition)` accepts `reconnectKey` through `Provider` options, and `Scope.useRemoteStore().reconnect()` exposes the provider's shared stable command to every child. The provider owns one shared acquisition for the scope.

## Does Nexus State v1 support patches?

Not as a public protocol.

Nexus State v1 is snapshot-first.

## Does Nexus State v1 include Jotai?

No. The design leaves room for it, but the implemented public package is focused on the core runtime and the React adapter first.
