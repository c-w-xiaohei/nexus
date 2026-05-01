# Runtime Configuration

Configure every context before useful Nexus work can happen. A host context and a consumer context each need endpoint wiring and identity metadata.

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

Each instance has its own endpoint, metadata, policy, services, connections, proxies, and refs. It does not share a connection graph with other instances.

Do not use `@Expose` or `@Endpoint` in multi-instance runtimes. Decorator registrations are process-global, so one instance can consume registrations intended for another. Use explicit `configure({ endpoint, services })` on every instance.

```ts
extensionNexus.configure({
  endpoint: extensionEndpointConfig,
  services: [{ token: ExtensionToken, implementation: extensionService }],
});

brokerNexus.configure({
  endpoint: brokerEndpointConfig,
  services: [{ token: BrokerGatewayToken, implementation: gatewayService }],
});
```

Bridge instances with gateway services. For example, expose a broker-facing service on `brokerNexus` and implement it by creating content-script proxies through `extensionNexus`.

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

Use `configure: false` when composing helper output with `services`, `policy`, extra configuration, or a custom `Nexus` instance.

```ts
nexus.configure({
  ...usingNodeIpcDaemon({
    appId: "example-app",
    configure: false,
  }),
  services: [
    {
      token: EchoToken,
      implementation: echoService,
    },
  ],
});
```

Do not spread a helper result unless `configure: false` is set. Without it, the helper has already configured the shared `nexus` instance and returns a Nexus instance, not a config object.
