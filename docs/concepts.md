# Nexus Concepts

This page explains product-level Nexus concepts. For synchronized state semantics, use the Nexus State concepts guide at `docs/state/concepts.md`.

## What Nexus Actually Does

Nexus is more than "RPC over a transport".

It provides one consistent model for:

- runtime identity
- service exposure
- proxy creation
- target resolution
- connection lifecycle
- identity updates over time

The transport is only one layer of the system.

## Contracts And Runtime Identity

Nexus separates compile-time service shape from runtime identity:

- `Token<T>` is a typed key for a service contract and its runtime identity
- shared contracts can be imported by multiple contexts
- consumers create remote proxies from the token, not concrete classes

## Expose In One Context, Consume In Another

The core Nexus model is:

1. define a contract and token in shared code
2. configure the local Nexus face with `configure()` or an adapter helper
3. publish a provider on that face with `@nexus.Expose(...)` or `provide(...)`
4. create and call a session-bound typed proxy from another context

This gives local-like API ergonomics while preserving explicit cross-context boundaries.

Formal API roles:

- `configure()` configures the local Nexus face: endpoint, identity, policy, descriptors, matchers, and bootstrap composition.
- `@nexus.Expose(...)` and `provide(...)` publish providers on that local face.
- `create()` discovers a session-bound remote handle using the call site's target resolution rules.

## Session-Bound Proxies And Connection-Bound References

Nexus handles are intentionally scoped to runtime lifecycle boundaries.

- `nexus.create()` returns a unicast proxy bound to the resolved remote session
- `nexus.ref()` returns a local wrapper for reference passing; the connection-bound transient capability is the remote resource proxy materialized after transport crossing

These are not immortal objects.

If the remote session is replaced or the connection is lost:

- existing `create()` proxies should be treated as invalid for new work
- existing remote resource capabilities reached via refs are transient and should be reacquired on a new connection

Target handoff does not mutate existing raw handles.

- an already-created raw `nexus.create()` proxy stays pinned to the live session/connection it resolved at creation time
- a remote capability proxy materialized from `nexus.ref()` crossing also stays pinned to that same original connection scope
- later matcher/identity changes can change which endpoint future targeting resolves to, but they do not auto-retarget already-created raw handles

Nexus keeps these boundaries explicit so applications can reason about ownership, cleanup, and failure behavior without hidden rebinding.

## Raw Core vs Higher-Layer Rebuild

Raw core handles and higher-layer orchestration have different jobs.

- raw core: `create()` proxies and remote capabilities are lifecycle-scoped and become invalid across session/connection replacement
- higher layers (state orchestration, React hooks, app services): detect lifecycle boundaries and build replacement handles

Higher-layer rebuild does not mean raw handles auto-heal. It means your app creates new handles/capabilities for new lifecycle scopes.

Concrete transient capability reacquire example:

1. Context A calls a service method and receives a callback/reference wrapper via `nexus.ref()` semantics.
2. Context B uses that remote callback capability while the current connection is alive.
3. The connection drops and re-establishes with a new identity/scope.
4. Context A must pass a fresh ref/callback again so Context B obtains a new remote capability proxy for the new connection.

Reusing the old capability after step 3 is not valid.

## Startup And Configuration

Before you can create useful proxies, the current context must be configured.

In practice, Nexus startup always includes:

1. endpoint registration
2. endpoint identity metadata

That is why `configure()` matters at the product level.

Nexus does not infer the current context magically. It needs an endpoint implementation and metadata in order to route and accept connections.

Provider registration is optional at the level of a single context boot. It becomes necessary when you want that context to expose callable services to others. Use `@nexus.Expose(...)` for class declarations and `provide(...)` for object, function, State, Relay, or live providers.

Decorator factories are bound to the Nexus instance captured by the decorator expression. `@nexus.Expose(...)` and `@nexus.Endpoint(...)` bind to the default singleton; `@specificNexus.Expose(...)` and `@specificNexus.Endpoint(...)` bind to that specific instance. Top-level `@Expose(...)` and `@Endpoint(...)` remain compatibility shorthand for the default singleton, not the new multi-instance authoring path.

## Multiple Nexus Instances In One Runtime

One JavaScript context can host more than one isolated `Nexus` instance. Use this when the same runtime bridges different transport graphs, such as a Chrome extension background service that talks to content scripts through the Chrome adapter and to a local broker through another adapter.

Use separate instances:

```ts
import { Nexus } from "@nexus-js/core";

const extensionNexus = new Nexus<ExtensionUserMeta, ExtensionPlatformMeta>();
const brokerNexus = new Nexus<BrokerUserMeta, BrokerPlatformMeta>();
```

