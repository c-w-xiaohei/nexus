# @nexus-js/iframe

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
