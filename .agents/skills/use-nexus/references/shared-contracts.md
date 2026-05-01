# Shared Contracts

Define service interfaces and Tokens in shared modules imported by both host and consumer contexts.

## Tokens

Prefer `TokenSpace` when token IDs should be hierarchical or a family of tokens should share default targeting. Use direct `new Token<T>(...)` only for small examples or when namespacing and default targets are unnecessary.

```ts
import { TokenSpace } from "@nexus-js/core";
import type { ChromePlatformMeta, ChromeUserMeta } from "@nexus-js/chrome";

export interface SettingsService {
  getSettings(): Promise<Record<string, unknown>>;
  saveSettings(settings: Record<string, unknown>): Promise<void>;
}

const appSpace = new TokenSpace<ChromeUserMeta, ChromePlatformMeta>({
  name: "my-extension",
});

const backgroundServices = appSpace.tokenSpace("background-services", {
  defaultTarget: {
    descriptor: { context: "background" },
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

Use `@Expose(Token)` for normal singleton Nexus setup.

```ts
import { Expose } from "@nexus-js/core";
import { SettingsToken, type SettingsService } from "./shared";

@Expose(SettingsToken)
class SettingsServiceImpl implements SettingsService {
  async getSettings() {
    return {};
  }

  async saveSettings(settings: Record<string, unknown>) {
    await persist(settings);
  }
}
```

Use explicit `configure({ services })` for multi-instance setups, tests, or architectures that avoid process-global decorators.

```ts
nexus.configure({
  endpoint: endpointConfig,
  services: [
    {
      token: SettingsToken,
      implementation: settingsService,
    },
  ],
});
```

Decorator registrations are process-global. Multi-instance and isolated test setups must use explicit services.
