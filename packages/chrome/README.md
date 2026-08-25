# @nexus-js/chrome

Chrome extension adapter for the Nexus framework, providing seamless cross-context communication for Chrome extensions.

## Installation

```bash
npm install @nexus-js/chrome @nexus-js/core
```

## Quick Start

### Background Script

```typescript
import { Token } from "@nexus-js/core";
import { usingBackgroundScript } from "@nexus-js/chrome";

// Define service interface and token
type Settings = {
  theme: "light" | "dark";
};

interface IBackgroundService {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
}

const BackgroundServiceToken = new Token<IBackgroundService>(
  "background-service",
);

// Configure Nexus for background context
const backgroundNexus = usingBackgroundScript();

// Expose a class service on the configured background instance
@backgroundNexus.Expose(BackgroundServiceToken)
class BackgroundService implements IBackgroundService {
  async getSettings() {
    const result = await chrome.storage.sync.get("settings");
    return (result.settings as Settings | undefined) ?? { theme: "light" };
  }

  async saveSettings(settings: Settings) {
    await chrome.storage.sync.set({ settings });
  }
}
```

### Content Script

```typescript
import { nexus } from "@nexus-js/core";
import { usingContentScript } from "@nexus-js/chrome";
import { BackgroundServiceToken } from "./shared/tokens";

// Configure Nexus for content script context
usingContentScript();

// Use background service
async function main() {
  const backgroundService = await nexus.create(BackgroundServiceToken);

  const settings = await backgroundService.getSettings();
  console.log("Settings:", settings);
}

main();
```

### Popup

```typescript
import { nexus } from "@nexus-js/core";
import { usingPopup } from "@nexus-js/chrome";
import { BackgroundServiceToken } from "./shared/tokens";

// Configure Nexus for popup context
async function initPopup() {
  usingPopup();

  const backgroundService = await nexus.create(BackgroundServiceToken);

  // Use the service
  const settings = await backgroundService.getSettings();
  // Update UI...
}

initPopup();
```

## Features

- **Type-safe communication** between all Chrome extension contexts
- **Chrome runtime port integration** for extension context messaging
- **Target constructors and predicates** for common Chrome contexts
- **Zero-configuration setup** for standard use cases
- **Full TypeScript support** with discriminated union types

Content scripts, popups, and options pages receive `chromeTarget.background()` as their endpoint `defaultTarget`, so `nexus.create(Token)` acquires a background provider by default. Background-to-content calls use an exact `chromeTarget.contentFrame(...)` or `chromeTarget.contentDocument(...)`. Use `select` with a `where...` predicate only for already available providers; it never connects. `selectMulticast` binds a snapshot, not a changing set of tabs. Application code owns tab/window discovery and decides when identity changes require new handles. Raw proxies and refs are session-bound: after disconnect, service worker restart, or other session replacement, application code should recreate handles and decide any retry or rebuild policy explicitly.

`createMulticast` requires a non-empty array of exact `chromeTarget` values and fails all acquisition if any target fails. Both multicast methods support `expects: "all"` (default) and `expects: "stream"`; calls return settled `{ status, value }` or `{ status, reason }` entries without connection IDs or `from` metadata. Connection IDs are not acquisition inputs, selection keys, or routing targets. `selectMulticast` has no `wait` and may return an empty snapshot. Acquisition `timeout`/`signal` apply before `create` or `createMulticast`; `callTimeout` applies to proxy calls. Invalid option keys, timeout values, aborts, and incompatible provider-catalog protocols return structured errors.

For object services, Nexus State stores, or Relay providers, configure the runtime and call `provide(...)` instead of using class decorators:

```typescript
usingBackgroundScript().provide(BackgroundServiceToken, backgroundService);
```

## API Reference

### Config Factories And Runtime Helpers

Use `createXConfig(...)` helpers when you need pure config for `composeNexusConfig([...])`. Use `usingX(...)` helpers when you want the helper to configure the shared `nexus` instance immediately and return that instance.

Pure config factories:

