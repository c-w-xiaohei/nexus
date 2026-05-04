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
  await usingPopup();

  const backgroundService = await nexus.create(BackgroundServiceToken);

  // Use the service
  const settings = await backgroundService.getSettings();
  // Update UI...
}

initPopup();
```

## Features

- **Type-safe communication** between all Chrome extension contexts
- **Automatic connection management** with retry and reconnection
- **Pre-configured matchers** for common scenarios
- **Zero-configuration setup** for standard use cases
- **Full TypeScript support** with discriminated union types

Content scripts, popups, and options pages can usually call background services with `nexus.create(Token)` when the Token has a `defaultCreate.target` for the background or the adapter has a unique background `connectTo` fallback. Background-to-content-script calls usually need an explicit descriptor or matcher because there may be many content scripts. After active-tab handoff, an old raw proxy does not drift to the new active tab; call `nexus.create(...)` again.

For object services, Nexus State stores, or Relay providers, configure the runtime and call `provide(...)` instead of using class decorators:

```typescript
usingBackgroundScript().provide(BackgroundServiceToken, backgroundService);
```

## API Reference

### Factory Functions

- `usingBackgroundScript()` - Configure for background script/service worker
- `usingContentScript()` - Configure for content script (with automatic visibility tracking)
- `usingPopup()` - Configure for popup (async, gets current tab)
- `usingOptionsPage()` - Configure for options page
- `usingDevToolsPage()` - Configure for devtools page
- `usingOffscreenDocument(reason)` - Configure for offscreen document

### Pre-defined Matchers

- `any-content-script` - Match any content script
- `any-popup` - Match any popup
- `active-content-script` - Match active content scripts
- `background` - Match background script

### Types

- `ChromeUserMeta` - Discriminated union for all Chrome contexts
- `ChromePlatformMeta` - Chrome-specific platform metadata
- Context-specific types: `BackgroundMeta`, `ContentScriptMeta`, etc.

## Advanced Usage

### Custom Matchers

```typescript
import { ChromeMatchers } from "@nexus-js/chrome";

// Use built-in matchers
const githubContentScripts = await nexus.createMulticast(ServiceToken, {
  target: { matcher: ChromeMatchers.contentScriptByUrl("github.com") },
});

// Custom matcher
const customMatcher = (identity: ChromeUserMeta) =>
  identity.context === "content-script" &&
  identity.url.includes("special-page");
```

### Dynamic Metadata Updates

```typescript
// Content script automatically tracks visibility changes
// Manual updates are also supported:
nexus.updateIdentity({
  url: window.location.href, // Update URL for SPA navigation
  isActive: true,
});
```

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
