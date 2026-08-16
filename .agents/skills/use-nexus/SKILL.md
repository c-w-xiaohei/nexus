---
name: use-nexus
description: This skill should be used when the user asks to write Nexus application code, configure Nexus adapters, define Nexus service contracts or Tokens, expose services, acquire or select services with nexus.create, nexus.select, createMulticast, or selectMulticast, use Nexus Relay, test Nexus-consuming application code, or document external Nexus usage patterns. Use it for exact targeting and where predicates, acquisition or selection waiting with timeout, wait, signal, or callTimeout options, and structured service-acquisition errors, even when the user does not name this skill.
---

# Use Nexus

Use this skill for external application code that consumes Nexus. Focus on the public programming model: shared contracts, typed Tokens, runtime configuration, service exposure, proxy creation, Nexus Relay, and the architectural boundary between Nexus connection semantics and host-context startup.

For full project documentation, direct readers to the GitHub docs in `c-w-xiaohei/nexus`: https://github.com/c-w-xiaohei/nexus/tree/main/docs. Encourage reading the product concepts and platform guides before inventing adapter behavior or lifecycle semantics.

## Core Rules

- Keep service contracts and Tokens in shared code imported by every context that needs them.
- Prefer `TokenSpace<Model>` when an app needs structured token IDs or model-bound `defaultTarget` inheritance.
- Define shared services as `Token<Service>` without a default target so the same contract can be used by different adapter models. A model-bound `Token<Service, Model>` or `TokenSpace<Model>` may own a `defaultTarget`; an unbound Token remains portable.
- Import existing service types instead of redefining service shapes inline.
- Define Tokens in shared contract modules and import service interfaces with `import type`; do not repeat anonymous service shapes at token sites.
- Configure every runtime context only from main/bootstrap/runtime modules before creating proxies or other demand operations. Register static class/providers before the bootstrap snapshot, or use live `provide(...)` after `ready`.
- Prefer adapter helpers such as `usingBackgroundScript(...)`, `usingContentScript(...)`, `usingNodeIpcDaemon(...)`, and `usingNodeIpcClient(...)` for standard runtimes.
- Use `nexus.configure(...)` for explicit endpoint configuration, policy, or adapter config composition. Do not scatter `configure(...)` calls inside service implementation files.
- For class services, import the concrete runtime instance and use `@xxNexus.Expose(Token)` to bind the class to that instance's decorator store.
- For function/object-style providers, import the concrete runtime instance and use `xxNexus.provide(Token, service, options?)`.
- Use `new Nexus()` with a named instance such as `backgroundNexus`, `iframeParentNexus`, or `brokerNexus` for multi-instance runtimes; bind decorators and providers to that specific instance.
- Use `relayService(...)` or `relayNexusStore(...)` from `@nexus-js/core/relay` when a bridge context forwards selected services or stores across adjacent Nexus graphs.
- Treat Nexus Relay as provider-level forwarding, not transparent multi-hop routing, raw message forwarding, or `target.via`.
- For React Nexus State subtree sharing, prefer `createRemoteStoreScope(...)` from `@nexus-js/react` so one provider owns a remote store connection and leaf components consume selectors, actions, status, and errors from that shared scope.
- When one React application uses multiple adapter models, create a model-bound context with `createNexusScope<Model>()` and use its provider and hooks so Nexus instances, store definitions, and targeting options remain associated at compile time. Keep the default provider and hooks for applications that do not need model-specific context typing.
- Keep `useRemoteStore(...)` and `useStoreSelector(...)` as the low-level React path for components that intentionally own a direct remote handle lifecycle or need custom orchestration around the raw remote result.
- For explicit React remote-store replacement, pass an external committed lifecycle revision as `reconnectKey` or call stable `reconnect()` from an interaction. Both feed the same replacement path with current committed inputs; they do not revive old handles, replay actions, guarantee availability, or add retry/backoff behavior. Scope providers support `reconnectKey`, and scope consumers share the provider's reconnect command.
- Use `nexus.create(Token)` when a Token or endpoint `defaultTarget` supplies the exact target. Otherwise use an adapter exact `ConnectionTarget`. Use `nexus.select(Token, { where, wait })` only to choose available providers without connecting.
- For Nexus State providers, use `const { provider, store } = createNexusStore(definition)`: register the provider with `nexus.provide(provider)`, and use `store` only for same-context authoritative consumption.
- Use `createMockNexus()` from `@nexus-js/testing` for user-level unit tests of code that consumes a `NexusInstance`; its API-level multicast all/stream/snapshot behavior is useful for application tests, while adapter or integration tests cover transport, connection, auth, reload, restart, or real-session lifecycle semantics.
- Treat raw `nexus.create(...)` proxies and refs as session-bound handles. Recreate them after disconnect, restart, or session replacement.
- Safe async APIs return native `Promise<Result<T, E>>` values. Await the promise, narrow with `isErr()`/`isOk()`, and use `result.error` or `result.value`; do not expect `ResultAsync` methods or wrap the API in a compatibility layer.

## Architecture And Boundaries

