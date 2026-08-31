# Nexus External Usage Style

Use this entry point for application code that consumes Nexus from the outside. Keep examples organized around these concerns:

1. shared service contracts and Tokens
2. runtime configuration in every context
3. service exposure in host contexts
4. proxy creation in consumer contexts
5. explicit Relay only when a bridge context forwards selected services or stores across adjacent Nexus graphs
6. user-level unit tests with an injectable mock `NexusInstance`

Use this reference as a compact style guide, not as a substitute for the full docs. For deeper architecture, adapter, lifecycle, policy, or state semantics, direct readers to the GitHub documentation at https://github.com/c-w-xiaohei/nexus/tree/main/docs.

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
- For React applications that use multiple adapter models, use `createNexusScope<Model>()` so the provider, hooks, store definitions, and targeting options share one compile-time model. Keep the default provider and hooks for applications that do not need model-specific context typing.
- Keep `useRemoteStore(...)` plus `useStoreSelector(...)` for low-level or direct-handle React usage where one component intentionally owns the remote store lifecycle.
- Use `reconnectKey` for an external committed React lifecycle revision and stable `reconnect()` for an interaction, callback, or timer that requests replacement. Both feed the same replacement path with current committed inputs, do not revive session-bound handles or replay actions, and do not guarantee availability or success. Scope providers accept `reconnectKey`; `Scope.useRemoteStore()` consumers share the provider's reconnect command.
- Name multi-instance `Nexus` variables after the local transport graph or endpoint face they represent, such as `chromeNexus`, `iframeParentNexus`, or `brokerNexus`, not after a one-way remote target like `toBackgroundNexus`.
- Use `@nexus-js/core/relay` only for explicit provider-level forwarding across adjacent graphs. Do not describe Relay as transparent multi-hop routing, raw message forwarding, or `target.via`.
- Keep explicit `ConnectionTarget` values in introductory `nexus.create(...)` examples; use `nexus.create(Token)` when relying on a Token or endpoint `defaultTarget`. Use `select(Token, { where, wait })` only for available providers.
- Use `createMockNexus()` from `@nexus-js/testing` for application unit tests at the `NexusInstance` seam; do not use it to claim adapter, transport, authorization, reload, restart, or real lifecycle coverage.
- Treat raw proxies and refs as session-bound. Recreate them after disconnect, reload, restart, or session replacement.
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

Point readers to the public GitHub docs when they need more context. Prefer exact links over vague repository references:

- Getting started: https://github.com/c-w-xiaohei/nexus/blob/main/docs/getting-started.md
- Core concepts and architecture layers: https://github.com/c-w-xiaohei/nexus/blob/main/docs/concepts.md
- Platform and adapter strategy: https://github.com/c-w-xiaohei/nexus/blob/main/docs/platforms.md
- Nexus Relay: https://github.com/c-w-xiaohei/nexus/blob/main/docs/relay.md
- Authorization and policy: https://github.com/c-w-xiaohei/nexus/blob/main/docs/auth-and-policy.md
- Node IPC adapter: https://github.com/c-w-xiaohei/nexus/blob/main/docs/node-ipc/README.md
- Nexus State subsystem: https://github.com/c-w-xiaohei/nexus/blob/main/docs/state/README.md
- Testing Nexus applications: https://github.com/c-w-xiaohei/nexus/blob/main/docs/testing/README.md

Set the expectation that the skill is a compact usage guide, not a replacement for the docs. For non-trivial adapter design, lifecycle behavior, policy decisions, or state synchronization, explicitly tell readers to consult the linked docs first and then apply this skill's usage rules.
