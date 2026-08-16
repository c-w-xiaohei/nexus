# Shared Contracts

Define service interfaces and Tokens in shared modules imported by both host and consumer contexts.

Read `references/identity-and-metadata.md` when defining `ContextMeta` for identity replacement, `ConnectionTarget` for TokenSpace targets or Token `defaultTarget`, or `ConnectionMeta` for adapter facts and policy inputs.

## Tokens

Use a shared `new Token<Service>(...)` without a default target when the contract must work across adapter models. Use `TokenSpace<Model>` when token IDs should be hierarchical or a model-bound family of tokens should share `defaultTarget` routing. A model-bound `Token<Service, Model>` may also carry a `defaultTarget`; an unbound Token remains portable.

Token modules should import existing service interfaces with `import type`. Do not repeat service method shapes inline at token definition sites.

```ts
import { Token, TokenSpace } from "@nexus-js/core";
import { chromeTarget } from "@nexus-js/chrome";
import type { ChromeAdapterModel } from "@nexus-js/chrome";
import type { SettingsService } from "./contracts";

export const SettingsToken = new Token<SettingsService>(
  "my-extension:settings",
);

export const BoundSettingsToken = new Token<
  SettingsService,
  ChromeAdapterModel
>("my-extension:bound-settings", {
  defaultTarget: chromeTarget.background(),
});

const appSpace = new TokenSpace<ChromeAdapterModel>({
  name: "my-extension",
});

export const BackgroundSettingsToken = appSpace
  .space("background-services", { defaultTarget: chromeTarget.background() })
  .token<SettingsService>("settings");
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

Use `@xxNexus.Expose(Token)` for class-style services. Import the concrete Nexus instance from the runtime/bootstrap module so the class is bound to that instance's decorator store.

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
