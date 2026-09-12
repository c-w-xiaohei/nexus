# Nexus External Usage Style

Use this entry point for application code that consumes Nexus from the outside. Keep examples organized around these concerns:

1. shared service contracts and Tokens
2. runtime configuration in every context
3. service exposure in host contexts
4. proxy creation in consumer contexts
5. explicit Relay only when a bridge context forwards selected services or stores across adjacent Nexus graphs
6. user-level unit tests with an injectable mock `NexusInstance`

Use this reference as a compact style guide, not as a substitute for the full docs. For deeper architecture, adapter, lifecycle, policy, or state semantics, direct readers to the published documentation at https://c-w-xiaohei.github.io/nexus/docs/.

Keep adapter docs focused on adapter-specific setup. Do not redefine the full service contract pattern unless the topic is shared contracts.

## Architecture And Boundaries

Nexus itself is about connection semantics between runtime contexts that already exist. It does not launch browser contexts, inject content scripts, create iframes, spawn workers, or start daemon processes for the application. The host platform, framework, application, or adapter-specific environment owns context startup.

Use this architecture model when explaining why configuration and adapter boundaries matter:

1. transport / endpoint layer: `IPort`, `IEndpoint`, serializers, port processing
2. connection and routing layer: logical handshake, identity, policy, targeting, lifecycle
3. service / proxy / resource layer: exposed services, proxy calls, refs, pending calls
4. product-facing API layer: `nexus.configure(...)`, `nexus.create(...)`, `nexus.ref(...)`, adapter helpers, Relay helpers

Adapters provide or compose endpoint wiring for the current context. Core then builds logical connections over the `IPort`-like channels returned by those endpoints. For bus-style transports such as `window.postMessage`, adapt the shared bus into reliable point-to-point `IPort` semantics before handing it to core.

## Core Rules

- Put service interfaces and Tokens in shared modules imported by every host and consumer context.
- Use shared `Token<Service>` without a default target for contracts used by multiple adapter models. A model-bound `Token<Service, Model>` or `TokenSpace<Model>` may carry `defaultTarget`; an unbound Token remains portable.
- Import service interfaces with `import type` when defining Tokens; do not repeat anonymous service shapes inline.
- Configure every runtime context from main/bootstrap/runtime modules before creating proxies or other demand operations. Register static class/providers before the bootstrap snapshot, or use live `provide(...)` after `ready`.
- Prefer adapter helpers for standard runtimes; use `nexus.configure(...)` for composition, custom endpoints, policy, or bootstrap bulk configuration.
- For class-style services, import the concrete runtime instance and use `@xxNexus.Expose(Token)`.
- For function/object-style providers, helper outputs, State, Relay, and already constructed instances, import the concrete runtime instance and use `xxNexus.provide(...)`.
- For React Nexus State subtree sharing, prefer `createRemoteStoreScope(...)` from `@nexus-js/react`: let the scope provider manage one shared `RemoteStore` handle, and let leaf components consume `useSelector`, `useActions`, `useStatus`, and `useError` from that scope.
- For React applications that use multiple adapter models, use `createNexusScope<Model>()` so the provider, hooks, StoreTokens, and targeting options share one compile-time model. Keep the default provider and hooks for applications that do not need model-specific context typing.
- Keep `useRemoteStore(...)` for low-level ownership. A child rendered only after a concrete handle exists may select it with `useStore(remote.store, selector)` imported from `zustand`, not Nexus. Direct and scoped selectors follow Zustand 5 snapshot stability rules.
- `useRemoteStore` exposes `{ store, pending, error, reconnect }`, not live status. Observe lifecycle with `useStoreStatus(store, selector?)` or `Scope.useStatus(selector?)`, which return `null` without a handle and during SSR. Select `status.type` when versions are irrelevant. React replacement destroys the old handle without retaining a stale session; acquisition errors are not later transport errors.
- Use `reconnectKey` for an external committed React lifecycle revision and stable `reconnect()` for an interaction, callback, or timer that requests replacement. Both feed the same replacement path with current committed inputs, do not revive session-bound handles or replay actions, and do not guarantee availability or success. Scope providers accept `reconnectKey`; `Scope.useRemoteStore()` consumers share the provider's reconnect command.
- Name multi-instance `Nexus` variables after the local transport graph or endpoint face they represent, such as `chromeNexus`, `iframeParentNexus`, or `brokerNexus`, not after a one-way remote target like `toBackgroundNexus`.
- Use `@nexus-js/core/relay` only for explicit provider-level forwarding across adjacent graphs. Do not describe Relay as transparent multi-hop routing, raw message forwarding, or `target.via`.
- Keep explicit `ConnectionTarget` values in introductory `nexus.create(...)` examples; use `nexus.create(Token)` when relying on a Token or endpoint `defaultTarget`. Use `select(Token, { where, wait })` only for available providers.
- Use `createMockNexus()` from `@nexus-js/testing` for application unit tests at the `NexusInstance` seam; do not use it to claim adapter, transport, authorization, reload, restart, or real lifecycle coverage.
- Treat raw proxies and refs as session-bound. Recreate them after disconnect, reload, restart, or session replacement.
- For Nexus State hosts, use `createNexusStore(token, nativeCreator, options)` or `bindNexusStore(token, existingStore, options)`. Require a pure complete `snapshot` projection and runtime `expose` allowlist, and preserve the returned original Zustand API for local synchronous actions. Publication uses a fixed 200ms default window and 32 pending-snapshot default; it is not debounce, transaction, rollback, receipt/waiter, queue, middleware, or automatic retry behavior.
- Observe an existing ordinary unicast root proxy with static `Nexus.getProxyStatus(proxy)` and `Nexus.subscribeProxyStatus(proxy, listener)`. The listener synchronously receives the current snapshot and later distinct snapshots; the subscription neither releases nor recovers the proxy. React code can use `useProxyStatus(proxy, selector?)` from `@nexus-js/react` without a Provider.
- Status applies only to same-Core exact unicast roots. A stale proxy remains callable, while disconnected is terminal for that session. The application owns explicit replacement acquisition, retry, retargeting, and replay policy.
- Do not add consumer-side import shims, preload wrappers, or dynamic-import facades around `@nexus-js/react` unless you have verified a published package import-time compatibility bug. The normal expectation is that static imports from `@nexus-js/react` work directly.

