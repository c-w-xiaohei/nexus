# @nexus-js/testing

## 0.7.0-alpha.1

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

## 0.7.0-alpha.0

### Minor Changes

- faa79fa: Reuse Core call dispatch and request/reply processing in memory, including path
  validation, business-error trust and orphan-resource cleanup. Preserve direct
  callbacks and shared-memory ref arguments through the mock's argument codec.

  Update `createMockNexus` for the Core 2.0 alpha connection-resource API,
  including connection acquisition, connection observation, and per-connection
  multicast resources.
  Remove standalone `MockNexus*Call` record types; call history retains its existing
  object shape, with types available directly from `MockNexus["calls"]`.

  Mock lazy calls now retain consumed values after disconnect, reject new
  consumption with the Core disconnected error, and normalize service throws to
  `E_REMOTE_EXCEPTION`. Mock service facades reuse Core proxy and payload conversion,
  including refs returned by asynchronous methods and explicit resource release.
  Payload conversion failures remain protocol errors, distinct from business throws.
  Arguments use direct in-memory invocation rather than a transport session.
  Keep Core subpaths external in the Testing build so published mock calls share
  Core's private consumption registry and work with `Nexus.safeCall`.

  Reuse Core pending-call handling for mocks, honor configured and per-resource
  call timeouts, and allocate a fresh session after disconnect. Keep missing
  services visible as per-connection errors in collection `get`.
  Reuse Core's shared acquisition rules so mock targeting, cardinality, timeout,
  and request-local abort behavior match Core sessions.

## 0.6.0

### Minor Changes

- Replace connection-oriented targeting with service acquisition and provider selection. Core now requires the `provider-catalog-v1` protocol capability, uses endpoint `defaultTarget`, adds `select` and `selectMulticast`, binds multicast proxies to acquisition or selection snapshots, and supports acquisition `timeout`/`signal` plus proxy `callTimeout`. This wire-protocol change requires all peers to use core 1.0.0 or later.

  Chrome, iframe, node-ipc, React, and testing now require `@nexus-js/core >=1.0.0`. Adapters use exact connection targets and `where(contextMeta, connectionMeta)` predicates; testing supports metadata-backed provider selection and bound multicast snapshots.

## 0.5.0

### Minor Changes

- 14c4348: Replace the safe async APIs with `Promise<Result<T, E>>` backed by `better-result`, preserving structured Nexus error behavior and package loading compatibility.

## 0.4.0

### Minor Changes

- 7ddeeb7: Preserve Token endpoint metadata across core and testing public APIs so runtime-specific tokens can be provided, exposed, registered as store providers, and created safely without local casting shims.

  Tighten runtime create-token metadata acceptance for `create`, `safeCreate`, `createMulticast`, `safeCreateMulticast`, and mock `create`/`safeCreate`: tokens with unrelated metadata or metadata narrower than the runtime are rejected, while plain/default metadata and metadata that can safely accept runtime identities remain accepted.

## 0.3.0

### Minor Changes

- a3b2f48: Clean up the public authoring API vocabulary and provider/configuration surface.

  Rename metadata and targeting types to the endpoint-focused terminology, standardize provider authoring on `ServiceProvider`, `serviceProvider(...)`, `providers`, and `provide(Token, service)`, replace token creation defaults with `defaultTarget` and `TokenSpace.space(...)`, expose Nexus State providers through `createNexusStore(...).provider`, and make `composeNexusConfig([...])` the public domain-aware config composition primitive with left-to-right last-wins semantics.

  Chrome authoring now uses `ChromeEndpointMeta`, explicit `createXConfig(...)` composition helpers, and `usingX(...)` runtime helpers. Content script visibility is represented by `isVisible` and the `visibleContentScript` matcher rather than active-tab terminology.

### Patch Changes

- Updated dependencies [a3b2f48]
  - @nexus-js/core@0.4.0

## 0.2.0

### Minor Changes

- 829cb0e: Add a testing package with createMockNexus for user-level Nexus application unit tests.
