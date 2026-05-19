# Node IPC Documentation

`@nexus-js/node-ipc` connects local daemon and client processes through filesystem Unix domain sockets. Use it when one long-lived local process exposes Nexus services and one or more local clients call those services.

This section covers the adapter-specific behavior. For authorization hooks shared by all adapters, read `docs/auth-and-policy.md`.

## Start Here

- New setup: `docs/node-ipc/quick-start.md`
- Mental model: `docs/node-ipc/concepts.md`
- Socket path rules: `docs/node-ipc/addressing.md`
- Adapter pre-auth: `docs/node-ipc/auth.md`
- Daemon restart and errors: `docs/node-ipc/lifecycle-and-errors.md`
- Node and Bun runtime notes: `docs/node-ipc/runtime-compatibility.md`
- Test guidance: `docs/node-ipc/testing.md`

## Package Routing

- Foundation runtime: `@nexus-js/core`
- Local IPC adapter: `@nexus-js/node-ipc`

Install both in daemon and client packages:

```bash
pnpm add @nexus-js/core @nexus-js/node-ipc
```

## When To Use It

Use node-ipc when your application has:

- one local daemon process that owns services
- one or more local clients, such as CLIs or helper processes
- same-machine communication only
- a Unix socket path that can represent the daemon instance

Do not use it for browser contexts, cross-machine networking, or long-lived handles that must survive daemon restarts without being recreated.

## What The Adapter Provides

- daemon and client factory helpers
- default socket address resolution
- custom address resolvers
- filesystem Unix socket server and client endpoints
- binary packet framing over socket streams
- optional shared-secret pre-auth
- runtime directory and stale socket safety checks
- node-ipc metadata and matcher helpers

## What Core Still Owns

The adapter does not replace core Nexus behavior.

Core still owns:

- tokens and service contracts
- service exposure
- proxy creation
- target resolution
- logical connection handshake
- `policy.canConnect` and `policy.canCall`
- resource reference lifecycle
- session-bound proxy semantics

## Runtime Scope

The adapter is Linux-first and uses filesystem Unix domain sockets through Node-compatible socket APIs.

It is intended for Node runtimes first. Bun can run many Node-compatible `node:net` Unix socket paths, but Bun support should be treated as compatibility-mode support until the project has Bun CI coverage. The adapter does not use Node `child_process` IPC channels or socket-handle passing.

## Testing Boundary

Use `@nexus-js/testing` and `createMockNexus()` for unit tests of application code that consumes daemon services through a `NexusInstance`.

Do not use the mock to validate node-ipc adapter behavior. It does not exercise Unix socket addressing, filesystem permissions, packet framing, shared-secret pre-auth, stale socket cleanup, daemon close/recreate behavior, or real disconnect timing.

Use `docs/node-ipc/testing.md` for adapter and real socket integration testing guidance.

## Related Pages

- Product docs landing: `docs/README.md`
- Package map: `docs/packages.md`
- Platform selection: `docs/platforms.md`
- Testing application code: `docs/testing/README.md`
- Shared authorization policy: `docs/auth-and-policy.md`
