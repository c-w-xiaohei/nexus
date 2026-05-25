# @nexus-js/node-ipc

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

## 0.1.2

### Patch Changes

- e84c367: Release the initial public Node IPC adapter package and update core runtime capabilities that support adapter authorization and connection hardening.

  Core now includes authorization policy hooks, a split between listen and connect capabilities, async listen support with handshake timeouts, and public/internal API updates for serializer benchmarks and dependencies.

- Updated dependencies [e84c367]
  - @nexus-js/core@0.1.2
