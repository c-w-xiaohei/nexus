# Nexus Relay

Nexus Relay lets one Nexus graph expose provider-level forwarding into another Nexus graph.

Use it when one JavaScript runtime sits between two adjacent communication graphs and should deliberately forward selected services or stores, for example:

```text
background <-> content relay <-> iframe children
```

Relay is explicit. It is not transparent multi-hop routing, raw envelope forwarding, or a `target.via` tunnel.

## When To Use Relay

Use Relay when all of these are true:

- one runtime hosts more than one configured `Nexus` instance
- each instance represents a different local endpoint face or transport graph
- downstream callers should access a selected upstream service or store through the middle runtime
- the middle runtime must keep policy, identity, lifecycle, and forwarding choices explicit

Do not use Relay just to avoid targeting. If two contexts can already connect directly in one Nexus graph, use normal `nexus.create(...)` or `connectNexusStore(...)` instead.

## Layering

Relay is a product-facing capability exposed through `@nexus-js/core/relay`.

Internally, it is built on ordinary Nexus service and state-provider semantics:

- `relayService(...)` exposes a normal service registration in the downstream graph and implements it by calling an upstream Nexus instance.
- `relayNexusStore(...)` exposes a normal Nexus State service registration in the downstream graph and implements it by projecting an upstream store.

Relay does not merge connection graphs. The middle runtime remains responsible for configuring each local `Nexus` instance and deciding what to forward.

## Import

```ts
import { relayService, relayNexusStore } from "@nexus-js/core/relay";
```

`relayNexusStore` is also re-exported from `@nexus-js/core/state` for Nexus State-focused code.

## Naming Multi-Instance Runtimes

Name a `Nexus` instance after the local graph or endpoint face it represents, not after a remote direction.

Good:

```ts
const chromeNexus = new Nexus<ChromeUserMeta, ChromePlatformMeta>();
const iframeParentNexus = new Nexus<FrameUserMeta, FramePlatformMeta>();
```

Avoid:

```ts
const toBackgroundNexus = new Nexus();
const backgroundNexus = new Nexus(); // misleading if this code runs in content
```

A `Nexus` instance has its own endpoint, identity, policy, services, connections, proxies, and refs. It is not a one-way client for one destination.

## Service Relay

Use `relayService(...)` to expose a downstream service provider that forwards method calls upstream.

```ts
import { Nexus } from "@nexus-js/core";
import { relayService } from "@nexus-js/core/relay";
import { UserProfileToken } from "./shared-contracts";

const chromeNexus = new Nexus<ChromeMeta, ChromePlatform>();
const iframeParentNexus = new Nexus<FrameMeta, FramePlatform>();

chromeNexus.configure({
  endpoint: chromeEndpoint,
});

iframeParentNexus.configure({
  endpoint: iframeParentEndpoint,
});

iframeParentNexus.provide(
  relayService(UserProfileToken, {
    forwardThrough: chromeNexus,
    forwardTarget: {
      descriptor: { context: "background" },
    },
    policy: {
      canCall({ origin, path, operation }) {
        return origin.context === "iframe-child" && operation === "APPLY";
      },
    },
  }),
);
```

Downstream callers use ordinary targeting in their own graph:

```ts
const profile = await iframeChildNexus.create(UserProfileToken, {
  target: {
    descriptor: { context: "iframe-parent" },
  },
});

await profile.update({ name: "Ada" });
```

The iframe child does not know about the upstream Chrome graph. It calls an adjacent provider in the iframe graph.

Important: the same Token can have different provider locations in the upstream and downstream graphs. A Token `defaultCreate.target` is only a graph-local `create(...)` default for the caller's graph. Relay never derives the upstream `forwardTarget` from the shared Token default; configure `forwardThrough` and `forwardTarget` explicitly.

### Service Relay Semantics

`relayService(...)` currently supports serializable request/response method calls.

Default behavior:

- method calls are forwarded with `APPLY`
- nested method paths are forwarded, for example `profile.update(...)`
- `SET` is rejected with a structured relay error
- callback functions, refs, remote resource proxies, and other capability-bearing payloads are rejected by default
- capability-bearing upstream results are rejected before returning to the downstream caller