Name multi-instance variables after the local transport graph or endpoint face
they represent, not after a remote target. For example, prefer
`chromeNexus`, `iframeParentNexus`, or `brokerNexus` over
`toBackgroundNexus` or `backgroundNexus` when the instance actually runs in a
content script. A `Nexus` instance is a local endpoint face with its own
identity, policy, services, connections, proxies, and refs; it is not a
one-way client for a single destination.

Each instance has its own endpoint, metadata, policy, services, connections, proxies, and refs. They do not automatically share a connection graph.

Do not use top-level singleton shorthand `@Expose(...)` or `@Endpoint(...)` with this pattern. Configure endpoints explicitly, publish object providers with instance-local `provide(...)`, and bind class services or endpoint decorators to the owning instance with forms such as `@extensionNexus.Expose(...)` or `@brokerNexus.Endpoint(...)`.

Bridge between instances with normal services:

1. expose a gateway service on one instance
2. implement that service by calling `create(...)` on the other instance
3. treat proxies and refs on both sides as session-bound handles

For example, a background service can expose a local-broker gateway on `brokerNexus` and implement it by calling content-script services through `extensionNexus`. That keeps transport admission, extension routing, and broker-facing API boundaries explicit.

If the bridge is forwarding a selected upstream service or Nexus State store into a downstream graph, use Nexus Relay instead of inventing a raw router. Relay is still provider-level forwarding: it exposes an ordinary service or store provider on one instance and implements it by calling another instance. It does not merge graphs or introduce transparent multi-hop routing. See `docs/relay.md`.

## Targeting And Context Resolution

Nexus routes calls through target descriptors and matching rules.

- adapters map platform-specific context identity (for example, extension background/content script)
- targeting is explicit, so cross-context behavior stays debuggable
- proxy creation and call dispatch use the same routing model

For unicast proxy creation, Nexus resolves target intent in this order:

1. explicit non-empty `create(..., { target })`
2. token `defaultCreate.target`
3. unique endpoint `connectTo` fallback

Token defaults are consumer-side create defaults, not provider locations. A provider is still published on the local Nexus face where `@nexus.Expose(...)` or `provide(...)` runs.

`expects` is a call-site topology assertion. Put it on `create(...)` when the caller requires one or many matches; do not encode it in token defaults.

If there is no unique target, proxy creation fails.

Two common targeting styles are:

### Inline descriptor

```ts
const remote = await nexus.create(PingToken, {
  target: {
    descriptor: { context: "background" },
  },
});
```

### Named descriptor or matcher

If your application registers descriptors or matchers in configuration, you can target by name instead of repeating the rule inline.

That is useful when the same routing intent appears in many places.

For example:

```ts
nexus.configure({
  descriptors: {
    background: { context: "background" },
  },
  matchers: {
    activeContentScript: (identity) =>
      identity.context === "content-script" && identity.isActive === true,
  },
});

const byDescriptor = await nexus.create(PingToken, {
  target: { descriptor: "background" },
});

const byMatcher = await nexus.create(PingToken, {
  target: { matcher: "activeContentScript" },
});
```

## Transport-Agnostic Core, Platform Adapters

Nexus keeps core communication APIs in `@nexus-js/core` and layers platform specifics in adapters such as `@nexus-js/chrome`.

This lets application code keep one programming model while adapting endpoint wiring per platform.

## Architecture Layers

At a high level, the implementation splits into layers:

- transport / endpoint layer
- connection and routing layer
- service / proxy / resource layer
- product-facing API layer

You usually interact with the top layer, but the behavior you observe comes from all of them working together.

Nexus Relay is exposed at the product-facing API layer through `@nexus-js/core/relay`, and implemented using the service/proxy/resource layer plus the Nexus State service contract. It relies on connection identity and routing underneath, but it is not a transport or raw message-routing layer.

## Identity Updates And Lifecycle

Contexts can change identity over time.

Examples:

- active tab changes
- metadata changes
- group membership changes

Nexus uses identity updates to keep targeting and connection lifecycle behavior correct over time.

This is why `updateIdentity()` exists as part of the public product API: if a context changes meaningfully over time, Nexus needs updated identity information to keep routing and lifecycle decisions correct.

At the application layer, reconnect usually means rebuilding session-bound handles after identity or connection changes. Higher-layer code may automate that rebuild flow, but raw core handles do not silently heal across session replacement.

## Product Capability Layers

- core RPC and service exposure: `@nexus-js/core`
- state subsystem for synchronized remote state: `@nexus-js/core/state`
- relay helpers for explicit graph bridging: `@nexus-js/core/relay`
- React bindings for Nexus State: `@nexus-js/react`

Nexus State is a subsystem, not the product root.

## Where To Go Next

- Install/setup flow: `docs/getting-started.md`
- Package choices: `docs/packages.md`
- Platform model: `docs/platforms.md`
- Nexus Relay: `docs/relay.md`
- Nexus State docs: `docs/state/README.md`
