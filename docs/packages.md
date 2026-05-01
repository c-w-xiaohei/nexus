# Nexus Package Map

Use this page to choose the right Nexus package set for your application.

The key distinction is:

- packages are things you install
- subpath entrypoints are things you import from an installed package

## Quick Package Choice

- Start with `@nexus-js/core` in all Nexus applications
- Use the `@nexus-js/core/state` entrypoint when you need synchronized remote state
- Add `@nexus-js/react` only when your UI is React and uses Nexus State hooks
- Add `@nexus-js/chrome` when building a Chrome extension integration
- Add `@nexus-js/iframe` when connecting a parent window and iframe over `postMessage`
- Add `@nexus-js/node-ipc` when connecting local Node daemon and client processes over Unix sockets

If you are unsure, start with `@nexus-js/core`, make one service call work, then add adapters or subsystem entrypoints only where your use case actually needs them.

## Install Patterns

Most common installs:

```bash
pnpm add @nexus-js/core
```

Add React bindings only if you use Nexus State from React:

```bash
pnpm add @nexus-js/core @nexus-js/react
```

Add the Chrome adapter only for Chrome extension integration:

```bash
pnpm add @nexus-js/core @nexus-js/chrome
```

Add the iframe adapter only for parent window <-> iframe integration:

```bash
pnpm add @nexus-js/core @nexus-js/iframe
```

Add the Node IPC adapter only for local Node daemon/client integration:

```bash
pnpm add @nexus-js/core @nexus-js/node-ipc
```

Then choose imports:

```ts
import { connectNexusStore } from "@nexus-js/core/state";
import { VirtualPortRouter } from "@nexus-js/core/transport/virtual-port";
```

## Core Package

- `@nexus-js/core`
  - Product foundation for cross-context communication
  - Includes contract tokens, service exposure, remote proxy creation, and core runtime APIs

## Subsystem Subpath Entrypoint

- `@nexus-js/core/state`
  - Nexus State headless runtime subpath entrypoint exposed by `@nexus-js/core`
  - Provides remote store definition, hosting, connection, lifecycle, and dispatch semantics
  - This is a subsystem capability layered on top of `@nexus-js/core`, not a separately installed package

- `@nexus-js/core/transport`
  - Core transport types and helpers for adapter authors
  - This is an advanced package surface; most application code should use first-party adapters instead

- `@nexus-js/core/transport/virtual-port`
  - Virtual port router for multiplexing Nexus ports over message-bus style transports
  - Used by `@nexus-js/iframe` to carry Nexus connections over iframe `postMessage`
  - Prefer the iframe adapter unless you are implementing a transport adapter yourself

## UI Binding Package

- `@nexus-js/react`
  - React bindings for Nexus State
  - Depends on `@nexus-js/core` and works with stores imported from `@nexus-js/core/state`

## Platform Adapter Package

- `@nexus-js/chrome`
  - Chrome extension adapter for endpoint wiring and context-specific setup
  - Uses `@nexus-js/core` as the underlying framework runtime

- `@nexus-js/iframe`
  - Browser iframe adapter for parent window <-> iframe RPC over `postMessage`
  - Provides parent/child endpoint setup, iframe descriptors, origin and optional nonce transport gates, and virtual-port routing
  - Uses `@nexus-js/core` as the underlying framework runtime and `@nexus-js/core/transport/virtual-port` internally

- `@nexus-js/node-ipc`
  - Local Node process adapter for daemon/client IPC over Linux filesystem Unix sockets
  - Use it when one local daemon process exposes Nexus services to one or more local Node clients
  - Provides socket address resolution, optional shared-secret pre-auth, and binary L1 packet framing before core authorization policies run
  - Uses `@nexus-js/core` as the underlying framework runtime

## Common Combinations

- Core RPC only: `@nexus-js/core`
- Headless synchronized state: install `@nexus-js/core`, import from `@nexus-js/core/state`
- React with Nexus State: install `@nexus-js/core` + `@nexus-js/react`, import state APIs from `@nexus-js/core/state`
- Chrome extension app with RPC: `@nexus-js/core` + `@nexus-js/chrome`
- Parent window and iframe app with RPC: `@nexus-js/core` + `@nexus-js/iframe`
- Local Node daemon/client app with RPC: `@nexus-js/core` + `@nexus-js/node-ipc`

## One Common Mistake

Do not think of `@nexus-js/core/state` as a separately installed package.

It is part of the `@nexus-js/core` package surface and is imported as a subpath entrypoint. The same is true for `@nexus-js/core/transport` and `@nexus-js/core/transport/virtual-port`.

## Next Steps

- Setup walkthrough: `docs/getting-started.md`
- Runtime/platform framing: `docs/platforms.md`
- Authorization and policy: `docs/auth-and-policy.md`
- Iframe guide: `docs/iframe/README.md`
- Node IPC guide: `docs/node-ipc/README.md`
- Nexus State docs entry: `docs/state/README.md`
