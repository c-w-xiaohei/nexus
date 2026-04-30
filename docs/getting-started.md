# Getting Started With Nexus

This guide shows the real minimum path to a first working Nexus setup.

It is product-level, not subsystem-specific. The goal is to get one context to expose a service and another context to call it successfully.

Important: both sides of the communication need Nexus setup. The host context and the consumer context each need their own endpoint configuration.

## What You Need Before Anything Else

Nexus always needs these pieces:

1. shared contracts and `Token`s
2. an endpoint implementation for the current context
3. runtime configuration through `nexus.configure(...)` or endpoint decorators
4. a consumer that creates a proxy with a resolvable target

For an end-to-end remote call to work, some context in the system must also expose the target service.

If endpoint configuration is missing, the runtime cannot initialize correctly. If service exposure or targeting is missing, proxy creation or invocation will fail.

## 1. Install The Core Package

Start here:

```bash
pnpm add @nexus-js/core
```

Then add an adapter only if your runtime needs one, for example:

```bash
pnpm add @nexus-js/chrome
```

For package selection, use `docs/packages.md`.

For platform/adapter choice, use `docs/platforms.md`.

## 2. Define A Shared Contract

Put your token in shared code that both contexts can import.

If you already have a service type elsewhere, prefer importing that type instead of redefining the shape inline.

```ts
import { Token } from "@nexus-js/core";
import type { PingService } from "./service-contract";

export const PingToken = new Token<PingService>("example:ping-service");
```

`Token<T>` is how Nexus connects compile-time shape to runtime identity.

## 3. Configure The Current Context

Nexus must know what endpoint belongs to the current runtime context.

You can do that either with:

- `nexus.configure({ endpoint: ... })`
- an adapter helper
- or `@Endpoint`

The minimum runtime configuration looks like this:

```ts
import { nexus } from "@nexus-js/core";

nexus.configure({
  endpoint: {
    implementation: endpointImplementation,
    meta: {
      context: "background",
      platform: "chrome-extension",
    },
  },
});
```

Two fields matter immediately:

- `implementation`
  - the endpoint object that can send/listen using your transport
- `meta`
  - the identity Nexus uses for routing, targeting, and lifecycle

If you are using a first-party adapter such as `@nexus-js/chrome`, that adapter can provide a friendlier setup path. If you are using only `@nexus-js/core`, this is the level of endpoint configuration you need to supply yourself.

Both sides need this step.

- the host context needs endpoint configuration so it can accept connections and expose services
- the consumer context needs endpoint configuration so it can create outgoing connections and proxies

At minimum, an endpoint implementation needs to be able to do one or both of these jobs:

- `listen(onConnect)` to accept incoming connections
- `connect(targetDescriptor)` to initiate an outgoing connection

That is the core bridge between Nexus and your runtime transport.

A minimal conceptual endpoint shape looks like this:

```ts
type Endpoint = {
  listen?: (onConnect: (port: unknown, platformMeta?: unknown) => void) => void;
  connect?: (
    targetDescriptor: Record<string, unknown>,
  ) => Promise<[unknown, unknown]>;
  capabilities?: {
    supportsTransferables: boolean;
  };
};
```

You do not need this exact pseudo-type in app code. It is here to make the role of `endpoint.implementation` more concrete.

Two concrete next-step routes are:

- shipped adapter route: use `@nexus-js/chrome` and follow its README/examples
- custom runtime route: implement the `IEndpoint` contract from `@nexus-js/core` and wire it through `configure({ endpoint })`

## 4. Expose A Service

Expose the implementation in the host context.

```ts
import { Expose } from "@nexus-js/core";
import { PingToken } from "./shared";
import type { PingService } from "./service-contract";

@Expose(PingToken)
class PingServiceImpl implements PingService {
  async ping(input: string): Promise<string> {
    return `pong:${input}`;
  }
}
```

You can also expose services through `configure({ services })` if that fits your app architecture better.

