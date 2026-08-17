# Nexus

**Type-safe services instead of cross-context message protocols.**

[![Quality Check](https://github.com/c-w-xiaohei/nexus/actions/workflows/quality-check.yml/badge.svg)](https://github.com/c-w-xiaohei/nexus/actions/workflows/quality-check.yml)
[![npm](https://img.shields.io/npm/v/@nexus-js/core)](https://www.npmjs.com/package/@nexus-js/core)
[![license](https://img.shields.io/npm/l/@nexus-js/core)](https://github.com/c-w-xiaohei/nexus/blob/main/LICENSE)

Nexus connects browser extension contexts, iframes, workers, and local Node processes through one TypeScript service model. Define a contract once, expose it in one context, and create a typed proxy from another context.

## Install

Install the core runtime and the adapter for the contexts you use:

```bash
pnpm add @nexus-js/core @nexus-js/chrome
```

Use `@nexus-js/iframe` or `@nexus-js/node-ipc` for those runtimes. See [the package map](docs/packages.md) for all packages and subpath exports.

## Quick Start

Put the service contract and token in code shared by both contexts:

```ts
// shared/settings.ts
import { Token } from "@nexus-js/core";

export interface SettingsService {
  getTheme(): Promise<"light" | "dark">;
  setTheme(theme: "light" | "dark"): Promise<void>;
}

export const SettingsToken = new Token<SettingsService>("example:settings");
```

Expose the service from the background context:

```ts
// background.ts
import { usingBackgroundScript } from "@nexus-js/chrome";
import { SettingsToken, type SettingsService } from "./shared/settings";

const settings: SettingsService = {
  async getTheme() {
    const result = await chrome.storage.local.get("theme");
    return result.theme === "dark" ? "dark" : "light";
  },
  async setTheme(theme) {
    await chrome.storage.local.set({ theme });
  },
};

usingBackgroundScript().provide(SettingsToken, settings);
```

Configure the consumer and connect to one exact endpoint:

```ts
// content.ts
import { nexus } from "@nexus-js/core";
import { chromeTarget, usingContentScript } from "@nexus-js/chrome";
import { SettingsToken } from "./shared/settings";

usingContentScript();

async function main() {
  const settings = await nexus.create(SettingsToken, {
    target: chromeTarget.background(),
  });

  await settings.setTheme("dark");
  console.log(await settings.getTheme());
}

void main();
```

Both contexts must be configured before creating proxies. `usingContentScript()` supplies `chromeTarget.background()` as its endpoint `defaultTarget`, so the usual content-to-background call can be `nexus.create(SettingsToken)`. An explicit target is useful while debugging or when the destination varies.

## The Target Model

Nexus separates the sources of connection information:

- Application code supplies a `ConnectionTarget`, an adapter-defined exact input for acquiring one concrete endpoint.
- The remote handshake supplies `ContextMeta`, the peer-declared product and runtime identity.
- The adapter supplies `ConnectionMeta`, local observed or verified facts for one connection.
- Core applies `where(contextMeta, connectionMeta)` to established connections.
- `ConnectionMeta` contains adapter-owned, connection-scoped observed or verified facts. It is not peer identity and is not a public target shape.
- `AdapterModel` keeps context identity, connection facts, and exact targets associated at compile time.

For unicast creation, resolution is:

```text
explicit ConnectionTarget
-> Token defaultTarget
-> endpoint defaultTarget
-> targeting error
```

`create` and `createMulticast` acquire exact targets, then bind the resulting sessions. `createMulticast` requires a non-empty `targets` array and fails the whole acquisition if any target cannot be acquired. Its `expects: "all"` (default) and `expects: "stream"` calls settle each result as `{ status, value }` or `{ status, reason }`, without connection IDs or `from` metadata. Connection IDs are not public acquisition inputs, selection keys, routing targets, or multicast result fields. `select` chooses one available provider without connecting, optionally waiting with `{ wait: { timeout, signal } }`; `selectMulticast` has no `wait`, binds the current provider snapshot, and may validly return an empty fanout. Acquisition `timeout`/`signal` apply to `create` and `createMulticast`; `callTimeout` applies to later proxy calls. Unknown option keys, invalid timeout values, aborts, and incompatible provider-catalog protocols produce structured usage, targeting, or protocol errors. `defaultTarget` only supplies `create` target resolution and never preconnects.

Application code owns discovery. Querying an active tab, finding eligible frames, or choosing a set of processes is application/platform workflow that produces `ConnectionTarget` or `ConnectionTarget[]`; it is not global provider discovery performed by Nexus.

Raw proxies and remote references are session-bound. After disconnect, reload, restart, or session replacement, create a fresh handle. Nexus does not silently rebind, retry, replay, or discover a replacement.

## Choose Your Runtime

| Use case                        | Install                                 | Start here                                           |
| ------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| Chrome extension contexts       | `@nexus-js/core` + `@nexus-js/chrome`   | [Chrome adapter](docs/platforms.md#chrome-extension) |
| Parent page and iframe          | `@nexus-js/core` + `@nexus-js/iframe`   | [Iframe guide](docs/iframe/README.md)                |
| Local daemon and clients        | `@nexus-js/core` + `@nexus-js/node-ipc` | [Node IPC guide](docs/node-ipc/README.md)            |
| Worker or custom transport      | `@nexus-js/core`                        | [Platform guide](docs/platforms.md)                  |
| Remote synchronized state       | `@nexus-js/core`                        | [Nexus State](docs/state/README.md)                  |
| React bindings for remote state | `@nexus-js/core` + `@nexus-js/react`    | [React guide](docs/state/react.md)                   |
| Application unit tests          | `@nexus-js/testing`                     | [Testing guide](docs/testing/README.md)              |

## Capabilities

- Typed RPC, callbacks, and disposable remote resources
- Connection and service authorization
- Synchronized remote state and React bindings
- Explicit provider-level Relay between adjacent Nexus graphs
- Custom endpoint implementations through `IEndpoint<AdapterModel>`

Nexus does not start browser contexts, inject content scripts, create iframes, spawn workers, or launch daemon processes. The application, host platform, or adapter-owned setup is responsible for context existence and discovery.

## Documentation

- [Getting started](docs/getting-started.md)
- [Core concepts](docs/concepts.md)
- [Identity and connection metadata](docs/identity-and-metadata.md)
- [Platforms and adapters](docs/platforms.md)
- [Authorization and policy](docs/auth-and-policy.md)
- [Nexus Relay](docs/relay.md)
- [Nexus State](docs/state/README.md)
- [Testing](docs/testing/README.md)
- [Documentation home](docs/README.md)

## Repository Development

```bash
git clone https://github.com/c-w-xiaohei/nexus.git
cd nexus
pnpm install -w
pnpm build
pnpm test
```

## License

MIT
