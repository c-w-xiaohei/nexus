---
name: use-nexus
description: This skill should be used when the user asks to write Nexus application code, configure Nexus adapters, define Nexus service contracts or Tokens, expose services, acquire or select services with nexus.create, nexus.select, createMulticast, or selectMulticast, use Nexus Relay, test Nexus-consuming application code, or document external Nexus usage patterns. Use it for exact targeting and where predicates, acquisition or selection waiting with timeout, wait, signal, or callTimeout options, and structured service-acquisition errors, even when the user does not name this skill.
---

# Use Nexus

Use this skill for external application code that consumes Nexus. Focus on the public programming model: shared contracts, typed Tokens, runtime configuration, service exposure, proxy creation, Nexus Relay, and the architectural boundary between Nexus connection semantics and host-context startup.

For full project documentation, direct readers to the published docs at https://c-w-xiaohei.github.io/nexus/docs/. Encourage reading the product concepts and platform guides before inventing adapter behavior or lifecycle semantics.

## Core Rules

- Keep service contracts and Tokens in shared code imported by every context that needs them.
- Define State contracts with `createStoreToken<Store>(id, options?)`, using one shared Store type for data and methods. Keep validation on the token and the business Zustand creator in the host. Pass tokens directly to State and React APIs; do not wrap them in a definition or hand-write the wire service type. `TokenSpace.storeToken<Store>` inherits IDs and default targets.
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
- For React Nexus State subtree sharing, prefer `createRemoteStoreScope(...)` from `@nexus-js/react` so one provider manages a shared `RemoteStore` handle and leaf components consume selectors, actions, status, and errors from that scope.
- When one React application uses multiple adapter models, create a model-bound context with `createNexusScope<Model>()` and use its provider and hooks so Nexus instances, StoreTokens, and targeting options remain associated at compile time. Keep the default provider and hooks for applications that do not need model-specific context typing.
- Keep `useRemoteStore(...)` as the lower-level React owner path. Render a child with a concrete handle and use `useStore(remote.store, selector)` from `zustand` there; Nexus does not export `useStore`. Follow Zustand 5 selector stability rules, using `useShallow` for shallow-equal object/array selections when needed.
- `useRemoteStore` returns acquisition-only `{ store, pending, error, reconnect }`, not `status`. Observe lifecycle explicitly with `useStoreStatus(store, selector?)` or `Scope.useStatus(selector?)`; these return `null` without a handle and during SSR. Select `status.type` for phase-only UI rather than subscribing to every version. The Provider does not forward snapshot/status updates through context; acquisition errors are distinct from later disconnects.
- For explicit React remote-store replacement, pass an external committed lifecycle revision as `reconnectKey` or call stable `reconnect()` from an interaction. Both feed the same replacement path with current committed inputs; they do not revive old handles, replay actions, guarantee availability, or add retry/backoff behavior. Scope providers support `reconnectKey`, and scope consumers share the provider's reconnect command.
- Replacement immediately hides the old React handle and destroys it in effect cleanup, without waiting for the next attempt. Obsolete results are destroyed too. Do not model a React prop change as an old handle's retained `stale` period; Core-originated `stale` remains a separate remote lifecycle signal.
- Use `nexus.create(Token)` when a Token or endpoint `defaultTarget` supplies the exact target. Otherwise use an adapter exact `ConnectionTarget`. Use `nexus.select(Token, { where, wait })` only to choose available providers without connecting.
- Use explicit `endpoint.connectTo` (or adapter helper `connectTo`) for one-shot startup connections independent of `defaultTarget`. When A creates B, A can select with `wait` before B starts; B connects to A without acquiring an A service. A must be listening first. `ready()` does not await startup dials; there is no automatic retry/reconnect.
- Treat `groups` and other membership labels as ordinary typed `ContextMeta` filtered by `where`, not built-in group routing. Selection also requires the requested Token; multicast remains snapshot-bound.
- For Nexus State providers, use `const { provider, store } = createNexusStore(token, nativeCreator, { snapshot, expose, publishWindowMs?, maxPendingSnapshots? })`, or `bindNexusStore(token, existingStore, options)` for an already-created Zustand store. `store` is the original Zustand API: local actions use `store.getState().foo()` and remain synchronous, while the binding owns only publication and remote sessions. `snapshot` is the complete shared projection and `expose` is the runtime action allowlist; the allowlist must include the contract keys until runtime contract enforcement evolves. Defaults are a fixed 200ms publication window and 32 pending snapshots. There is no draft/rollback/queue, `withNexusState` middleware, receipt/waiter protocol, or automatic retry. Register `provider` with `nexus.provide(provider)` and use `store` only for same-context authoritative consumption.
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

Also point readers to the published docs when they need more context. Prefer exact links over vague repository references:

- Getting started: https://c-w-xiaohei.github.io/nexus/docs/getting-started/
- Core concepts and architecture layers: https://c-w-xiaohei.github.io/nexus/docs/concepts/
- Platform and adapter strategy: https://c-w-xiaohei.github.io/nexus/docs/platforms/
- Authorization and policy: https://c-w-xiaohei.github.io/nexus/docs/auth-and-policy/
- Nexus Relay: https://c-w-xiaohei.github.io/nexus/docs/relay/
- Node IPC adapter: https://c-w-xiaohei.github.io/nexus/docs/node-ipc/
- Nexus State subsystem: https://c-w-xiaohei.github.io/nexus/docs/state/
- Testing Nexus applications: https://c-w-xiaohei.github.io/nexus/docs/testing/

Set the expectation that the skill is a compact usage guide, not a replacement for the docs. For non-trivial adapter design, lifecycle behavior, policy decisions, or state synchronization, explicitly tell readers to consult the linked docs first and then apply this skill's usage rules.
