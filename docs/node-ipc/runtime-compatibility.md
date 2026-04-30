# Node IPC Runtime Compatibility

`@nexus-js/node-ipc` is a local Unix socket adapter. Runtime support depends on whether the JavaScript runtime can provide Node-compatible socket behavior.

## Node

Node is the primary target runtime.

The adapter uses Node-compatible APIs such as:

- `node:net`
- `node:path`
- `node:os`
- `node:fs/promises`

It does not use Node `child_process.fork()` IPC channels, advanced serialization, or socket-handle passing.

## Bun

Bun has Node compatibility for many `node:net` Unix socket paths. That makes the current adapter a plausible Bun compatibility path.

Treat Bun support as compatibility-mode support until the repository has Bun CI coverage.

Important boundaries:

- the adapter uses Unix sockets, not Bun's `Bun.spawn({ ipc })` channel
- it does not rely on Node child-process IPC
- it does not pass socket handles over IPC
- Bun and Node child-process IPC serialization differences are not part of this adapter path

If Bun becomes a first-class target, add Bun smoke tests that import the built package and perform a real daemon/client call under Bun.

## Linux And Unix Sockets

The adapter is Linux-first and uses filesystem Unix domain sockets.

The public address type reserves an abstract socket form, but filesystem path sockets are the supported default path for the current documentation and tests.

## Browser Bundles

This package is not a browser adapter.

Build tools may warn that the package references Node built-in modules. That is expected for a Node-only adapter. Do not import `@nexus-js/node-ipc` into browser code.

Use browser or extension adapters for browser contexts.

## Electron

Electron apps can use different IPC paths depending on process boundaries.

Use node-ipc only when a local Unix socket daemon/client model is the right fit. Do not assume it replaces Electron's built-in main/renderer IPC model.

## Related Pages

- Platform selection: `docs/platforms.md`
- Node IPC quick start: `docs/node-ipc/quick-start.md`
- Addressing: `docs/node-ipc/addressing.md`
