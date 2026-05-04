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
- `@nexus-js/iframe` is the dedicated adapter for parent window <-> iframe contexts
- `@nexus-js/node-ipc` is the local Node process adapter for Linux filesystem Unix sockets

Today, the repository ships first-party Chrome, iframe, and Node IPC adapters. Other environments use the core model plus custom endpoint wiring.

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

### Iframe

Use:

- `@nexus-js/core`
- `@nexus-js/iframe`

This path targets a parent browser window and one or more iframe children. The adapter maps each frame to Nexus descriptors, routes connections over iframe `postMessage`, and applies source window, exact origin, app id, channel, and optional nonce transport gates before core authorization policies run.

Important behavior:

- Parent code should register each iframe with a stable `frameId`, the `HTMLIFrameElement`, and the expected child `origin`.
- Child code must configure the expected `parentOrigin`.
- `origin` and `parentOrigin` must match the browser origin exactly, including scheme, host, and port.
- Avoid `allowAnyOrigin: true` unless the iframe content is intentionally public and core policy still restricts access.
- Proxies and refs are session-bound. Iframe reloads replace the child session, so callers must call `create()` again after reload or reconnect.

Next step: read `docs/iframe/README.md` for parent/child setup, targeting, security notes, and lifecycle behavior.

### Worker / custom runtime

Start with `@nexus-js/core`, then wire your own endpoint implementation and metadata through `configure({ endpoint })` or an instance-bound endpoint decorator such as `@nexus.Endpoint(...)`.

This route is lower-level, but it is the right one when no first-party adapter exists for your environment.

If you use the decorator path directly, bind decorators to the Nexus instance that owns the local endpoint face. The default singleton can use `@nexus.Endpoint(...)` / `@nexus.Expose(...)`; multi-instance setups should use instance-specific forms such as `@brokerNexus.Endpoint(...)` and `@brokerNexus.Expose(...)`. Keep `configure({ services })` for bootstrap bulk composition or low-level compatibility only.

Next step: implement a minimal `IEndpoint`, configure it through `nexus.configure({ endpoint })`, then follow `docs/getting-started.md` for the rest of the bootstrap flow.

### Bridge Contexts With Multiple Transports

Some runtimes need to bridge two separate Nexus transport graphs. A Chrome extension background service is a common example: it may talk to extension contexts through the Chrome adapter and to a local broker through a browser-compatible transport.

Use two explicit `Nexus` instances in that runtime:

- one instance for extension-internal contexts
- one instance for the local broker transport
- explicit endpoint configuration on both instances
- provider registration through `.provide(...)` or instance-bound decorators such as `@brokerNexus.Expose(...)`
- no top-level singleton shorthand `@Expose(...)` or `@Endpoint(...)`; bind decorators to the owning instance instead

Name these instances after the local graph or endpoint face they represent,
such as `extensionNexus`, `chromeNexus`, `iframeParentNexus`, or
`brokerNexus`. Avoid names such as `toBackgroundNexus` or `backgroundNexus`
for an instance running in a content script; the instance represents the local
face in a transport graph, not a one-way direction to a remote context.

Then publish a gateway provider on one instance and implement it by calling services through the other instance. Nexus does not merge the two connection graphs automatically.

When the gateway should forward an existing service contract or Nexus State store, use `@nexus-js/core/relay`. Relay registers an ordinary provider on one graph and forwards through another `Nexus` instance with explicit `forwardThrough` and `forwardTarget` options. It is not a `target.via` tunnel and does not forward raw Nexus messages. See `docs/relay.md`.

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

Next step: read `docs/node-ipc/README.md` for node-ipc setup, addressing, adapter pre-auth, framing, lifecycle, and error behavior. Use `docs/auth-and-policy.md` for cross-adapter authorization policy and `packages/node-ipc/README.md` when you need the package export surface.

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
- Authorization and policy: `docs/auth-and-policy.md`
- Nexus Relay: `docs/relay.md`
- Iframe adapter docs: `docs/iframe/README.md`
- Node IPC adapter docs: `docs/node-ipc/README.md`
- Nexus State subsystem docs: `docs/state/README.md`
