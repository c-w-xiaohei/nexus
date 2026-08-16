# @nexus-js/testing

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
