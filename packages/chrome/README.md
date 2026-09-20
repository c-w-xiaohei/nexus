# @nexus-js/chrome

Chrome extension adapter for the Nexus framework, providing seamless cross-context communication for Chrome extensions.

For the product guide, see the [published Nexus documentation](https://c-w-xiaohei.github.io/nexus/docs/).

## Installation

```bash
pnpm add @nexus-js/chrome @nexus-js/core
```

## Quick Start

### Shared Contract (`shared/tokens.ts`)

```typescript
import { Token } from "@nexus-js/core";

export type Settings = {
  theme: "light" | "dark";
};

export interface BackgroundService {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
}

export const BackgroundServiceToken = new Token<BackgroundService>(
  "background-service",
);
```

### Background Script

```typescript
import { usingBackgroundScript } from "@nexus-js/chrome";
import {
  BackgroundServiceToken,
  type BackgroundService,
  type Settings,
} from "./shared/tokens";

// Configure Nexus for background context
const backgroundNexus = usingBackgroundScript();

// Expose a class service on the configured background instance
@backgroundNexus.Expose(BackgroundServiceToken)
class BackgroundServiceImpl implements BackgroundService {
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
import { chromeTarget, usingContentScript } from "@nexus-js/chrome";
import { BackgroundServiceToken } from "./shared/tokens";

// Configure Nexus for content script context
const contentNexus = usingContentScript();

// Use background service
async function main() {
  const connection = await contentNexus.connect({
    target: chromeTarget.background(),
  });
  const backgroundService = connection.get(BackgroundServiceToken);

  const settings = await backgroundService.getSettings();
  console.log("Settings:", settings);
}

main();
```

### Popup

```typescript
import { chromeTarget, usingPopup } from "@nexus-js/chrome";
import { BackgroundServiceToken } from "./shared/tokens";

// Configure Nexus for popup context
async function initPopup() {
  const popupNexus = usingPopup();

  const connection = await popupNexus.connect({
    target: chromeTarget.background(),
  });
  const backgroundService = connection.get(BackgroundServiceToken);

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

Content scripts, popups, and options pages acquire the background with the exact
`chromeTarget.background()` target. Background-to-content calls use an exact
`chromeTarget.contentFrame(...)` or `chromeTarget.contentDocument(...)` target.
Application code owns tab/window discovery and decides when identity changes
require new handles. Raw proxies and refs are session-bound: after disconnect,
service worker restart, or other session replacement, application code should
reconnect and get fresh handles.

`connectMulticast` accepts an explicit target array for strict multi-target
acquisition, or no targets for a current ready-connection snapshot. Call
`collection.get(Token)` to receive one `{ connection, result }` item per member.
Each successful result is an ordinary proxy; failed members remain visible.
Acquisition `timeout`/`signal` apply to connection acquisition, while
`callTimeout` applies to proxy calls. Invalid option keys, timeout values, aborts,
and incompatible provider-catalog protocols return structured errors.

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
- `createSidePanelConfig(options?)`
- `createDevToolsPageConfig(options?)`
- `createOffscreenDocumentConfig(options)`
- `createExtensionPageConfig(meta, options?)`

Effectful runtime helpers:

- `usingBackgroundScript(options?)` - Configure for background script/service worker
- `usingContentScript(options?)` - Configure for content script, including visibility metadata updates
- `usingPopup()` - Configure for popup; the helper resolves its current `windowId`
- `usingOptionsPage()` - Configure the profile's designated options receiver
- `usingSidePanel()` - Configure the currently running side panel for the current browser window
- `usingDevToolsPage()` - Configure for devtools; the helper reads the inspected tab
- `usingOffscreenDocument({ reason })` - Configure for offscreen document
- `usingExtensionPage(meta, options?)` - Configure for a custom extension page

Pass explicit startup targets as `options.connectTo`. Custom page helpers keep
arbitrary identity metadata in the first argument and connection options in the
second, for example:

```ts
usingExtensionPage(
  { context: "settings-page", page: "settings.html" },
  { connectTo: [chromeTarget.background()] },
);
```

Startup targets are explicit `connectTo` entries and are independent of service
acquisition; omitting them does not dial.

Built-in helpers identify their receiver from the local Chrome context, while
callers choose targets independently. Use `chromeTarget.popup({ windowId })`,
`chromeTarget.sidePanel({ windowId })`, and
`chromeTarget.devToolsPage({ inspectedTabId })` when exact caller-side routing is
needed. Use `chromeTarget.optionsPage()` and
`chromeTarget.offscreenDocument()` for their designated profile receivers. Use
`chromeTarget.contentFrame({ tabId, frameId })` or
`chromeTarget.contentDocument({ tabId, documentId })` for native content routing.
The Side Panel target is window-level; tab-specific/global panel configuration is
application UI configuration. Ordinary extension pages can also dial exact
content targets; offscreen documents and content scripts cannot initiate
`tabs.connect()`. Connections remain bidirectional after acquisition.
Only one live Options page can own `chromeTarget.optionsPage()`; duplicate
receivers fail readiness, and a replacement can acquire the target after the
owner closes.

Opening or creating a built-in page is separate from acquisition. `connect({
target })` only connects to an existing ready receiver; it does not open Popup,
Options, Side Panel, or DevTools, create Offscreen, or inject Content.

Routing ownership is split deliberately: applications choose and discover the
target instance, the Chrome adapter enforces platform capabilities and opens the
native Port, and Core owns handshake, authorization, Connection lifecycle, RPC,
and Relay. Targets are routing; ContextMeta is identity; policy remains
authorization. Built-in pages use their dedicated target constructors, while
custom extension pages use `chromeTarget.extensionPage({ endpointId })`.

Incoming ports are filtered by versioned destination names before Core receives
them. Upgrade all peers together: legacy unnamed Nexus ports are ignored. Names
provide adapter routing, not authentication or Chrome-native unicast.

### Target Constructors And Predicates

- `chromeTarget.background()` - Exact background target
- `chromeTarget.contentFrame({ tabId, frameId })` - Exact content-script frame target
- `chromeTarget.contentDocument({ tabId, documentId })` - Exact content-script document target
- `chromeTarget.offscreenDocument()` - Singleton offscreen document target
- `chromeTarget.devToolsPage({ inspectedTabId })` - Exact DevTools page target
- `chromeTarget.popup({ windowId })` - Exact popup target
- `chromeTarget.sidePanel({ windowId })` - Exact window-level side-panel target
- `chromeTarget.optionsPage()` - Designated options-page receiver
- `chromeTarget.extensionPage({ endpointId })` - Exact application-addressed extension page
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

### Exact Acquisition And Connection Filtering

```typescript
import { nexus } from "@nexus-js/core";
import { chromeTarget, whereContentScriptByUrl } from "@nexus-js/chrome";
import { ServiceToken } from "./shared";

const tabId = 42;

// The snippet runs in a previously configured consumer context.
// Select one known tab/frame with an exact target.
const tabConnection = await nexus.connect({
  target: chromeTarget.contentFrame({ tabId, frameId: 0 }),
});
const tabService = tabConnection.get(ServiceToken);

// Dynamically fan out to matching ready content-script sessions.
const githubContentScripts = await nexus.connectMulticast({
  where: whereContentScriptByUrl("github.com"),
});
const githubServices = githubContentScripts.get(ServiceToken);

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

### Fixture Scenarios

`tests/browser/extension/entrypoints/background.ts` runs the fixture's providers,
control-message boundary, retained handles, and lifecycle barriers. It is the
extension entrypoint; assertions live in `tests/browser/normal/*.spec.ts`.

- Routing checks passive connection waiting, empty snapshots, and exact targets.
- Capability checks retain session-bound proxies and refs across navigation,
  combine per-connection calls, and distinguish reference release from disconnect.
- Relay and UI checks cover authorization, document replacement, State fan-out,
  storage persistence, and offscreen creation/closure.

Some command and barrier names retain historical `select` or `create` wording.
Their implementations use `connect`, `connectMulticast`, and `connection.get`.
An empty connection snapshot is valid; an expiring passive wait reports
`E_SERVICE_ACQUISITION_TIMEOUT`. Policy denial reports `E_AUTH_CALL_DENIED`.

For a focused edit to the entrypoint, build the fixture before invoking Playwright:

```bash
pnpm --filter @nexus-js/chrome build:test-extension
pnpm --filter @nexus-js/chrome exec playwright test --project=normal normal/routing.spec.ts normal/capabilities.spec.ts
pnpm --filter @nexus-js/chrome typecheck:browser
```

## Other Contexts

```typescript
// Options page. Opening/focusing remains a separate runtime.openOptionsPage() call.
import { usingOptionsPage } from "@nexus-js/chrome";
usingOptionsPage();

// DevTools page. Its inspected tab is the structural route.
import { usingDevToolsPage } from "@nexus-js/chrome";
usingDevToolsPage();

// Offscreen document. It is the singleton per profile; no endpointId is needed.
import { usingOffscreenDocument } from "@nexus-js/chrome";
usingOffscreenDocument({ reason: "audio-processing" });
```

These helpers configure the current context. They neither create the page nor
implicitly dial the background. Supply `chromeTarget.background()` to `connect`
or list it explicitly in `connectTo`.

## License

MIT
