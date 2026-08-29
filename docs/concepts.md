# Nexus Concepts

Nexus is a service and connection runtime for already-existing JavaScript contexts. It supplies typed contracts, connection acquisition, service exposure, session-bound proxies, resource references, authorization, and lifecycle semantics. The host application owns context startup and discovery.

## Core Model

1. Define a service contract and `Token` in shared code.
2. Configure an endpoint and local `ContextMeta` in every participating context.
3. Expose a provider with `@nexus.Expose(...)` or `provide(...)`.
4. Acquire a proxy from an exact target with `create`, or select available providers with `select`.

`Token<T>` identifies the service contract. A Token without a default target is portable across adapter models. A model-bound Token or `TokenSpace` may carry a model-checked `defaultTarget`.

## Adapter Model

The public `AdapterModel` associates three adapter-specific type families:

```ts
interface AdapterModel {
  contextMeta: object;
  connectionMeta: object;
  connectionTarget: object;
}
```

First-party adapters expose their model and related types. `Nexus<M>`, `TokenSpace<M>`, `IEndpoint<M>`, and policy contexts use the same model, so a target from one adapter cannot be accidentally combined with another adapter's identity or connection facts. The model is a compile-time association; it is not a wire schema or an identity-authentication mechanism.

## ContextMeta And ConnectionMeta

`ContextMeta` is the peer-declared product identity exchanged during the handshake. It can contain a context role, application metadata, URL, origin, tenant, or capability labels used by `where` and policy.

`ConnectionMeta` is adapter-owned and scoped to one logical connection session. It contains facts the local adapter observes or verifies for that connection, such as a Chrome sender or an IPC authentication result. It is read-only from the core API, is not sent as peer identity, and is not changed through `updateIdentity()`.

The distinction is important: a remote context may declare one identity, while different local adapters observe different connection facts for that same context. Do not turn adapter observations into `ContextMeta`, and do not expose adapter-private route details as a general target or identity type.

## ConnectionTarget And where

`ConnectionTarget` expresses one concrete platform endpoint that the adapter can connect to. For example, Chrome exports `chromeTarget.background()` and `chromeTarget.contentDocument({ tabId, documentId })`; Node IPC uses `NodeIpcConnectionTarget`; iframe uses `IframeConnectionTarget`.

`where` filters an established connection with its remote `ContextMeta` and local `ConnectionMeta`:

```ts
import { Nexus } from "@nexus-js/core";
import { chromeTarget, type ChromeAdapterModel } from "@nexus-js/chrome";
import { CaptureToken } from "./shared-contracts";

const chromeNexus = new Nexus<ChromeAdapterModel>();
const tabId = 42;

const remote = await chromeNexus.create(CaptureToken, {
  target: chromeTarget.contentFrame({ tabId, frameId: 0 }),
  where: (contextMeta, connectionMeta) =>
    contextMeta.context === "content-script" &&
    contextMeta.isVisible === true &&
    connectionMeta.observed.tabId === tabId,
  timeout: 30_000,
  callTimeout: 5_000,
});
```

The semantics are always:

```text
target matches the connection
AND
where(contextMeta, connectionMeta) is true
```

There is no find-any mode hidden behind `where`. It filters established peers; it never discovers or connects one.

## Resolution And Fallbacks

For unicast `create()`, Nexus resolves in this order:

1. explicit `target: ConnectionTarget`
2. Token `defaultTarget`
3. endpoint `defaultTarget`
4. a structured targeting error

An exact target is actionable: Nexus first reuses a matching ready session and otherwise asks the adapter to connect that target.

`defaultTarget` is only a default address for `create`. It neither preconnects nor affects `select`.

`createMulticast` requires non-empty `targets: readonly ConnectionTarget[]`; it acquires each exact target and fails the whole operation if any target cannot be acquired. `expects: "all"` (the default) returns settled results, while `expects: "stream"` returns an async iterable of settled results; neither includes connection IDs or `from` metadata. Connection IDs are not public acquisition inputs, selection keys, routing targets, or multicast result fields. `selectMulticast({ where })` never connects, has no `wait`, and binds one current provider snapshot, where zero providers is a valid empty result. `where` remains an additional AND filter in either operation. Acquisition `timeout`/`signal` cover target acquisition, `callTimeout` covers later calls, and incompatible provider-catalog protocols are structured protocol errors.

## Session-Bound Handles

`create()` returns a proxy bound to the session acquired for that call. `ref()` transfers a connection-scoped capability; the materialized remote capability is likewise bound to that session. Disconnect, reload, daemon restart, and replacement invalidate old handles. Higher-level application code may observe lifecycle signals and create replacements, but the raw handle never silently retargets or retries.

For ordinary unicast service proxies, use the static `Nexus.getProxyStatus()` /
`Nexus.subscribeProxyStatus()` pair to observe the local session without
coupling the observer to its creator. See [service proxy lifecycle](proxy-lifecycle.md)
for exact applicability, future-only subscription, diagnostics, and explicit
replacement rules.

`Nexus.release(value)` and `Nexus.safeRelease(value)` release remote resource
capabilities without requiring the creating Nexus instance. They do not control
service proxy lifecycle: ordinary service proxies are not releasable, and
release never reconnects or replaces a session-bound handle.

When a local proxy call is closed by the current Core copy, it rejects with
`NexusDisconnectedError`. Use `instanceof` only within that installed copy. For
serialized, cross-context, or duplicate-copy handling, branch on the stable
`E_CONN_CLOSED` code instead.

## Configuration And Providers

Configure each runtime before demand operations such as `create()` or `ref()`:

The following is a structural pseudocode sketch, not a complete copyable
endpoint implementation. For concrete adapter setup or a custom endpoint,
see `docs/platforms.md`.

```ts
import { nexus } from "@nexus-js/core";

nexus.configure({
  endpoint: {
    implementation,
    meta: { context: "worker", app: { name: "scheduler" } },
    defaultTarget: undefined,
  },
});
```

Use `@ownedNexus.Expose(Token)` for class providers and `ownedNexus.provide(Token, service)` for object, State, Relay, and runtime-created providers. Use `configure({ providers })` for bootstrap composition. After `ready`, live provider registration uses `provide(...)`.

The application owns provider and target discovery. Nexus does not search all contexts for a provider, inject a content script, inspect the active tab, or decide which frames are eligible.

## Multiple Nexus Instances

One JavaScript context can host isolated Nexus instances for different transport graphs:

```ts
import { Nexus } from "@nexus-js/core";
import type { ChromeAdapterModel } from "@nexus-js/chrome";
import type { IframeAdapterModel } from "@nexus-js/iframe";

const chromeNexus = new Nexus<ChromeAdapterModel>();
const iframeNexus = new Nexus<IframeAdapterModel>();
```

Name instances after the local graph they own, not after a remote destination. Relay can expose a selected service or State provider from one graph through another, but it does not merge graphs or create transparent multi-hop routing.

## Architecture Layers

1. Transport and endpoint layer: ports, endpoints, serializers, and platform channels.
2. Connection and routing layer: handshake, identity, policy, target matching, lifecycle, and session acquisition.
3. Service and resource layer: providers, proxies, calls, callbacks, and remote references.
4. Product API layer: `configure`, `create`, `ref`, adapter helpers, State, and Relay.

## Next Steps

- [Getting started](getting-started.md)
- [Identity and connection metadata](identity-and-metadata.md)
- [Platforms and adapters](platforms.md)
- [Authorization and policy](auth-and-policy.md)
- [Service proxy lifecycle](proxy-lifecycle.md)
- [Nexus Relay](relay.md)
- [Nexus State](state/README.md)
