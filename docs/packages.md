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

Add the Node IPC adapter only for local Node daemon/client integration:

```bash
pnpm add @nexus-js/core @nexus-js/node-ipc
```

Then choose imports:

```ts
import { connectNexusStore } from "@nexus-js/core/state";
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

## UI Binding Package

- `@nexus-js/react`
  - React bindings for Nexus State
  - Depends on `@nexus-js/core` and works with stores imported from `@nexus-js/core/state`

## Platform Adapter Package

- `@nexus-js/chrome`
  - Chrome extension adapter for endpoint wiring and context-specific setup
  - Uses `@nexus-js/core` as the underlying framework runtime

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
- Local Node daemon/client app with RPC: `@nexus-js/core` + `@nexus-js/node-ipc`

## One Common Mistake

Do not think of `@nexus-js/core/state` as a separately installed package.

It is part of the `@nexus-js/core` package surface and is imported as a subpath entrypoint.

## Next Steps

- Setup walkthrough: `docs/getting-started.md`
- Runtime/platform framing: `docs/platforms.md`
- Nexus State docs entry: `docs/state/README.md`
