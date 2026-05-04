# Shared Contracts

Define service interfaces and Tokens in shared modules imported by both host and consumer contexts.

## Tokens

Prefer `TokenSpace` when token IDs should be hierarchical or a family of tokens should share default targeting. Use direct `new Token<T>(...)` only for small examples or when namespacing and default targets are unnecessary.

Token modules should import existing service interfaces with `import type`. Do not repeat service method shapes inline at token definition sites.

```ts
import { TokenSpace } from "@nexus-js/core";
import type { ChromePlatformMeta, ChromeUserMeta } from "@nexus-js/chrome";
import type { SettingsService } from "./contracts";

const appSpace = new TokenSpace<ChromeUserMeta, ChromePlatformMeta>({
  name: "my-extension",
});

const backgroundServices = appSpace.tokenSpace("background-services", {
  defaultCreate: {
    target: {
      descriptor: { context: "background" },
    },
  },
});

export const SettingsToken =
  backgroundServices.token<SettingsService>("settings");
```

Import existing service types instead of defining anonymous shapes inline.

Good:

```ts
import type { SettingsService } from "./contracts";

export const SettingsToken = services.token<SettingsService>("settings");
```

Avoid:

```ts
export const SettingsToken = services.token<{
  getSettings(): Promise<Record<string, unknown>>;
}>("settings");
```

## Service Exposure

Use `@xxNexus.Expose(Token)` for class-style services. Import the concrete Nexus instance from the runtime/bootstrap module so the class is bound to that instance's registry.

```ts
import { backgroundNexus } from "./runtime";
import { SettingsToken, type SettingsService } from "./shared";

@backgroundNexus.Expose(SettingsToken)
class SettingsServiceImpl implements SettingsService {
  async getSettings() {
    return {};
  }

  async saveSettings(settings: Record<string, unknown>) {
    await persist(settings);
  }
}
```

Use `xxNexus.provide(...)` for function/object-style providers, helper outputs, and already constructed service instances.

```ts
import { backgroundNexus } from "./runtime";
import { SettingsToken, type SettingsService } from "./shared";

const settingsService: SettingsService = {
  async getSettings() {
    return {};
  },
  async saveSettings(settings) {
    await persist(settings);
  },
};

backgroundNexus.provide(SettingsToken, settingsService, {
  policy: {
    canCall({ remoteIdentity }) {
      return remoteIdentity.context === "content-script";
    },
  },
});
```

Keep `configure(...)` in main/bootstrap/runtime modules. Service implementation files should expose providers through `@xxNexus.Expose(...)` or `xxNexus.provide(...)`, not configure endpoints.
