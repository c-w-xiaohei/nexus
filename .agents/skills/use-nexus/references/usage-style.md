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
- Prefer `TokenSpace` for hierarchical token IDs and repeated default targeting intent.
- Configure every runtime context before exposing services or creating proxies.
- Prefer adapter helpers for standard runtimes; use `nexus.configure(...)` for composition, custom endpoints, policy, descriptors, matchers, or explicit services.
- Use explicit service registration instead of decorators for multi-instance runtimes and isolated tests.
- Name multi-instance `Nexus` variables after the local transport graph or endpoint face they represent, such as `chromeNexus`, `iframeParentNexus`, or `brokerNexus`, not after a one-way remote target like `toBackgroundNexus`.
- Use `@nexus-js/core/relay` only for explicit provider-level forwarding across adjacent graphs. Do not describe Relay as transparent multi-hop routing, raw message forwarding, or `target.via`.
- Use `createMockNexus()` from `@nexus-js/testing` for application unit tests at the `NexusInstance` seam; do not use it to claim adapter, transport, authorization, reload, restart, or real lifecycle coverage.
- Pass an options object to `nexus.create(...)`; keep explicit targets in introductory examples.
- Treat raw proxies and refs as session-bound. Recreate them after disconnect, reload, restart, or session replacement.

## Focused References

- `references/shared-contracts.md` - service interfaces, `TokenSpace`, Token defaults, and service exposure style
- `references/runtime-configuration.md` - adapter helpers, direct `nexus.configure(...)`, multi-instance runtimes, and composition rules
- `references/targeting-and-proxies.md` - `nexus.create(...)`, target resolution, descriptors, matchers, proxies, and refs
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