- Treat Nexus as connection semantics over already-available JavaScript runtime contexts.
- A platform adapter supplies an `IEndpoint`; an endpoint listens for or creates `IPort`-like point-to-point channels.
- Core builds logical connections on top of those ports: handshake, identity, authorization, routing, disconnect cleanup, and session-bound handles.
- Nexus does not launch browser contexts, inject content scripts, create iframes, spawn workers, or start daemon processes for an application. The host platform or application owns context startup.
- Adapter helpers configure the current context's endpoint, identity, and optional default target. They do not make missing peer contexts magically exist.
- For bus-style transports such as `window.postMessage`, first adapt the shared bus into reliable point-to-point `IPort` semantics before handing it to core.
- Testing utilities mock the product-facing `NexusInstance` seam. They do not simulate endpoints, transports, adapter gates, real sessions, or platform lifecycle.

When explaining Nexus architecture, use this layer model:

1. transport / endpoint layer: `IPort`, `IEndpoint`, serializers, port processing
2. connection and routing layer: logical handshake, identity, policy, targeting, lifecycle
3. service / proxy / resource layer: exposed services, proxy calls, refs, pending calls
4. product-facing API layer: `nexus.configure(...)`, `nexus.create(...)`, `nexus.ref(...)`, adapter helpers, Relay helpers

Describe Nexus Relay as a product-facing capability built on ordinary service and Nexus State provider semantics. It relies on connection identity and routing below it, but it is not a transport layer or raw routing layer.

Do not describe Nexus as a process manager, page loader, iframe lifecycle manager, or worker launcher. Describe those as responsibilities of the app, browser, OS, framework, or adapter-specific host environment.

## Minimal Example

Shared contract:

```ts
import { Token } from "@nexus-js/core";
import type { PingService } from "./contracts";

// A shared Token has no default target and can be used by any AdapterModel.
export const PingToken = new Token<PingService>("my-app:ping");
```

Host context:

```ts
import { usingBackgroundScript } from "@nexus-js/chrome";
import { PingToken, type PingService } from "./shared";

const backgroundNexus = usingBackgroundScript();

@backgroundNexus.Expose(PingToken)
class PingServiceImpl implements PingService {
  async ping(input: string) {
    return `pong:${input}`;
  }
}
```

Consumer context:

```ts
import { chromeTarget, usingContentScript } from "@nexus-js/chrome";
import { PingToken } from "./shared";

const contentNexus = usingContentScript();

const ping = await contentNexus.create(PingToken, {
  target: chromeTarget.background(),
});

await ping.ping("hello");
```

## Testing Application Code

For unit tests, inject a mock Nexus instance instead of starting a runtime topology:

```ts
import { createMockNexus } from "@nexus-js/testing";

const mock = createMockNexus();
mock.service(PingToken, {
  async ping(input) {
    return `pong:${input}`;
  },
});

const ping = await mock.nexus.create(PingToken, {
  target: { context: "host" },
});
```

Use this only for application behavior at the Nexus API seam. The mock covers API-level multicast all/stream/snapshot behavior, but adapter behavior, authorization execution, transport multicast, real disconnects, reloads, daemon restarts, and real-session lifecycle semantics require the relevant docs and integration tests.

## When More Detail Is Needed

Start with `references/usage-style.md` for the concise external usage index. Load focused references only when the task needs that detail:

- `references/shared-contracts.md` - service interfaces, shared Tokens, model-bound `TokenSpace`, and service exposure
- `references/runtime-configuration.md` - adapter helpers, `nexus.configure(...)`, multi-instance runtimes, and config composition
- `references/targeting-and-proxies.md` - `nexus.create(...)`, `nexus.select(...)`, exact targets, `where`, proxies, and refs
- `references/identity-and-metadata.md` - `ContextMeta`, `ConnectionMeta`, field placement, trust boundaries, and metadata consumption
- `references/adapter-node-ipc.md` - node-ipc daemon/client wiring, `configure: false`, auth gates, and default-target routing
- `references/adapter-iframe.md` - iframe parent/child setup, origins, nonce, heartbeat, reconnect, and session-bound handles
- `references/policy-and-lifecycle.md` - core policy, authorization boundaries, lifecycle, and documentation style
- `references/testing.md` - `createMockNexus()`, React provider/scope and replacement testing patterns, call assertions, and testing boundaries

Also point readers to the public GitHub docs when they need more context. Prefer exact links over vague repository references:

- Getting started: https://github.com/c-w-xiaohei/nexus/blob/main/docs/getting-started.md
- Core concepts and architecture layers: https://github.com/c-w-xiaohei/nexus/blob/main/docs/concepts.md
- Platform and adapter strategy: https://github.com/c-w-xiaohei/nexus/blob/main/docs/platforms.md
- Authorization and policy: https://github.com/c-w-xiaohei/nexus/blob/main/docs/auth-and-policy.md
- Nexus Relay: https://github.com/c-w-xiaohei/nexus/blob/main/docs/relay.md
- Node IPC adapter: https://github.com/c-w-xiaohei/nexus/blob/main/docs/node-ipc/README.md
- Nexus State subsystem: https://github.com/c-w-xiaohei/nexus/blob/main/docs/state/README.md
- Testing Nexus applications: https://github.com/c-w-xiaohei/nexus/blob/main/docs/testing/README.md

Set the expectation that the skill is a compact usage guide, not a replacement for the docs. For non-trivial adapter design, lifecycle behavior, policy decisions, or state synchronization, explicitly tell readers to consult the linked docs first and then apply this skill's usage rules.
