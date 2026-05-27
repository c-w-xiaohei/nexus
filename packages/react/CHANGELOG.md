# @nexus-js/react

## 0.4.0

### Minor Changes

- 0bada0f: Add `createRemoteStoreScope(...)` for provider-based shared remote store connections in React subtrees.

### Patch Changes

- 2b0808a: Fix React 19 import-time compatibility by externalizing React and ReactDOM subpath runtime imports from the published bundle.

## 0.3.1

### Patch Changes

- 9e2e79c: Allow React 19 applications to install the React bindings without peer dependency conflicts.

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

- e029932: Add the iframe adapter package and public transport subpaths for adapter authors, including virtual-port routing over message-bus transports.
