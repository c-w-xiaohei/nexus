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
    return await chrome.storage.sync.get("settings");
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
- **Pre-configured matchers** for common scenarios
- **Zero-configuration setup** for standard use cases
- **Full TypeScript support** with discriminated union types

Content scripts, popups, and options pages can usually call background services with `nexus.create(Token)` when the Token has a `defaultTarget` for the background or the adapter has a unique background `connectTo` fallback. Background-to-content-script calls usually need an explicit descriptor or matcher because there may be many content scripts. Application code owns tab/window discovery and decides when identity changes require new handles. Raw proxies and refs are session-bound: after disconnect, service worker restart, or other session replacement, application code should recreate handles and decide any retry or rebuild policy explicitly.

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

### Pre-defined Matchers

- `any-content-script` - Match any content script
- `any-popup` - Match any popup
- `visible-content-script` - Match visible content scripts
- `background` - Match background script

### Types

- `ChromeEndpointMeta` - Discriminated union for built-in Chrome contexts plus custom contexts that include a `context` discriminator
- `ChromePlatformMeta` - Chrome-specific platform metadata
- Context-specific types: `ChromeBackgroundMeta`, `ChromeContentScriptMeta`, etc.

## Advanced Usage

### Custom Matchers

```typescript
import { ChromeMatchers, type ChromeEndpointMeta } from "@nexus-js/chrome";

// Use built-in matchers
const githubContentScripts = await nexus.createMulticast(ServiceToken, {
  target: { matcher: ChromeMatchers.contentScriptByUrl("github.com") },
});

// Custom matcher
const customMatcher = (identity: ChromeEndpointMeta) =>
  identity.context === "content-script" &&
  identity.url.includes("special-page");
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
