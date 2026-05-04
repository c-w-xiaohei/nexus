# Runtime Configuration

Configure every context before useful Nexus work can happen. A host context and a consumer context each need endpoint wiring and identity metadata.

Keep `configure(...)` in main/bootstrap/runtime modules. Service implementation modules should import the configured instance and use `@xxNexus.Expose(...)` or `xxNexus.provide(...)`; they should not configure endpoints themselves.

## Adapter Helpers

Prefer adapter helpers for first-party or adapter-provided runtimes.

```ts
usingBackgroundScript();
usingContentScript();
await usingPopup();
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
    activeClient: (identity) =>
      identity.context === "client" && identity.isActive === true,
  },
});
```

`nexus.configure(...)` is synchronous. Do not write `await nexus.configure(...)` unless a wrapper API itself returns a promise.

## Multiple Nexus Instances

Use `new Nexus()` when one JavaScript context must host independent Nexus runtimes, such as a browser extension background service bridging extension messaging and a local broker transport.

```ts
import { Nexus } from "@nexus-js/core";

const extensionNexus = new Nexus<ExtensionUserMeta, ExtensionPlatformMeta>();
const brokerNexus = new Nexus<BrokerUserMeta, BrokerPlatformMeta>();
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

Use `configure: false` when composing helper output with policy, extra configuration, or a custom `Nexus` instance.

```ts
nexus.configure({
  ...usingNodeIpcDaemon({
    appId: "example-app",
    configure: false,
  }),
});

nexus.provide(EchoToken, echoService);
```

Do not spread a helper result unless `configure: false` is set. Without it, the helper has already configured the shared `nexus` instance and returns a Nexus instance, not a config object.
