# Runtime Configuration

Configure every context before useful Nexus work can happen. A host context and a consumer context each need endpoint wiring and identity metadata.

Read `references/identity-and-metadata.md` when choosing what belongs in `endpoint.meta`, adapter helper identity options, `PlatformMeta`, or `updateIdentity(...)` calls.

Keep `configure(...)` in main/bootstrap/runtime modules. Service implementation modules should import the configured instance and use `@xxNexus.Expose(...)` or `xxNexus.provide(...)`; they should not configure endpoints themselves.

## Adapter Helpers

Prefer adapter helpers for first-party or adapter-provided runtimes.

```ts
usingBackgroundScript();
usingContentScript();
usingPopup({ tabId: activeTabId });
usingIframeParent({
  appId: "app",
  frames: [{ frameId: "preview", iframe, origin: "https://child.example" }],
});
usingIframeChild({
  appId: "app",
  frameId: "preview",
  parentOrigin: "https://host.example",
});
```

Adapter helpers usually configure endpoint implementation, metadata, common matchers, descriptors, and default `connectTo` values.

## Direct Configuration

Use `nexus.configure(...)` directly for custom endpoint wiring or explicit configuration composition.

```ts
nexus.configure({
  endpoint: {
    implementation: endpointImplementation,
    meta: {
      context: "worker",
      role: "host",
    },
  },
  descriptors: {
    host: { context: "worker", role: "host" },
  },
  matchers: {
    primaryClient: (identity) =>
      identity.context === "client" && identity.clientRole === "primary",
  },
});
```

`nexus.configure(...)` is synchronous. Do not write `await nexus.configure(...)` unless a wrapper API itself returns a promise.

## Multiple Nexus Instances

Use `new Nexus()` when one JavaScript context must host independent Nexus runtimes, such as a browser extension background service bridging extension messaging and a local broker transport.

```ts
import { Nexus } from "@nexus-js/core";

const extensionNexus = new Nexus<
  ExtensionEndpointMeta,
  ExtensionPlatformMeta
>();
const brokerNexus = new Nexus<BrokerEndpointMeta, BrokerPlatformMeta>();
```

Each instance has its own endpoint, metadata, policy, services, connections, proxies, refs, and decorator registry. It does not share a connection graph with other instances.

Name instances after their local transport graph or endpoint face, then bind class decorators and providers to that instance.

```ts
extensionNexus.configure({ endpoint: extensionEndpointConfig });
brokerNexus.configure({ endpoint: brokerEndpointConfig });

@extensionNexus.Expose(ExtensionToken)
class ExtensionServiceImpl implements ExtensionService {}

brokerNexus.provide(BrokerGatewayToken, gatewayService);
```

Bridge instances with gateway services. For example, expose a broker-facing service on `brokerNexus` and implement it by creating content-script proxies through `extensionNexus`.

Use `relayService(...)` or `relayNexusStore(...)` from `@nexus-js/core/relay` when the gateway should forward an existing service contract or Nexus State store into another adjacent graph. Configure the relay provider on the downstream-facing instance and pass the upstream-facing instance as `forwardThrough` with an explicit `forwardTarget`.

For a local Nexus State provider, create the authoritative store once with `const { provider, store } = createNexusStore(definition)`. Pass `provider` through `nexus.configure({ providers: [provider] })` or `providers: [provider]`; use `store` only in that same hosting context for local reads, subscriptions, and actions.

Do not model Relay as `target.via`, raw message forwarding, or automatic graph merging. The bridge runtime still owns both configured `Nexus` instances and decides exactly which providers are forwarded.

## Configuration Composition

Adapter helpers have two common shapes:

1. configure immediately and return a Nexus instance
2. return config when explicitly asked for composition

Use direct helper calls for the standard path.

```ts
usingNodeIpcClient({
  appId: "example-app",
  connectTo: [
    {
      descriptor: { context: "node-ipc-daemon", appId: "example-app" },
    },
  ],
});
```

Use `configure: false` when composing helper output with policy, extra configuration, or a custom `Nexus` instance. Compose with `composeNexusConfig([...])`, not raw object spreading.

```ts
import { composeNexusConfig, nexus } from "@nexus-js/core";

nexus.configure(
  composeNexusConfig([
    usingNodeIpcDaemon({
      appId: "example-app",
      configure: false,
    }),
    {
      policy: {
        canConnect({ remoteIdentity }) {
          return remoteIdentity.appId === "example-app";
        },
      },
    },
  ]),
);

nexus.provide(EchoToken, echoService);
```

Layers apply left-to-right, and later layers win for the same domain.

Domain-aware merge rules:

- omitted fields keep previous layers
- `endpoint.meta`, `endpoint.implementation`, and `endpoint.connectTo` are whole-field replacements when explicitly provided
- `endpoint.connectTo: []` clears inherited connection defaults
- `policy` is a whole-field replacement when explicitly provided; omitted policy keeps previous layers
- `policy: undefined` clears inherited policy when callers intentionally need to remove it
- `descriptors` and `matchers` merge by key; later duplicate keys win
- `providers` replace by `token.id`; the later provider replaces both service and policy

Compose structural config before the bootstrap snapshot. After `ready`, structural `configure(...)` calls are rejected; register or replace live providers with `provide(...)`, not `configure({ providers })`.

Do not spread a helper result. Without `configure: false`, the helper has already configured the shared `nexus` instance and returns a Nexus instance, not a config object.
