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

Contributors need a local dependency install and the Playwright-bundled Chromium
browser:

```bash
pnpm install
pnpm --filter @nexus-js/chrome exec playwright install --with-deps chromium
```

Run the primary browser lanes with:

```bash
pnpm --filter @nexus-js/chrome test:browser
pnpm --filter @nexus-js/chrome test:browser:worker:p0
```

For the full worker suite, use
`pnpm --filter @nexus-js/chrome test:browser:worker` when needed. The scripts
build the WXT fixture and run Playwright with persistent Chromium and a fresh
profile for each test case. This is contributor-only test infrastructure and
does not change published package behavior or public APIs.

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
