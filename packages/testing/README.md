# @nexus-js/testing

User-level unit testing utilities for Nexus applications.

For the full guide, read the [testing documentation](https://c-w-xiaohei.github.io/nexus/docs/testing/).

## Install

```bash
pnpm add -D @nexus-js/testing
```

## Main API

- `createMockNexus()`

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

const connection = await mock.nexus.connect({
  target: { context: "background" },
});
const proxy = connection.get(SettingsToken);

await expect(proxy.getSettings()).resolves.toEqual({ theme: "dark" });
```

`target` is an exact target object for the adapter model under test. When omitted,
the mock models passive acquisition of an existing matching ready connection; it
does not discover providers.

## Scope

Use this package to test application code that consumes a `NexusInstance`.

The mock supports unscoped or metadata-backed registrations, `connect`,
`safeConnect`, connection observation, and fixed connection collections whose
`get` method returns per-connection Results. It does not simulate real target
acquisition, provider-catalog negotiation, adapter connection metadata,
transports, adapters, or lifecycle behavior.
