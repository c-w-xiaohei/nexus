---
name: use-nexus
description: This skill should be used when the user asks to write Nexus application code, configure Nexus adapters, define Nexus service contracts or Tokens, expose services, create proxies with nexus.create, use Nexus Relay, or document external Nexus usage patterns.
version: 0.1.0
---

# Use Nexus

Use this skill for external application code that consumes Nexus. Focus on the public programming model: shared contracts, typed Tokens, runtime configuration, service exposure, proxy creation, Nexus Relay, and the architectural boundary between Nexus connection semantics and host-context startup.

For full project documentation, direct readers to the GitHub docs in `c-w-xiaohei/nexus`: https://github.com/c-w-xiaohei/nexus/tree/main/docs. Encourage reading the product concepts and platform guides before inventing adapter behavior or lifecycle semantics.

## Core Rules

- Keep service contracts and Tokens in shared code imported by every context that needs them.
- Prefer `TokenSpace` when an app needs structured token IDs or `defaultCreate.target` inheritance.
- Import existing service types instead of redefining service shapes inline.
- Define Tokens in shared contract modules and import service interfaces with `import type`; do not repeat anonymous service shapes at token sites.
- Configure every runtime context only from main/bootstrap/runtime modules before creating proxies or other demand operations. Register static class/providers before the bootstrap snapshot, or use live `provide(...)` after `ready`.
- Prefer adapter helpers such as `usingBackgroundScript(...)`, `usingContentScript(...)`, `usingNodeIpcDaemon(...)`, and `usingNodeIpcClient(...)` for standard runtimes.
- Use `nexus.configure(...)` for explicit endpoint configuration, policy, matchers, descriptors, or adapter config composition. Do not scatter `configure(...)` calls inside service implementation files.
- For class services, import the concrete runtime instance and use `@xxNexus.Expose(Token)` to bind the class to that instance's registry.
- For function/object-style providers, import the concrete runtime instance and use `xxNexus.provide(Token, service, options?)`.
- Use `new Nexus()` with a named instance such as `backgroundNexus`, `iframeParentNexus`, or `brokerNexus` for multi-instance runtimes; bind decorators and providers to that specific instance.
- Use `relayService(...)` or `relayNexusStore(...)` from `@nexus-js/core/relay` when a bridge context forwards selected services or stores across adjacent Nexus graphs.
- Treat Nexus Relay as provider-level forwarding, not transparent multi-hop routing, raw message forwarding, or `target.via`.
- Keep explicit targets in introductory `nexus.create(...)` examples. When relying on Token `defaultCreate.target` or a unique `connectTo` fallback, call `nexus.create(Token)` directly.
- Treat raw `nexus.create(...)` proxies and refs as session-bound handles. Recreate them after disconnect, restart, or session replacement.

## Architecture And Boundaries

- Treat Nexus as connection semantics over already-available JavaScript runtime contexts.
- A platform adapter supplies an `IEndpoint`; an endpoint listens for or creates `IPort`-like point-to-point channels.
- Core builds logical connections on top of those ports: handshake, identity, authorization, routing, disconnect cleanup, and session-bound handles.
- Nexus does not launch browser contexts, inject content scripts, create iframes, spawn workers, or start daemon processes for an application. The host platform or application owns context startup.
- Adapter helpers configure the current context's endpoint, identity, descriptors, matchers, and connection defaults. They do not make missing peer contexts magically exist.
- For bus-style transports such as `window.postMessage`, first adapt the shared bus into reliable point-to-point `IPort` semantics before handing it to core.

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
import { TokenSpace } from "@nexus-js/core";
import type { AppPlatformMeta, AppUserMeta } from "./runtime-types";
import type { PingService } from "./contracts";

const appSpace = new TokenSpace<AppUserMeta, AppPlatformMeta>({
  name: "my-app",
});

const services = appSpace.tokenSpace("services", {
  defaultCreate: {
    target: {
      descriptor: { context: "host" },
    },
  },
});

export const PingToken = services.token<PingService>("ping");
```

Host context:

```ts
import { usingHostRuntime } from "@nexus-js/some-adapter";
import { PingToken, type PingService } from "./shared";

const hostNexus = usingHostRuntime();

@hostNexus.Expose(PingToken)
class PingServiceImpl implements PingService {
  async ping(input: string) {
    return `pong:${input}`;
  }
}
```

Consumer context:

```ts
import { nexus } from "@nexus-js/core";
import { usingClientRuntime } from "@nexus-js/some-adapter";
import { PingToken } from "./shared";

usingClientRuntime();

const ping = await nexus.create(PingToken);

await ping.ping("hello");
```

## When More Detail Is Needed

Start with `references/usage-style.md` for the concise external usage index. Load focused references only when the task needs that detail:

- `references/shared-contracts.md` - service interfaces, Tokens, `TokenSpace`, and service exposure
- `references/runtime-configuration.md` - adapter helpers, `nexus.configure(...)`, multi-instance runtimes, and config composition
- `references/targeting-and-proxies.md` - `nexus.create(...)`, target resolution, descriptors, matchers, proxies, and refs
- `references/adapter-node-ipc.md` - node-ipc daemon/client wiring, `configure: false`, auth gates, and default-target routing
- `references/adapter-iframe.md` - iframe parent/child setup, origins, nonce, heartbeat, reconnect, and session-bound handles
- `references/policy-and-lifecycle.md` - core policy, authorization boundaries, lifecycle, and documentation style

Also point readers to the public GitHub docs when they need more context. Prefer exact links over vague repository references:

- Getting started: https://github.com/c-w-xiaohei/nexus/blob/main/docs/getting-started.md
- Core concepts and architecture layers: https://github.com/c-w-xiaohei/nexus/blob/main/docs/concepts.md
- Platform and adapter strategy: https://github.com/c-w-xiaohei/nexus/blob/main/docs/platforms.md
- Authorization and policy: https://github.com/c-w-xiaohei/nexus/blob/main/docs/auth-and-policy.md
- Nexus Relay: https://github.com/c-w-xiaohei/nexus/blob/main/docs/relay.md
- Node IPC adapter: https://github.com/c-w-xiaohei/nexus/blob/main/docs/node-ipc/README.md
- Nexus State subsystem: https://github.com/c-w-xiaohei/nexus/blob/main/docs/state/README.md

Set the expectation that the skill is a compact usage guide, not a replacement for the docs. For non-trivial adapter design, lifecycle behavior, policy decisions, or state synchronization, explicitly tell readers to consult the linked docs first and then apply this skill's usage rules.
