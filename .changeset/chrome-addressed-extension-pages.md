---
"@nexus-js/chrome": minor
---

Compared with the published `@nexus-js/chrome` API baseline, add exact
application-owned extension-page targets and structured built-in page targets.
Allow Chrome contexts to dial addressed pages and ordinary extension pages to
dial exact content targets. Offscreen documents can dial background or page
targets, but not content targets. Filter native ports at the endpoint boundary,
preserve additional observed sender metadata, and keep receiver helper
auto-identification separate from caller target selection.

Breaking protocol change: all peers must upgrade together. Nexus Chrome ports
now use versioned destination names; legacy unnamed ports are ignored. Built-in
contexts use their dedicated structured targets: `offscreenDocument()`,
`devToolsPage({ inspectedTabId })`, `popup({ windowId })`,
`sidePanel({ windowId })`, and `optionsPage()`. Their receiver helpers derive
local Chrome facts internally; caller target selection remains separate. Native
content routing uses `contentFrame({ tabId, frameId })` or
`contentDocument({ tabId, documentId })`. `endpointId` and
`chromeTarget.extensionPage({ endpointId })` remain for custom
`usingExtensionPage` / `createExtensionPageConfig` contexts only, because Chrome
cannot infer application business identity there. Context creation and readiness
remain application-owned. The `side-panel` context is adapter-owned; migrate
custom `usingExtensionPage({ context: "side-panel" })` setups to
`usingSidePanel()` or `createSidePanelConfig()`. The Options target has one live
receiver per profile; duplicate Options pages fail readiness until the current
owner closes.
