# Getting Started With Nexus

This guide shows the minimum path to a first working Nexus setup.

Important: both sides of the communication need Nexus setup. The host context and the consumer context each need their own endpoint configuration.

## What You Need Before Anything Else

Nexus always needs these pieces:

1. shared contracts and `Token`s
2. an endpoint implementation and `ContextMeta` for the current context
3. runtime configuration through `using*()` helpers or `nexus.configure(...)`
4. a provider published with `@nexus.Expose(...)` or `provide(...)`
5. a consumer that creates a session-bound remote proxy

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
- an instance-bound endpoint decorator such as `@nexus.Endpoint(...)`

The minimum runtime configuration looks like this:

```ts
import { nexus } from "@nexus-js/core";

nexus.configure({
  endpoint: {
    implementation: endpointImplementation,
    meta: { context: "worker" },
  },
});
```

Two fields matter immediately:

- `implementation`
  - the endpoint object that can send/listen using your transport
- `meta`
  - the peer-declared `ContextMeta` exchanged during the handshake

If you are using a first-party adapter such as `@nexus-js/chrome`, that adapter can provide a friendlier setup path. If you are using only `@nexus-js/core`, this is the level of endpoint configuration you need to supply yourself.

Both sides need this step.

- the host context needs endpoint configuration so it can accept connections and expose services
- the consumer context needs endpoint configuration so it can create outgoing connections and proxies

At minimum, an endpoint implementation needs to be able to do one or both of these jobs:

- `listen(onConnect)` to accept incoming connections
  - `connect(target)` to initiate an outgoing connection to one adapter-defined `ConnectionTarget`

That is the core bridge between Nexus and your runtime transport.

A minimal conceptual endpoint shape looks like this:

```ts
type Endpoint = {
  listen?: (onConnect: (port: unknown, connectionMeta: object) => void) => void;
  connect?: (
    target: object,
  ) => Promise<{ port: unknown; connectionMeta: object }>;
  capabilities?: {
    supportsTransferables: boolean;
  };
};
```

You do not need this exact pseudo-type in app code. It is here to make the role of `endpoint.implementation` more concrete.

Two concrete next-step routes are:

- shipped adapter route: use `@nexus-js/chrome` and follow its README/examples
- custom runtime route: implement the `IEndpoint` contract from `@nexus-js/core` and wire it through `configure({ endpoint })`

## 4. Publish A Provider

Expose the implementation in the host context.

```ts
import { usingBackgroundScript } from "@nexus-js/chrome";
import { PingToken } from "./shared";
import type { PingService } from "./service-contract";

const hostNexus = usingBackgroundScript();

@hostNexus.Expose(PingToken)
class PingServiceImpl implements PingService {
  async ping(input: string): Promise<string> {
    return `pong:${input}`;
  }
}
```

The equivalent object-provider style is:

```ts
const pingService: PingService = {
  async ping(input) {
    return `pong:${input}`;
  },
};

hostNexus.provide(PingToken, pingService);
```

Use `@xxNexus.Expose(...)` for class declarations, where `xxNexus` is the configured Nexus instance that owns the local endpoint face. Use `provide(...)` for already-constructed object/function instances, Nexus State stores, Relay providers, runtime dependencies created during startup, and live registration after the runtime is ready.

Use `configure({ providers })` for bootstrap bulk composition, for example `providers: [serviceProvider(PingToken, pingService)]`. For ordinary provider registration, especially after the runtime is ready, call `nexus.provide(...)` instead.

At this point, one side of the system is configured and can host the service.

## 5. Configure The Consumer Context Too

The other side still needs its own Nexus setup.

For example, this Chrome consumer uses the first-party content-script adapter:

```ts
import { usingContentScript } from "@nexus-js/chrome";

const consumerNexus = usingContentScript();
```

Without this step, the consumer cannot create a usable proxy.

## How `configure()` And Decorators Fit Together

Nexus startup collects registration information first, then builds the runtime kernel from:

- explicit `nexus.configure(...)` input
- instance-bound `@nexus.Endpoint(...)` / `@specificNexus.Endpoint(...)` registrations, if used
- instance-bound `@nexus.Expose(...)` / `@specificNexus.Expose(...)` registrations, if used

So decorators are part of startup registration, not a separate runtime path that bypasses `configure()`.

The decorator expression captures its Nexus instance. `@nexus.Expose(...)` binds to the default singleton, while `@specificNexus.Expose(...)` binds to that specific instance. Top-level `@Expose(...)` and `@Endpoint(...)` are compatibility shorthand for the default singleton and should not be the main path in new multi-instance code.

If one JavaScript context needs two independent Nexus runtimes, create isolated `Nexus` instances and configure each one explicitly:

The following is a structural sketch with placeholder endpoint and provider
values. In a real application, configure each instance with its adapter setup
before registering providers or creating demand operations; see
`docs/platforms.md` for the first-party setup paths.

