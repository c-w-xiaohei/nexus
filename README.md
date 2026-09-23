<p align="center">
  <img src="./assets/nexus-banner.png" alt="Nexus" width="900" />
</p>

<p align="center"><strong>Type-safe services instead of cross-context message protocols.</strong></p>

[![Quality Check](https://github.com/c-w-xiaohei/nexus/actions/workflows/quality-check.yml/badge.svg)](https://github.com/c-w-xiaohei/nexus/actions/workflows/quality-check.yml)
[![npm](https://img.shields.io/npm/v/@nexus-js/core)](https://www.npmjs.com/package/@nexus-js/core)
[![license](https://img.shields.io/npm/l/@nexus-js/core)](https://github.com/c-w-xiaohei/nexus/blob/main/LICENSE)

Nexus connects browser extension contexts, iframes, workers, and local Node processes through one TypeScript service model. Define a contract once, expose it in one context, connect to a session, and get a typed proxy from that connection.

> **API stability:** Nexus is under rapid development. During this phase, minor
> releases may include breaking API or protocol changes; patch releases remain
> backward-compatible. This policy also applies to Core 1.x and is not the usual
> stable SemVer compatibility guarantee. Pin dependency versions and review the
> migration notes before upgrading.
>
> The authorized Core 2.0 alpha migration is an unreleased major milestone. See
> the [Core 2.0 alpha migration](https://c-w-xiaohei.github.io/nexus/docs/migrations/2.0-alpha/)
> before adopting the new connection-resource API.

## Install

Install the core runtime and the adapter for the contexts you use:

```bash
pnpm add @nexus-js/core @nexus-js/chrome
```

Use `@nexus-js/iframe` or `@nexus-js/node-ipc` for those runtimes. See [the package map](https://c-w-xiaohei.github.io/nexus/docs/packages/) for all packages and subpath exports.

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
  const connection = await nexus.connect({
    target: chromeTarget.background(),
  });
  const settings = connection.get(SettingsToken);

  await settings.setTheme("dark");
  console.log(await settings.getTheme());
}

void main();
```

Both contexts must be configured before connecting or getting services. A target is an exact adapter address supplied by application code; it is not inferred from a Token or endpoint default. An explicit target is useful whenever the destination is known, debugging, or the destination varies.

## The Target Model

Nexus separates the sources of connection information:

- Application code supplies a `ConnectionTarget`, an adapter-defined exact input for acquiring one concrete endpoint.
- The remote handshake supplies `ContextMeta`, the peer-declared product and runtime identity.
- The adapter supplies `ConnectionMeta`, local observed or verified facts for one connection.
- Core applies `where(contextMeta, connectionMeta)` to established connections.
- `ConnectionMeta` contains adapter-owned, connection-scoped observed or verified facts. It is not peer identity and is not a public target shape.
- `AdapterModel` keeps context identity, connection facts, and exact targets associated at compile time.

For unicast connection, the application supplies:

```text
 explicit ConnectionTarget, or
 no target for passive acquisition of an existing session
```

`connect({ target, where, timeout, signal })` acquires one ready shared session; `connection.get(Token)` checks its provider catalog synchronously. With a target, the adapter may dial that exact endpoint. Without a target, `connect` waits for exactly one existing matching ready session and never performs provider discovery. `connectMulticast({ targets?, where, timeout, signal })` returns a fixed snapshot: explicit targets are acquired strictly, while no targets snapshots current ready sessions and may return an empty collection.

`collection.get(Token)` returns one `{ connection, result }` entry per session, including errors for missing services. There is no aggregate multicast proxy or `expects` option. Method calls and property reads are lazy: consume them with `await`, Promise helpers, or `Nexus.safeCall`; repeated consumption shares the same execution.

`where` is applied while acquiring or selecting connections and is never re-run as a per-RPC authorization check. Use `policy.canConnect` for connection authorization and `policy.canCall` for every service or resource operation. Acquisition `timeout`/`signal` govern obtaining sessions; `callTimeout` governs later RPCs. Connection IDs identify sessions, not dialable targets.

Application code owns discovery. Querying an active tab, finding eligible frames, or choosing a set of processes is application/platform workflow that produces `ConnectionTarget` or `ConnectionTarget[]`; it is not global provider discovery performed by Nexus.

Raw proxies and remote references are session-bound. Retain the acquired
`Connection` and observe it with `onDisconnected` or `subscribeIdentity` when
application code needs session updates. After disconnect, reload, restart, or
session replacement, create a fresh handle. Nexus does not silently rebind,
retry, replay, or discover a replacement.

## Choose Your Setup

| Use case                   | Install                                 | Start here                                                            |
| -------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| Chrome extension contexts  | `@nexus-js/core` + `@nexus-js/chrome`   | [Chrome adapter](https://c-w-xiaohei.github.io/nexus/docs/chrome/)    |
| Parent page and iframe     | `@nexus-js/core` + `@nexus-js/iframe`   | [Iframe guide](https://c-w-xiaohei.github.io/nexus/docs/iframe/)      |
| Local daemon and clients   | `@nexus-js/core` + `@nexus-js/node-ipc` | [Node IPC guide](https://c-w-xiaohei.github.io/nexus/docs/node-ipc/)  |
| Worker or custom transport | `@nexus-js/core`                        | [Platform guide](https://c-w-xiaohei.github.io/nexus/docs/platforms/) |
| Remote synchronized state  | `@nexus-js/core`                        | [Nexus State](https://c-w-xiaohei.github.io/nexus/docs/state/)        |
| React integration          | `@nexus-js/core` + `@nexus-js/react`    | [React guide](https://c-w-xiaohei.github.io/nexus/docs/react/)        |
| Application unit tests     | `@nexus-js/testing`                     | [Testing guide](https://c-w-xiaohei.github.io/nexus/docs/testing/)    |

## Capabilities

- Typed RPC, callbacks, and disposable remote resources
- Connection and service authorization
- React bindings for Nexus instances and synchronized state
- Explicit resource-scoped Relay between adjacent Nexus graphs
- Custom endpoint implementations through `IEndpoint<AdapterModel>`

Nexus does not start browser contexts, inject content scripts, create iframes, spawn workers, or launch daemon processes. The application, host platform, or adapter-owned setup is responsible for context existence and discovery.

## Documentation

- [Getting started](https://c-w-xiaohei.github.io/nexus/docs/getting-started/)
- [Core concepts](https://c-w-xiaohei.github.io/nexus/docs/concepts/)
- [Identity and connection metadata](https://c-w-xiaohei.github.io/nexus/docs/identity-and-metadata/)
- [Platforms and adapters](https://c-w-xiaohei.github.io/nexus/docs/platforms/)
- [Authorization and policy](https://c-w-xiaohei.github.io/nexus/docs/auth-and-policy/)
- [React integration](https://c-w-xiaohei.github.io/nexus/docs/react/)
- [Resource-scoped Relay](https://c-w-xiaohei.github.io/nexus/docs/relay/)
- [Nexus State](https://c-w-xiaohei.github.io/nexus/docs/state/)
- [Testing](https://c-w-xiaohei.github.io/nexus/docs/testing/)
- [Documentation home](https://c-w-xiaohei.github.io/nexus/docs/)
- [Core 2.0 alpha migration](https://c-w-xiaohei.github.io/nexus/docs/migrations/2.0-alpha/)

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
