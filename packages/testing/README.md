# @nexus-js/testing

User-level unit testing utilities for Nexus applications.

For the full guide, read `docs/testing/README.md` from the repository root.

## Install

```bash
pnpm add -D @nexus-js/testing
```

## Main API

- `createMockNexus()`
- `NexusMockError`

## Minimal Example

```ts
import { createMockNexus } from "@nexus-js/testing";
import { SettingsToken, type SettingsService } from "./shared";

const mock = createMockNexus();

const settings: SettingsService = {
  async getSettings() {
    return { theme: "dark" };
  },
};

mock.service(SettingsToken, settings);

const proxy = await mock.nexus.create(SettingsToken, {
  target: { descriptor: { context: "background" } },
});

await expect(proxy.getSettings()).resolves.toEqual({ theme: "dark" });
```

## Scope

Use this package to test application code that consumes a `NexusInstance`.

It does not simulate transports, adapters, real connections, reconnects, browser frames, Chrome runtime ports, Unix sockets, or multicast semantics.
