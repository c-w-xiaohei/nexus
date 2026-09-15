---
"@nexus-js/core": major
"@nexus-js/iframe": minor
"@nexus-js/react": minor
"@nexus-js/chrome": minor
"@nexus-js/node-ipc": minor
---

Reject duplicate provider IDs within a single configure/provide submission before
composition; separate configuration layers continue to use last-wins semantics.
Unify bootstrap/live registration and keep provider-catalog updates separate from
connection acquisition notifications.

Keep bootstrap failures in one shared safe result and reject decorator writes once
bootstrap begins. Validate configured/decorated provider conflicts before running
constructors or factories, and pass effective endpoint metadata to factories.
Contain malformed configure/provide inputs at their safe boundaries. Consolidate
service-table commits and preserve send-failure causes across the RPC boundary.

Prepare the Core 2.0 alpha connection and resource API: connect before getting services, use per-connection collection results, and consume lazy calls explicitly.

Breaking changes: service, ref, and callback calls execute only when consumed;
multicast acquisition returns per-connection Result lists instead of aggregate
proxies, and `expects` and remote property assignment are removed. Replace
ignored calls with awaited or explicitly observed calls, combine successful
resources with native Promise helpers, and use business methods for writes.
The old `create`/`safeCreate`, `select`/`safeSelect`, and both old multicast
families are removed. Token, TokenSpace, endpoint, and adapter default targets
and provider wait configuration are removed; use explicit connection targets or
passive connection acquisition instead.
Remove their obsolete option types and targeting errors. State consumers use
Core `ConnectOptions` directly instead of `ConnectNexusStoreOptions`.
Narrow synchronous resource acquisition errors to usage, disconnected-session, and missing-service
failures. Acquisition predicates do not become per-RPC authorization checks.

Keep lazy execution and safe consumption in proxy closures, simplify payload
conversion and bootstrap wiring, and remove unused resource/state classifications.
Separate request-scoped acquisition from Nexus lifecycle ownership and build the
kernel directly without a one-shot builder object.
Use explicit internal `safeConnect`/`safeConnectMulticast` functions, let configuration and
registration own their snapshots, and remove duplicate decorator validation and
provider identity indexes.
Reject pre-aborted service requests before bootstrap, retain target diagnostics
when a multicast session closes before delivery, and preserve Date metadata in
configuration snapshots.
Share Core acquisition rules with testing: explicit multicast targets dial
concurrently, request-local aborts cannot deliver a session, and predicates do
not run after acquisition has terminated.
Stop upstream Relay subscriptions before waiting for terminal callback delivery,
while keeping the downstream callback alive until delivery settles. Preserve
allowlisted framework error diagnostics across JSON and binary transports.
Preserve session-scoped identity, authorization snapshots and rollback on errors.
Reject malformed resource placeholders, preserve `__proto__` as data, isolate
throwing disconnect hooks, and retain safe handling of hostile errors.

Property reads and method results share one lazy consumption with `safeCall` and
expose their source connection. Keep multicast resource `callTimeout` separate
from acquisition options. Remove Chrome's no-op UI listener and migrate its
examples and browser fixtures to per-connection results.

`callTimeout` is now strictly positive. `timeout` is a positive acquisition
budget, and State connection options use the same positive `timeout` and `signal`
contract. Replace a `callTimeout: 0` configuration with a positive call timeout.

Nested proxy paths reserve `then`, `catch`, `finally`, and `connection` for
lazy consumption and provenance. Root proxies reserve only `then`; root
business members named `catch`, `finally`, and `connection` remain accessible.

Remove ordinary proxy lifecycle APIs: `Nexus.getProxyStatus`,
`Nexus.subscribeProxyStatus`, `Nexus.inspectProxy`, `ProxyStatus`,
`ProxyDebugSnapshot`, and React's `useProxyStatus`. Retain the acquired
`Connection` and observe it with `onDisconnected` or `subscribeIdentity`;
`useStoreStatus` remains available for Nexus State handles.
