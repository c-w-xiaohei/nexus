# Platforms And Contexts

Nexus provides one programming model across multiple JavaScript execution contexts. You define contracts once, expose services in one context, and call them from another context through typed proxies.

## Typical Context Pairs

- Browser extension background <-> content script
- Main window <-> iframe
- Main thread <-> web worker
- Electron process boundaries via suitable transport wiring

## Adapter Strategy

- `@nexus-js/core` contains the core transport-agnostic API and runtime
- Adapter packages provide platform-specific endpoint setup and conventions
- `@nexus-js/chrome` is the dedicated adapter for Chrome extension contexts
- `@nexus-js/node-ipc` is the local Node process adapter for Linux filesystem Unix sockets

Today, the repository ships first-party Chrome and Node IPC adapters. Other environments use the core model plus custom endpoint wiring.

## Choosing A Platform Entry

Use this decision rule:

1. Always start with `@nexus-js/core`
2. If your environment has a first-party adapter, use it
3. If it does not, provide your own endpoint implementation through the core APIs
4. Add subsystem entrypoints only after the base Nexus path works

### Chrome Extension

Use:

- `@nexus-js/core`
- `@nexus-js/chrome`

This is the clearest path if your app has background/content-script/popup/options-style contexts.

If that matches your environment, start here before reading subsystem docs.

Next step: use the Chrome adapter README/examples first, then return to `docs/getting-started.md` or `docs/state/README.md` depending on whether you need plain RPC or state sync.

### Worker / iframe / custom runtime

Start with `@nexus-js/core`, then wire your own endpoint implementation and metadata through `configure({ endpoint })` or the endpoint decorator path.

This route is lower-level, but it is the right one when no first-party adapter exists for your environment.

If you use the decorator path directly, remember that decorator registrations are process-global. Multi-instance setups should prefer explicit `configure({ endpoint, services })` input.

Next step: implement a minimal `IEndpoint`, configure it through `nexus.configure({ endpoint })`, then follow `docs/getting-started.md` for the rest of the bootstrap flow.

### Local Node Daemon / CLI

Use:

- `@nexus-js/core`
- `@nexus-js/node-ipc`

This path targets one local daemon process and one or more local Node clients. The adapter maps Nexus daemon descriptors to Unix socket paths, applies optional shared-secret pre-auth, frames binary L1 packets over the socket stream, and then lets core `policy.canConnect` / `policy.canCall` make authorization decisions.

Important behavior:

- Default socket paths resolve to `$XDG_RUNTIME_DIR/nexus/<appId>/<instance>.sock` or `/tmp/nexus-<uid>/<appId>/<instance>.sock` when `XDG_RUNTIME_DIR` is absent.
- Custom address resolvers can override that mapping, but a resolver returning `null` is an explicit address failure.
- Runtime directories should be user-private, and stale socket cleanup must not unlink a live daemon socket.
- Platform metadata currently reports adapter facts such as socket address and shared-secret auth status. It does not claim OS-verified peer `pid`, `uid`, or `gid` unless peer credential support is implemented.
- Proxies and refs are session-bound. A daemon restart or socket disconnect invalidates old proxies; callers must reconnect and call `create()` again.

Next step: read `packages/node-ipc/README.md` for node-ipc addressing, auth, framing, error codes, and public types.

### When To Add Nexus State

Add `Nexus State` only after:

- endpoint configuration works
- a service can be exposed
- a proxy can be created
- a basic remote method call succeeds

At that point, adding `Nexus State` is a layering decision, not a bootstrap requirement.

## Related Guides

- Product docs landing: `docs/README.md`
- Package map and install choices: `docs/packages.md`
- Nexus State subsystem docs: `docs/state/README.md`
