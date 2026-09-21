# @nexus-js/iframe

## 0.6.0-alpha.0

### Minor Changes

- faa79fa: Let public Connection handles register live listeners with session-owned events
  and own public replay behavior, removing kernel/Nexus event forwarding while preserving cleanup
  ordering. Nexus observes manager availability directly and caches handles by
  session identity. Remove unused identity payloads from owner commands.
  Share provider argument types between Nexus and its public interface, and route
  throw-style registration directly through safe registration.
  Align internal L2/L3 send contracts and consume inbound processing results at the
  Engine boundary. Share initial/live provider normalization while preserving
  public RPC errors, resource cleanup, and registration-before-announcement order.

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

### Patch Changes

- Updated dependencies [faa79fa]
  - @nexus-js/core@2.0.0-alpha.0

## 0.5.0

### Minor Changes

- 5026b21: Support optional exact `connectTo` startup targets. Defer outgoing connections
  during document loading until load completes, and cancel the wait on shutdown.

  Adapt to Core's lifecycle-owning VirtualPortRouter. Application targeting APIs
  are unchanged; this adapter requires Core ~1.2.0 rather than the previous runtime.

### Patch Changes

- Updated dependencies [5026b21]
- Updated dependencies [5026b21]
  - @nexus-js/core@1.2.0

## 0.4.1

### Patch Changes

- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [69c260c]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
- Updated dependencies [a536a9a]
  - @nexus-js/core@1.1.0

## 0.4.0

### Minor Changes

- Replace connection-oriented targeting with service acquisition and provider selection. Core now requires the `provider-catalog-v1` protocol capability, uses endpoint `defaultTarget`, adds `select` and `selectMulticast`, binds multicast proxies to acquisition or selection snapshots, and supports acquisition `timeout`/`signal` plus proxy `callTimeout`. This wire-protocol change requires all peers to use core 1.0.0 or later.

  Chrome, iframe, node-ipc, React, and testing now require `@nexus-js/core >=1.0.0`. Adapters use exact connection targets and `where(contextMeta, connectionMeta)` predicates; testing supports metadata-backed provider selection and bound multicast snapshots.

### Patch Changes

- Updated dependencies
  - @nexus-js/core@1.0.0

## 0.3.2

### Patch Changes

- 14c4348: Replace the safe async APIs with `Promise<Result<T, E>>` backed by `better-result`, preserving structured Nexus error behavior and package loading compatibility.
- Updated dependencies [14c4348]
  - @nexus-js/core@0.6.0

## 0.3.1

### Patch Changes

- Updated dependencies [7ddeeb7]
  - @nexus-js/core@0.5.0

## 0.3.0

### Minor Changes

- a3b2f48: Clean up the public authoring API vocabulary and provider/configuration surface.

  Rename metadata and targeting types to the endpoint-focused terminology, standardize provider authoring on `ServiceProvider`, `serviceProvider(...)`, `providers`, and `provide(Token, service)`, replace token creation defaults with `defaultTarget` and `TokenSpace.space(...)`, expose Nexus State providers through `createNexusStore(...).provider`, and make `composeNexusConfig([...])` the public domain-aware config composition primitive with left-to-right last-wins semantics.

  Chrome authoring now uses `ChromeEndpointMeta`, explicit `createXConfig(...)` composition helpers, and `usingX(...)` runtime helpers. Content script visibility is represented by `isVisible` and the `visibleContentScript` matcher rather than active-tab terminology.

### Patch Changes

- Updated dependencies [a3b2f48]
  - @nexus-js/core@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [9332801]
  - @nexus-js/core@0.3.0

## 0.2.0

### Minor Changes

- e029932: Add the iframe adapter package and public transport subpaths for adapter authors, including virtual-port routing over message-bus transports.

### Patch Changes

- 6bfd5b8: Add token create defaults, instance-bound class decorators, provider registration lifecycle APIs, and updated public usage guidance for the new configure/provide/create model.
- Updated dependencies [e029932]
- Updated dependencies [48aaab9]
- Updated dependencies [6bfd5b8]
  - @nexus-js/core@0.2.0
