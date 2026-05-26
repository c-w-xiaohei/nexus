# @nexus-js/core

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
