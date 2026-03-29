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
2. expose a service in one runtime context
3. create and call a typed proxy from another context

This gives local-like API ergonomics while preserving explicit cross-context boundaries.

## Startup And Configuration

Before you can create useful proxies, the current context must be configured.

In practice, Nexus startup always includes:

1. endpoint registration
2. endpoint identity metadata

That is why `configure()` matters at the product level.

Nexus does not infer the current context magically. It needs an endpoint implementation and metadata in order to route and accept connections.

Service registration is optional at the level of a single context boot. It becomes necessary when you want that context to expose callable services to others.

If you use decorators for endpoint or service registration, remember that those registrations are process-global. Multi-instance setups should prefer explicit `configure({ endpoint, services })` input.

## Targeting And Context Resolution

Nexus routes calls through target descriptors and matching rules.

- adapters map platform-specific context identity (for example, extension background/content script)
- targeting is explicit, so cross-context behavior stays debuggable
- proxy creation and call dispatch use the same routing model

For unicast proxy creation, Nexus resolves target intent in this order:

1. explicit `create(..., { target })`
2. token default target
3. unique endpoint `connectTo` fallback

`create()` still takes an options object. The fallback logic only changes how Nexus resolves target intent inside that call.

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

## Identity Updates And Lifecycle

Contexts can change identity over time.

Examples:

- active tab changes
- metadata changes
- group membership changes

Nexus uses identity updates to keep targeting and connection lifecycle behavior correct over time.

This is why `updateIdentity()` exists as part of the public product API: if a context changes meaningfully over time, Nexus needs updated identity information to keep routing and lifecycle decisions correct.

## Product Capability Layers

- core RPC and service exposure: `@nexus-js/core`
- state subsystem for synchronized remote state: `@nexus-js/core/state`
- React bindings for Nexus State: `@nexus-js/react`

Nexus State is a subsystem, not the product root.

## Where To Go Next

- Install/setup flow: `docs/getting-started.md`
- Package choices: `docs/packages.md`
- Platform model: `docs/platforms.md`
- Nexus State docs: `docs/state/README.md`