This default avoids implicit cross-relay capability bridging. If an application needs capability forwarding, model it as an explicit service contract instead of relying on transparent resource tunneling.

### Service Relay Policy Context

`relayService` policy receives trusted direct-caller context from Nexus invocation metadata:

```ts
type RelayServiceCallContext = {
  origin: DownstreamUserMeta;
  relay: DownstreamUserMeta;
  platform: DownstreamPlatformMeta;
  tokenId: string;
  path: (string | number)[];
  operation: "GET" | "SET" | "APPLY";
};
```

- `origin` is the direct downstream caller identity.
- `relay` is the local identity of the relay provider face.
- `platform` is the direct downstream platform metadata.

These values come from Nexus connection metadata, not from user payload.

## State Relay

Use `relayNexusStore(...)` when downstream callers should connect to a store hosted upstream.

```ts
import { relayNexusStore } from "@nexus-js/core/relay";
import { sessionStore } from "./shared-store";

iframeParentNexus.configure({
  endpoint: iframeParentEndpoint,
});

iframeParentNexus.provide(
  relayNexusStore(sessionStore, {
    forwardThrough: chromeNexus,
    forwardTarget: {
      descriptor: { context: "background" },
    },
    policy: {
      canSubscribe({ origin }) {
        return origin.context === "iframe-child";
      },
      canDispatch({ origin, action }) {
        return origin.context === "iframe-child" && action !== "adminReset";
      },
    },
  }),
);
```

Downstream callers connect through the relay provider like any other Nexus State store:

```ts
const store = await connectNexusStore(iframeChildNexus, sessionStore, {
  target: {
    descriptor: { context: "iframe-parent" },
  },
});

await store.actions.setTheme("dark");
```

### State Relay Semantics

`relayNexusStore(...)` is a projection of an upstream authoritative store.

It does not create a second authoritative store and does not run the local store actions as the source of truth.

Important behavior:

- downstream subscribe waits for the upstream baseline before resolving
- the relay owns its own downstream store session id
- downstream versions are allocated by the relay, not copied from upstream versions
- dispatch is forwarded upstream and resolves only after the upstream commit has been projected into a downstream snapshot
- a successful upstream no-op commit still emits a downstream checkpoint snapshot
- upstream disconnect, replacement, or stale target terminalizes downstream subscribers
- a downstream disconnect cleans only that downstream owner's subscriptions

This preserves Nexus State's guarantee that after an awaited action, the downstream mirror has observed the committed update.

### State Relay Policy Context

State relay policies use the same direct-caller identity model:

```ts
type RelayStoreSubscribeContext = {
  origin: DownstreamUserMeta;
  relay: DownstreamUserMeta;
  platform: DownstreamPlatformMeta;
  tokenId: string;
};

type RelayStoreDispatchContext = RelayStoreSubscribeContext & {
  action: string;
};
```

Use `canSubscribe` for read access and `canDispatch` for action access.

## Error Model

Relay failures use `RelayError` with structured `code` values.

Common codes include:

- `E_RELAY_POLICY_DENIED`
- `E_RELAY_PAYLOAD_UNSUPPORTED`
- `E_RELAY_OPERATION_UNSUPPORTED`
- `E_RELAY_UPSTREAM_TARGET_NOT_FOUND`
- `E_RELAY_UPSTREAM_DISCONNECTED`
- `E_RELAY_UPSTREAM_FAILURE`

Treat these as expected control-flow failures at relay boundaries.

## What Relay Does Not Do

Relay intentionally does not provide:

- transparent multi-hop routing
- raw Nexus message forwarding
- `target.via` routing syntax
- automatic merging of two Nexus connection graphs
- automatic cross-relay refs/callback/resource proxy tunneling
- in-place healing of old downstream store sessions after upstream replacement

If the upstream runtime is replaced, downstream relay-backed state handles become terminal. Create fresh handles for a fresh session.

## Related Pages

- Core concepts: `docs/concepts.md`
- Platform and bridge contexts: `docs/platforms.md`
- Package and subpath map: `docs/packages.md`
- Authorization and policy: `docs/auth-and-policy.md`
- Nexus State: `docs/state/README.md`