- `createBackgroundScriptConfig(options?)`
- `createContentScriptConfig(options?)`
- `createPopupConfig(options?)`
- `createOptionsPageConfig(options?)`
- `createDevToolsPageConfig(options?)`
- `createOffscreenDocumentConfig(options)`
- `createExtensionPageConfig(meta)`

Effectful runtime helpers:

- `usingBackgroundScript(options?)` - Configure for background script/service worker
- `usingContentScript(options?)` - Configure for content script, including visibility metadata updates
- `usingPopup(options?)` - Configure for popup; pass caller-discovered `tabId` or `windowId` if your app needs them
- `usingOptionsPage(options?)` - Configure for options page
- `usingDevToolsPage(options?)` - Configure for devtools page
- `usingOffscreenDocument(options)` - Configure for offscreen document
- `usingExtensionPage(meta)` - Configure for a custom extension page connected to background

### Target Constructors And Predicates

- `chromeTarget.background()` - Exact background target
- `chromeTarget.contentFrame({ tabId, frameId })` - Exact content-script frame target
- `chromeTarget.contentDocument({ tabId, documentId })` - Exact content-script document target
- `whereBackground` - Select background endpoints
- `whereContentScript` - Select content-script endpoints
- `whereContentScriptByOrigin(origin)` - Select content scripts by origin
- `whereContentScriptByUrl(pattern)` - Select content scripts by URL
- `wherePopup` - Select popup endpoints
- `whereVisibleContentScript` - Select visible content scripts

### Types

- `ChromeContextMeta` - Discriminated union for built-in Chrome contexts plus custom contexts that include a `context` discriminator
- `ChromeConnectionMeta` - Adapter-observed connection facts
- `ChromeConnectionTarget` - Exact target variants
- Context-specific endpoint types: `ChromeBackgroundMeta`, `ChromeContentScriptMeta`, etc.

## Advanced Usage

### Exact Acquisition And Provider Selection

```typescript
import { nexus } from "@nexus-js/core";
import { chromeTarget, whereContentScriptByUrl } from "@nexus-js/chrome";
import { ServiceToken } from "./shared";

const tabId = 42;

// The snippet runs in a previously configured consumer context.
// Select one known tab/frame with an exact target.
const tabService = await nexus.create(ServiceToken, {
  target: chromeTarget.contentFrame({ tabId, frameId: 0 }),
});

// Dynamically fan out to matching ready content-script sessions.
const githubContentScripts = await nexus.selectMulticast(ServiceToken, {
  where: whereContentScriptByUrl("github.com"),
});

const whereSpecialPage = (contextMeta: ChromeContextMeta) =>
  contextMeta.context === "content-script" &&
  contextMeta.url.includes("special-page");
```

### Dynamic Metadata Updates

```typescript
// Content script automatically tracks visibility changes
// Manual updates are also supported:
nexus.updateIdentity({
  url: window.location.href, // Update URL for SPA navigation
  isVisible: true,
});
```

## Testing Boundary

Use `@nexus-js/testing` and `createMockNexus()` for unit tests of application code that consumes Chrome-targeted services through a `NexusInstance`.

Do not use the mock to validate Chrome adapter behavior. It does not exercise Chrome runtime ports, tab or frame metadata collection, service worker lifecycle, extension context startup, runtime disconnect ordering, or Chrome permission behavior.

Use Chrome adapter tests or extension E2E tests for those platform behaviors.

## Chrome E2E Testing

The browser suite requires a local dependency install and the Playwright-bundled
Chromium browser:

```bash
pnpm install
pnpm --filter @nexus-js/chrome exec playwright install --with-deps chromium
```

Run the package-local gates and lanes with these exact commands:

```bash
pnpm --filter @nexus-js/chrome ensure:test-extension
pnpm --filter @nexus-js/chrome test:browser:foundation
pnpm --filter @nexus-js/chrome test:browser
pnpm --filter @nexus-js/chrome test:browser:worker:gate
pnpm --filter @nexus-js/chrome test:browser:worker:p0
pnpm --filter @nexus-js/chrome test:browser:worker
pnpm --filter @nexus-js/chrome test:browser:scaffold
```

