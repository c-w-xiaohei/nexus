# @nexus-js/core

## 2.0.0-alpha.1

### Minor Changes

- 4524114: Add `ResourceScope` and `Connection.createScope(token)` for independently
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

- 153b466: Accept Standard Schema validators for State snapshots and action results,
  including Valibot, Zod, and Zod Mini. Validation remains synchronous and preserves
  the original wire state and action result; transformed outputs are not installed.
  Remove the production Zod dependency and keep validator-library details outside
  the public State contract.

### Patch Changes

- 153b466: Validate Core message and known payload-placeholder structures with Valibot before
  dispatch or revival. Preserve the existing wire format, legacy invocation
  packets, opaque payloads, and session-owned resource cleanup. Migrate internal
  VirtualPort, State, and decorator schemas from Zod to Valibot.

  Validate iframe envelope payload presence and nonce types. Share Node IPC auth
  request and response schemas while preserving authentication error codes and
  socket framing.

## 2.0.0-alpha.0

### Major Changes

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

## 1.2.0

### Minor Changes

- 5026b21: Add optional exact `endpoint.connectTo` startup targets. Dials start after
  listening without blocking `ready()` or automatically retrying.

  Breaking changes in this rapid-iteration release: bind native Zustand stores
  with explicit `snapshot` and `expose` options; replace `defineNexusStore` with
  `createStoreToken<Store>(id, options?)` using a single shared data/method contract;
  and use the lifecycle-owning `VirtualPortRouter`
  class instead of static context functions. State now uses callback-init
  subscriptions and caller-specific fixed-window acknowledgements. Upgrade State
  hosts, clients, and relays together; the previous State wire contract is not
  compatible. Ordinary RPC and virtual-port wire formats are unchanged.

  Ordinary proxy call rejections are no longer automatically observed or logged
  by Nexus. Await or catch calls; ignored failures follow the runtime's normal
  unhandled-rejection behavior.

  State APIs accept StoreToken directly, with validation on the token and derived
  snapshot/action types. TokenSpace provides `storeToken` and `safeStoreToken` to
  preserve namespace IDs and inherited targeting. Use `RemoteStore<Store>` rather
  than separate State/Actions generics or public wire-service utility types.

  See the [1.2 migration guide](https://github.com/c-w-xiaohei/nexus/blob/main/docs/migrations/1.2.md)
  for changed signatures, action semantics, and package compatibility.

### Patch Changes

- 5026b21: Fix early-message ordering, timeout settlement, late authorization, and reentrant
  connection cleanup. Reclaim callback, stream, and resource capabilities when
  dispatch or reply delivery fails, including failed and late State subscriptions.
  Preserve caller authorization and isolate slow State subscribers without closing
  other services on their shared connection.

## 1.1.0

### Minor Changes

- a536a9a: Cancel local pending multicast stream state when async iteration ends early.
- a536a9a: Support JavaScript `using` for local and remote Nexus State handles.
- a536a9a: Support JavaScript `using` for explicitly typed remote resource proxies.
- a536a9a: Add status subscriptions and constrained diagnostics for exact ordinary unicast
  proxy roots.
- a536a9a: Send current and future proxy status snapshots directly to lifecycle listeners.
- a536a9a: Export `NexusDisconnectedError` and normalize closed local proxy calls to that
  public error type.
- a536a9a: Add push subscriptions for RemoteStore lifecycle status changes.
- a536a9a: Add `getInitialState()` and JavaScript `using` support to concrete local and
  remote Core Store handles without widening the existing compatibility-facing
  Store interfaces. Remove
  `useStoreSelector` in favor of Zustand-shaped `useStore(store, selector?)`.
  Scoped `useSelector` now returns its explicit fallback whenever no current
  `RemoteStore` handle exists, without retaining values from a previous handle.
- a536a9a: Add static `Nexus.release` and `Nexus.safeRelease` helpers for remote resource
  capabilities.

### Patch Changes

- a536a9a: Reject unavailable bound call targets before creating pending calls or payload
  resources.
- a536a9a: Preserve capabilities accepted by earlier targets when later call dispatch fails.
- a536a9a: Fail calls when a resolved connection does not accept its dispatched message.
- a536a9a: Reject strategy-one calls with multiple ready targets before dispatching.
- a536a9a: Classify send failures that synchronously close their logical connection as disconnected.
- 69c260c: Fix remote Resource proxy cleanup across connections, explicit release, late
  responses, and failed payload revival.
- a536a9a: Continue disconnect cleanup when an exposed service hook throws.
- a536a9a: Continue evaluating stale target subscriptions when a predicate throws.
- a536a9a: Return release capability failures through safe release results.

## 1.0.0

### Major Changes

- Replace connection-oriented targeting with service acquisition and provider selection. Core now requires the `provider-catalog-v1` protocol capability, uses endpoint `defaultTarget`, adds `select` and `selectMulticast`, binds multicast proxies to acquisition or selection snapshots, and supports acquisition `timeout`/`signal` plus proxy `callTimeout`. This wire-protocol change requires all peers to use core 1.0.0 or later.

  Chrome, iframe, node-ipc, React, and testing now require `@nexus-js/core >=1.0.0`. Adapters use exact connection targets and `where(contextMeta, connectionMeta)` predicates; testing supports metadata-backed provider selection and bound multicast snapshots.

## 0.6.0

### Minor Changes

- 14c4348: Replace the safe async APIs with `Promise<Result<T, E>>` backed by `better-result`, preserving structured Nexus error behavior and package loading compatibility.

## 0.5.0

### Minor Changes

- 7ddeeb7: Preserve Token endpoint metadata across core and testing public APIs so runtime-specific tokens can be provided, exposed, registered as store providers, and created safely without local casting shims.

  Tighten runtime create-token metadata acceptance for `create`, `safeCreate`, `createMulticast`, `safeCreateMulticast`, and mock `create`/`safeCreate`: tokens with unrelated metadata or metadata narrower than the runtime are rejected, while plain/default metadata and metadata that can safely accept runtime identities remain accepted.

## 0.4.0

### Minor Changes

- a3b2f48: Clean up the public authoring API vocabulary and provider/configuration surface.

  Rename metadata and targeting types to the endpoint-focused terminology, standardize provider authoring on `ServiceProvider`, `serviceProvider(...)`, `providers`, and `provide(Token, service)`, replace token creation defaults with `defaultTarget` and `TokenSpace.space(...)`, expose Nexus State providers through `createNexusStore(...).provider`, and make `composeNexusConfig([...])` the public domain-aware config composition primitive with left-to-right last-wins semantics.

  Chrome authoring now uses `ChromeEndpointMeta`, explicit `createXConfig(...)` composition helpers, and `usingX(...)` runtime helpers. Content script visibility is represented by `isVisible` and the `visibleContentScript` matcher rather than active-tab terminology.

## 0.3.0

### Minor Changes

- 9332801: Replace `provideNexusStore` with `createNexusStore`, returning both the Nexus service registration config and a local authoritative store handle.

## 0.2.0

### Minor Changes

- e029932: Add the iframe adapter package and public transport subpaths for adapter authors, including virtual-port routing over message-bus transports.
- 48aaab9: Add `@nexus-js/core/relay` with `relayService` and `relayNexusStore`, and extend Nexus State/store invocation context and terminal sync handling needed for relay-backed forwarding.
- 6bfd5b8: Add token create defaults, instance-bound class decorators, provider registration lifecycle APIs, and updated public usage guidance for the new configure/provide/create model.

## 0.1.2

### Patch Changes

- e84c367: Release the initial public Node IPC adapter package and update core runtime capabilities that support adapter authorization and connection hardening.

  Core now includes authorization policy hooks, a split between listen and connect capabilities, async listen support with handshake timeouts, and public/internal API updates for serializer benchmarks and dependencies.

## 0.1.1

### Patch Changes

- acd681a: fix dep
- 03021e8: initial publish
