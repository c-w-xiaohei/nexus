---
"@nexus-js/core": minor
"@nexus-js/chrome": minor
"@nexus-js/react": minor
"@nexus-js/testing": minor
"@nexus-js/node-ipc": minor
"@nexus-js/iframe": minor
---

Clean up the public authoring API vocabulary and provider/configuration surface.

Rename metadata and targeting types to the endpoint-focused terminology, standardize provider authoring on `ServiceProvider`, `serviceProvider(...)`, `providers`, and `provide(Token, service)`, replace token creation defaults with `defaultTarget` and `TokenSpace.space(...)`, expose Nexus State providers through `createNexusStore(...).provider`, and make `composeNexusConfig([...])` the public domain-aware config composition primitive with left-to-right last-wins semantics.

Chrome authoring now uses `ChromeEndpointMeta`, explicit `createXConfig(...)` composition helpers, and `usingX(...)` runtime helpers. Content script visibility is represented by `isVisible` and the `visibleContentScript` matcher rather than active-tab terminology.