```ts
import { Nexus } from "@nexus-js/core";
import type { ChromeAdapterModel } from "@nexus-js/chrome";
import type { IframeAdapterModel } from "@nexus-js/iframe";

const extensionNexus = new Nexus<ChromeAdapterModel>();
const iframeNexus = new Nexus<IframeAdapterModel>();

extensionNexus.configure({
  endpoint: extensionEndpointConfig,
});
extensionNexus.provide(ExtensionServiceToken, extensionService);

iframeNexus.configure({
  endpoint: iframeEndpointConfig,
});
iframeNexus.provide(IframeGatewayToken, iframeGatewayService);
```

Avoid top-level singleton shorthand `@Expose(...)` or `@Endpoint(...)` in this pattern. If a class service belongs to a specific instance, use that instance's decorator, for example `@extensionNexus.Expose(ExtensionServiceToken)`. Use `configure({ providers })` only for bootstrap bulk composition; prefer `.provide(...)` for ordinary provider registration. Bridge between the two runtimes with explicit providers that call the other instance when needed.

## 6. Acquire A Proxy From Another Context

From a different configured context, `create` acquires one provider. A Token or endpoint `defaultTarget` can supply its exact target:

```ts
import { usingContentScript } from "@nexus-js/chrome";
import { PingToken } from "./shared";

const consumerNexus = usingContentScript();
const remote = await consumerNexus.create(PingToken);

const value = await remote.ping("hello");
console.log(value);
```

For safe-first composition, core safe APIs return `Promise<Result<T, E>>`:

```ts
import { chromeTarget, usingContentScript } from "@nexus-js/chrome";
import { PingToken } from "./shared";

const consumerNexus = usingContentScript();
const result = await consumerNexus.safeCreate(PingToken, {
  target: chromeTarget.background(),
});

if (result.isErr()) {
  console.error(result.error.code, result.error.message);
} else {
  const remote = result.value;
  console.log(await remote.ping("hello"));
}
```

The same `Promise<Result<T, E>>` convention applies to `safeReady(...)` and
`safeUpdateIdentity(...)`.

Keep explicit targets while debugging or when the topology is complex:

```ts
import { chromeTarget, usingContentScript } from "@nexus-js/chrome";
import { PingToken } from "./shared";

const consumerNexus = usingContentScript();
const remote = await consumerNexus.create(PingToken, {
  target: chromeTarget.background(),
  timeout: 30_000,
  callTimeout: 5_000,
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

1. explicit `ConnectionTarget` in `create(...)`
2. token `defaultTarget`
3. endpoint `defaultTarget`

If that resolution is empty, `create(Token)` fails with `E_TARGET_REQUIRED` instead of discovering providers globally or guessing. `timeout` and `signal` bound acquisition; `callTimeout` controls later RPC calls through the proxy.

An omitted `target` and `target: undefined` have the same fallback behavior: Nexus continues with the Token default, then the endpoint default, and otherwise returns `E_TARGET_REQUIRED`.

Use `select` when the caller wants an already available provider and must not connect:

```ts
import { usingContentScript, whereBackground } from "@nexus-js/chrome";
import { PingToken } from "./shared";

const abortController = new AbortController();
const consumerNexus = usingContentScript();
const remote = await consumerNexus.select(PingToken, {
  where: whereBackground,
  wait: { timeout: 30_000, signal: abortController.signal },
});
```

Without `wait`, zero matches and ambiguity are structured errors. `where(contextMeta, connectionMeta)` only filters established peers.

### Acquisition Outcomes

These are the public error codes for the main `create` and `select` paths:

| Path                                  | Code                            | Meaning                                                             |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `create`                              | `E_TARGET_REQUIRED`             | No explicit, Token, or endpoint target resolved.                    |
| `create`, `createMulticast`           | `E_TARGET_CONSTRAINT_FAILED`    | The exact target could not satisfy its connection constraint.       |
| `create`, `createMulticast`           | `E_SERVICE_UNAVAILABLE`         | The target was reached, but the requested provider was unavailable. |
| `create`, `createMulticast`           | `E_SERVICE_ACQUISITION_TIMEOUT` | Exact-target acquisition exceeded `timeout`.                        |
| `create`, `createMulticast`           | `E_PROTOCOL_INCOMPATIBLE`       | Provider protocol negotiation was incompatible.                     |
| `select`                              | `E_SERVICE_NO_MATCH`            | No established provider matched without `wait`.                     |
| `select`                              | `E_SERVICE_AMBIGUOUS`           | More than one established provider matched.                         |
| `select`                              | `E_SERVICE_WAIT_TIMEOUT`        | `wait.timeout` expired while waiting for a provider.                |
| `create`, `createMulticast`, `select` | `E_ABORTED`                     | The supplied acquisition or selection signal was aborted.           |

`selectMulticast` is a snapshot operation: an empty snapshot is valid, so it
does not return `E_SERVICE_NO_MATCH` or wait for a provider.

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
