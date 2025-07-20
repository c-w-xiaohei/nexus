# Nexus

Nexus is a **powerful**, **type-safe**, and **default-safe** cross-context communication framework designed to simplify Inter-Process Communication (IPC) in modern JavaScript environments like Chrome Extensions, Electron applications, Web Workers, and iframes. It abstracts away the complexities of underlying communication channels, allowing you to focus on your application's business logic.

## Why Nexus?

Traditional cross-context communication often leads to fragmented APIs, boilerplate code, hidden performance pitfalls, and complex asynchronous state management. Nexus addresses these challenges by providing:

- **Unified Abstraction:** A single, consistent API (`nexus` singleton) across different platforms.
- **Declarative APIs:** Use decorators (`@Expose`, `@Endpoint`) and fluent configuration (`.configure()`) to define your communication intent.
- **End-to-end Type Safety:** Leveraging TypeScript to provide robust compile-time checks and an excellent developer experience.
- **Robust Resource Management:** Handles the lifecycle of remote resources and connections automatically.
- **Familiar Paradigms:** Nexus maps cross-context communication to intuitive local programming concepts: `@Expose` for exporting a service, `nexus.create` for constructing a remote service instance, and `Token` as its unique identifier.

## Quick Start

This section provides a brief example of how to set up and use Nexus for basic cross-context communication.

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/c-w-xiaohei/nexus.git
pnpm install -w
```

### Build

Build all packages in the monorepo:

```bash
pnpm build
```

### Example Usage (Chrome Extension Scenario)

Let's imagine a Chrome Extension where a **Background Script** wants to call a method on a **Content Script** running in a browser tab. This example leverages the `nexus-chrome-adapter` for simplified setup.

**1. Define Shared Types and Service Contract**

Create a shared file (e.g., `src/shared/types.ts`):

```typescript
// src/shared/types.ts
import type { ChromeUserMeta, ChromePlatformMeta } from "@nexus/chrome-adapter";

// Define your application-specific user metadata by extending ChromeUserMeta
// For example, if your content script adds a specific 'feature'
export interface MyUserMeta extends ChromeUserMeta {
  hasFeatureX?: boolean;
}

// You can use or extend ChromePlatformMeta directly
export type MyPlatformMeta = ChromePlatformMeta;
```

Create a shared service contract file (e.g., `src/shared/api.ts`):

```typescript
// src/shared/api.ts
import { TokenSpace } from "@nexus/core";
import type { MyUserMeta, MyPlatformMeta } from "./types";

// 1. Define the interface for your service
export interface IMyContentScriptAPI {
  getMessage(): Promise<string>;
}

// 2. Create a TokenSpace for structured token management
// This allows for hierarchical token IDs and default target inheritance.
const appSpace = new TokenSpace<MyUserMeta, MyPlatformMeta>({
  name: "my-extension",
});

// 3. Create a sub-space for content script services
// Define a default target for all tokens within this space
const contentScriptSpace = appSpace.tokenSpace("content-script-services", {
  defaultTarget: {
    matcher: (identity) => identity.context === "content-script",
    expects: "first", // Default to 'first' for content script calls
  },
});

// 4. Create a unique Token for the service within the defined space.
// The full ID will be "my-extension:content-script-services:my-service"
export const MyContentScriptAPI =
  contentScriptSpace.token<IMyContentScriptAPI>("my-service");
```

**2. Configure and Expose Service in Content Script**

Your content script (e.g., `src/content-script.ts`) will now use the `usingContentScript` factory for a streamlined setup:

```typescript
// src/content-script.ts
// IMPORTANT: This file MUST be imported at the very top of your content script entry file
import { Expose } from "@nexus/core";
import { usingContentScript } from "@nexus/chrome-adapter"; // Import the factory
import { MyContentScriptAPI, IMyContentScriptAPI } from "./shared/api";
import { MyUserMeta, MyPlatformMeta } from "./shared/types"; // Import your custom types

// 1. Initialize Nexus for the content script context.
// This sets up the endpoint, default meta, and connectTo background.
// Chain .configure() to add your custom user metadata.
usingContentScript<MyUserMeta, MyPlatformMeta>().configure({
  endpoint: {
    meta: {
      url: window.location.href, // Dynamic metadata for the content script
      // You can also add your custom `hasFeatureX: true` here
    },
  },
});

// 2. Expose the service implementation using the Token
@Expose(MyContentScriptAPI)
class ContentScriptService implements IMyContentScriptAPI {
  async getMessage(): Promise<string> {
    console.log("Content Script received request for message.");
    return "Hello from Content Script!";
  }
}

// Ensure the service is instantiated (if not using a factory in ExposeOptions)
new ContentScriptService();
```

**3. Configure and Consume Service in Background Script**

Your background script (e.g., `src/background.ts`) will use the `usingBackgroundScript` factory and `nexus.create` to call the remote service:

```typescript
// src/background.ts
// IMPORTANT: This file MUST be imported at the very top of your background script entry file
import { nexus } from "@nexus/core";
import { usingBackgroundScript } from "@nexus/chrome-adapter"; // Import the factory
import { MyContentScriptAPI } from "./shared/api";
import { MyUserMeta, MyPlatformMeta } from "./shared/types"; // Import your custom types

// 1. Initialize Nexus for the background script context.
// This sets up the endpoint and default meta for the background script.
usingBackgroundScript<MyUserMeta, MyPlatformMeta>();

// Example function to call the remote service
async function callContentScript() {
  try {
    // 2. Create a proxy for the remote service.
    // Leverage the default target defined in TokenSpace, or explicitly define it here.
    // The 'any-content-script' matcher is provided by usingBackgroundScript().
    const remoteContentScript = await nexus.create(MyContentScriptAPI, {
      target: {
        matcher: "any-content-script", // Use the named matcher provided by the Chrome adapter
      },
      // 'expects: "first"' is already the default for this TokenSpace, so it can be omitted
    });

    if (remoteContentScript) {
      // 3. Call the remote method as if it were local
      const message = await remoteContentScript.getMessage();
      console.log("Received message from content script:", message);
    } else {
      console.log("No content script found to connect to.");
    }
  } catch (error) {
    console.error("Failed to call content script:", error);
  }
}

// In a real Chrome Extension, you would trigger this call
// based on an event, e.g., chrome.action.onClicked, or chrome.tabs.onUpdated.
// For demonstration, let's call it after a short delay:
// Ensure the content script has time to connect.
setTimeout(() => {
  console.log("Attempting to call content script...");
  callContentScript();
}, 3000); // Adjust delay as needed
```
