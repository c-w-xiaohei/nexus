---
"@nexus-js/core": minor
"@nexus-js/testing": minor
---

Add `ResourceScope` and `Connection.createScope(token)` for independently
terminable, session-bound service regions. Pass an explicit scope with
`connection.get(token, { scope })`; closing it releases its calls and transferred
capabilities without closing the shared Connection. Nexus State now owns an
explicit scope for each Store subscription.

Export `SERVICE_INVOKE_START`, `SERVICE_INVOKE_END`,
`ServiceInvocationContext`, and `ServiceInvocationHooks` from the Core root so
providers can observe and clean up scope-owned work.

Replace the `@nexus-js/core/relay` subpath, `relayService`, and
`relayNexusStore` with static `Nexus.relay({ from, to, services })`. Relay keeps
application-selected adjacent-instance routes, isolates scopes across shared
bridge connections, and requires `resource-scope-v1` handshake support.

Breaking migration: import Relay from `@nexus-js/core`, register selected Tokens
with `Nexus.relay`, include StoreTokens directly, and upgrade every Core runtime
on a Relay path together.

Update testing connections with `createScope(token)` and scope-bound service
access so application tests can exercise independent resource lifetimes.
