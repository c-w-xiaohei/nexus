# @nexus-js/chrome

Chrome extension adapter for the Nexus framework, providing seamless cross-context communication for Chrome extensions.

## Installation

```bash
npm install @nexus-js/chrome @nexus-js/core
```

## Quick Start

### Background Script

```typescript
import { usingBackgroundScript, nexus, Expose, Token } from "@nexus-js/chrome";

// Define service interface and token
interface IBackgroundService {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
}

const BackgroundServiceToken = new Token<IBackgroundService>(
  "background-service",
);

// Configure Nexus for background context
usingBackgroundScript();

// Expose service
@Expose(BackgroundServiceToken)
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
import { usingContentScript, nexus } from "@nexus-js/chrome";
import { BackgroundServiceToken } from "./shared/tokens";

// Configure Nexus for content script context
usingContentScript();

// Use background service
async function main() {
  const backgroundService = await nexus.create(BackgroundServiceToken, {
    target: { descriptor: { context: "background" } },
  });

  const settings = await backgroundService.getSettings();
  console.log("Settings:", settings);
}

main();
```

### Popup

```typescript
import { usingPopup, nexus } from "@nexus-js/chrome";
import { BackgroundServiceToken } from "./shared/tokens";

// Configure Nexus for popup context
async function initPopup() {
  await usingPopup();

  const backgroundService = await nexus.create(BackgroundServiceToken, {
    target: { descriptor: { context: "background" } },
  });

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