## Focused References

- `references/shared-contracts.md` - service interfaces, `TokenSpace`, Token defaults, and service exposure style
- `references/runtime-configuration.md` - adapter helpers, direct `nexus.configure(...)`, multi-instance runtimes, and composition rules
- `references/targeting-and-proxies.md` - `nexus.create(...)`, `nexus.select(...)`, multicast snapshots, `where`, proxies, and refs
- `references/adapter-node-ipc.md` - node-ipc daemon/client setup, `configure: false`, auth gates, and default-target routing
- `references/adapter-iframe.md` - iframe parent/child setup, origin checks, nonce usage, heartbeat, reconnect, and session-bound handles
- `references/policy-and-lifecycle.md` - core policy, authorization style, lifecycle expectations, and documentation style
- `references/testing.md` - user-level unit testing with `createMockNexus()` and boundaries

## GitHub Documentation

Point readers to the published docs when they need more context. Prefer exact links over vague repository references:

- Getting started: https://c-w-xiaohei.github.io/nexus/docs/getting-started/
- Core concepts and architecture layers: https://c-w-xiaohei.github.io/nexus/docs/concepts/
- Platform and adapter strategy: https://c-w-xiaohei.github.io/nexus/docs/platforms/
- Nexus Relay: https://c-w-xiaohei.github.io/nexus/docs/relay/
- Authorization and policy: https://c-w-xiaohei.github.io/nexus/docs/auth-and-policy/
- Node IPC adapter: https://c-w-xiaohei.github.io/nexus/docs/node-ipc/
- Nexus State subsystem: https://c-w-xiaohei.github.io/nexus/docs/state/
- Testing Nexus applications: https://c-w-xiaohei.github.io/nexus/docs/testing/

Set the expectation that the skill is a compact usage guide, not a replacement for the docs. For non-trivial adapter design, lifecycle behavior, policy decisions, or state synchronization, explicitly tell readers to consult the linked docs first and then apply this skill's usage rules.