`ensure:test-extension` builds `@nexus-js/core` and `@nexus-js/chrome`,
produces the WXT `0.21.4` production Chrome MV3 fixture, validates and hashes
the generated output, and runs browser typechecks. The Playwright commands
invoke that same ensure step before their selected project; this is intentional
when using the exact package scripts. Every browser run uses the sole
`@playwright/test` harness, headless persistent bundled Chromium, a fresh
external profile per case, and a dynamically discovered extension ID. The
harness uses strict local loopback hosts and a negative origin. The origin
`http://127.0.0.1:4175` is intentionally excluded from generated manifest
content-script matches and host permissions; `http://127.0.0.1:4173/*` and
`http://127.0.0.1:4174/*` are the only allowed generated matches and host
permissions. Bootstrap asserts no top-level content marker, bridge-ready
event, or provider effect on `4175`; its embedded beta iframe on allowed
`4174` remains eligible and is asserted separately. The harness never uploads
a default browser profile. It does not use WXT dev/HMR, a raw Vite extension
fixture, Puppeteer, or `@wxt-dev/runner`.

The Playwright runner contract is `workers: 1`, `fullyParallel: false`, and
`retries: 0`. Package and CI commands are therefore serialized by the checked-in
configuration: all Chrome E2E projects share fixed host ports `4173`--`4175`,
one WXT output, and shared artifact roots. This prevents concurrent cases from
overwriting shared fixture state or interfering with one another; no CLI
override is needed.

On failure, the harness retains a screenshot when a live page exists, a trace,
console and page-error logs, diagnostics or a diagnostic-read-error log,
manifest/output hash evidence, worker URL history, extension target/runtime
evidence, and cleanup errors. Profiles remain outside the artifact paths and
are removed by cleanup. The worker lifecycle rule is mandatory:
`Target.getTargets` discovery and `Target.closeTarget` must pass before worker
tests run. If that gate is blocked, worker lifecycle coverage cannot be
claimed; the suite has no natural-idle fallback.

The real E2E boundary covers common Chrome contexts and capabilities, including
background/content, popup, options, custom, offscreen, RPC, selection,
multicast, policy, resources, callbacks, State, storage, and explicit worker
replacement. Relay coverage exercises popup/workspace -> the same background
Nexus `relayService` -> the exact current top-frame main content document,
including policy and target identity, navigation refresh, and downstream
isolation. Direct multi-context State coverage exercises main content, popup,
and workspace against one background-authoritative store, including exact
0/1/2/3 versions and late join; it does not use State Relay. Offscreen Relay
remains explicitly unsupported because Chrome's public target union has no
offscreen target; CE21 covers direct offscreen lifecycle, not Relay. Inner
tests own exact protocol error codes where applicable. The suite excludes
DevTools, natural worker idle, toolbar UX, visual approval, and a broad browser
matrix.

CI keeps the browser-free `validate` job and iframe job. Pull requests run the
normal lane and the worker P0 lane. The scheduled workflow runs a five-entry
nightly matrix with zero retries; every matrix failure fails the workflow.
Failure artifacts use unique job/matrix names and include only the package
`packages/chrome/test-results/` bundles plus generated manifest/hash files under
`tests/browser/extension/.output/chrome-mv3/`. Profiles are never included.

This adds test, documentation, and CI infrastructure only. It does not change
published package runtime behavior, public APIs, or the install contract, so no
changeset is required. It is not an npm-facing capability change.

### New Context Support

```typescript
// Options page
import { usingOptionsPage } from "@nexus-js/chrome";
usingOptionsPage();

// DevTools page
import { usingDevToolsPage } from "@nexus-js/chrome";
usingDevToolsPage();

// Offscreen document
import { usingOffscreenDocument } from "@nexus-js/chrome";
usingOffscreenDocument("audio-processing");
```

## License

MIT
