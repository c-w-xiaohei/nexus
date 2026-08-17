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
  target: { context: "background" },
});

await expect(proxy.getSettings()).resolves.toEqual({ theme: "dark" });
```

`target` is an exact target object for the adapter model under test. When omitted,
the mock applies the Token `defaultTarget`, then endpoint `defaultTarget`.

## Scope

Use this package to test application code that consumes a `NexusInstance`.

The mock supports unscoped or metadata-backed registrations, `create`, `select` with object `wait`, and bound `createMulticast`/snapshot `selectMulticast` fanouts. It does not simulate real target acquisition, provider-catalog negotiation, adapter connection metadata, transports, adapters, or lifecycle behavior.
