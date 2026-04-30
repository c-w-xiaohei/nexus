# Nexus Documentation

Nexus is a type-safe, default-safe framework for cross-context communication in JavaScript runtimes such as browser extensions, iframes, workers, and similar multi-context systems.

This page is the canonical landing page for product documentation.

## Start Here

If you are new to Nexus, use this path first:

1. `docs/getting-started.md`
2. `docs/concepts.md`

Then use these as needed:

- `docs/platforms.md` for runtime/adapter routing
- `docs/packages.md` for install/import choices
- `docs/auth-and-policy.md` for cross-adapter authorization policy
- `docs/node-ipc/README.md` for local daemon/client IPC over Unix sockets

If you only read one page first, read `docs/getting-started.md`.

## Choose Your Path

- I need my first working Nexus setup: start with `docs/getting-started.md`
- I need typed cross-context RPC only: continue from `docs/getting-started.md`
- I need help choosing packages or adapters: use `docs/packages.md` and `docs/platforms.md`
- I need connection/service authorization rules: use `docs/auth-and-policy.md`
- I need a local daemon process and local clients: use `docs/node-ipc/README.md`
- I need synchronized remote state: go to `docs/state/README.md`

## Product Capabilities

- Core cross-context RPC and service exposure via `@nexus-js/core`
- Platform adapters (for example, Chrome extension integration) via adapter packages such as `@nexus-js/chrome`
- Local daemon/client IPC over Unix sockets via `@nexus-js/node-ipc`
- Cross-adapter authorization policy through core `policy.canConnect` and `policy.canCall`
- Nexus State as a subsystem for synchronized remote state, built on top of core Nexus APIs

## Nexus State Subsystem Docs

Nexus State is the synchronized remote-state subsystem for Nexus.

Start in `docs/state/README.md` for the Nexus State section overview and page navigation.

The root docs explain Nexus itself. The `docs/state/` section explains one subsystem built on top of Nexus.