At this point, one side of the system is configured and can host the service.

## 5. Configure The Consumer Context Too

The other side still needs its own Nexus setup.

For example, the consumer context also needs an endpoint implementation and identity metadata:

```ts
import { nexus } from "@nexus-js/core";

nexus.configure({
  endpoint: {
    implementation: consumerEndpointImplementation,
    meta: {
      context: "popup",
      platform: "chrome-extension",
    },
  },
});
```

Without this step, the consumer cannot create a usable proxy.

## How `configure()` And Decorators Fit Together

Nexus startup collects registration information first, then builds the runtime kernel from:

- explicit `nexus.configure(...)` input
- `@Endpoint` registration, if used
- `@Expose` registrations, if used

So decorators are part of startup registration, not a separate runtime path that bypasses `configure()`.

One important limitation: decorator registrations are process-global. They are a good fit for the normal single-`nexus` setup in one runtime, but multi-instance setups must use explicit `configure({ endpoint, services })` input instead of relying on global decorator registration.

If one JavaScript context needs two independent Nexus runtimes, create isolated `Nexus` instances and configure each one explicitly:

```ts
import { Nexus } from "@nexus-js/core";

const extensionNexus = new Nexus<ExtensionUserMeta, ExtensionPlatformMeta>();
const localBrokerNexus = new Nexus<BrokerUserMeta, BrokerPlatformMeta>();

extensionNexus.configure({
  endpoint: extensionEndpointConfig,
  services: [
    {
      token: ExtensionServiceToken,
      implementation: extensionService,
    },
  ],
});

localBrokerNexus.configure({
  endpoint: brokerEndpointConfig,
  services: [
    {
      token: BrokerGatewayToken,
      implementation: brokerGatewayService,
    },
  ],
});
```

Do not use `@Expose` or `@Endpoint` in this pattern. Decorators are collected in a shared registry, so only one Nexus instance can consume those registrations safely. Bridge between the two runtimes with explicit services that call the other instance when needed.

## 6. Create A Proxy From Another Context

From a different configured context, create the proxy with a target:

```ts
import { nexus } from "@nexus-js/core";
import { PingToken } from "./shared";

const remote = await nexus.create(PingToken, {
  target: {
    descriptor: { context: "background" },
  },
});

const value = await remote.ping("hello");
console.log(value);
```

Important lifecycle note:

- a raw `nexus.create()` unicast proxy is bound to the resolved remote session
- target handoff changes future `nexus.create(...)` resolution, not an already-created raw proxy
- replace an existing raw proxy only when its own bound session/connection ends, by calling `nexus.create(...)` again for the new session
- higher-layer app code can automate this, but the raw proxy does not silently heal in place

Why is `target` usually needed?

Because Nexus has to decide where the proxy should connect. It resolves target intent in this order:

1. explicit `target` in `create(...)`
2. token default target
3. a unique `connectTo` fallback from endpoint configuration

`create()` still takes an options object; fallback only affects how Nexus resolves the target intent inside that object.

If that resolution is ambiguous or empty, Nexus fails instead of guessing.

You can also target by named descriptor or matcher if your app registers those through configuration. See `docs/concepts.md` for the targeting model.

## 7. Know What "Working" Means

Your first working Nexus setup is successful when:

- both contexts are configured with endpoints
- one side exposes a service
- the other side can create a proxy with a resolvable target
- a method call succeeds across the boundary

If it fails, check these first:

- did both contexts configure an endpoint?
- does the service exist under the right `Token`?
- does the target resolve to exactly one usable destination?

## 8. What To Read Next

- Product mental model: `docs/concepts.md`
- Platform and adapter selection: `docs/platforms.md`
- Package map: `docs/packages.md`
- Nexus State subsystem: `docs/state/README.md`

If you want a runnable subsystem path after basic Nexus bootstrapping works, continue into `docs/state/quick-start.md`.
