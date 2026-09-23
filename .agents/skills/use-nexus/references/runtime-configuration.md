# Runtime Configuration

Configure every context before useful Nexus work can happen. A host context and a consumer context each need endpoint wiring and identity metadata.

Read `references/identity-and-metadata.md` when choosing what belongs in `endpoint.meta`, adapter helper identity options, `ConnectionMeta`, or `updateIdentity(...)` calls.

Keep `configure(...)` in main/bootstrap/runtime modules. Service implementation modules should import the configured instance and use `@xxNexus.Expose(...)` or `xxNexus.provide(...)`; they should not configure endpoints themselves.

## Adapter Helpers

Prefer adapter helpers for first-party or adapter-provided runtimes.

```ts
usingBackgroundScript();
usingContentScript();
usingPopup();
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

Adapter helpers configure endpoint implementation and metadata. Application code supplies exact connection targets to `connect` or `connectMulticast`.

Explicit `connectTo` targets configure one-shot startup dialing, independently of
service acquisition. Core starts them after listening, without waiting for a remote
Token or delaying `ready()`. Failures are logged through the Nexus logger; there
is no automatic retry or reconnect. Do not infer startup targets from a default
route or create a dummy service proxy just to connect.

Chrome custom page helpers take `createExtensionPageConfig(meta, options?)` or
`usingExtensionPage(meta, options?)`. Put `connectTo` and optional `endpointId` in
the second argument; the first argument is only application-owned identity
metadata. Use `chromeTarget.extensionPage({ endpointId })` for those custom pages
only. Built-in helpers auto-identify their local receiver facts where Chrome
exposes them: `usingPopup()` resolves its current window, `usingDevToolsPage()`
reads the inspected tab, `usingOptionsPage()` is the designated profile
receiver, and `usingOffscreenDocument({ reason })` is the profile singleton.
`usingSidePanel()` targets the currently running panel for a browser window;
`chromeTarget.sidePanel({ windowId })` is the caller-side target. Content targets
are the native exact routes `contentFrame({ tabId, frameId })` and
`contentDocument({ tabId, documentId })`. Receiver helper identification and
caller target selection are separate. Targets are routing, ContextMeta is
identity, and policy remains authorization. The custom endpoint ID is a local
routing label in the native Port name, not an authentication credential or
identity.

`connect({ target })` only acquires or dials an existing ready receiver. It does
not open or create Popup, Options, Side Panel, Offscreen, or DevTools contexts,
and it does not inject Content Script code. Opening, activation, creation, and
readiness are separate application or Chrome lifecycle operations.

All Runtime-capable Chrome contexts can dial built-in page targets and custom
addressed extension pages. Ordinary extension pages can also dial exact content
frame/document targets using `tabs.connect`; content scripts and offscreen
documents cannot. Existing connections are bidirectional. Use explicit
application-owned gateway services when an intermediate context is required,
not transparent target routing. Native Port name filtering belongs to the
adapter and does not replace Core authorization.

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
});
```

`nexus.configure(...)` is synchronous. Do not write `await nexus.configure(...)` unless a wrapper API itself returns a promise.

## Multiple Nexus Instances

Use `new Nexus()` when one JavaScript context must host independent Nexus runtimes, such as a browser extension background service bridging extension messaging and a local broker transport.

```ts
import { Nexus } from "@nexus-js/core";

const extensionNexus = new Nexus<ExtensionAdapterModel>();
const brokerNexus = new Nexus<BrokerAdapterModel>();
```

Each instance has its own endpoint, metadata, policy, services, connections, proxies, refs, and decorator store. It does not share a connection graph with other instances.

Name instances after their local transport graph or endpoint face, then bind class decorators and providers to that instance.

```ts
extensionNexus.configure({ endpoint: extensionEndpointConfig });
brokerNexus.configure({ endpoint: brokerEndpointConfig });

@extensionNexus.Expose(ExtensionToken)
class ExtensionServiceImpl implements ExtensionService {}

brokerNexus.provide(BrokerGatewayToken, gatewayService);
```

Bridge instances with gateway services. For example, expose a broker-facing service on `brokerNexus` and implement it by creating content-script proxies through `extensionNexus`.

For a local Nexus State provider, create a StoreToken first, then create the authoritative store with `createNexusStore(token, creator, { snapshot, expose, publishWindowMs?, maxPendingSnapshots? })`, or bind an existing native Zustand store with `bindNexusStore(token, existingStore, options)`. Register the provider with `nexus.provide(provider)`; use the returned original `store` only in that same hosting context for local reads, subscriptions, and synchronous actions. The defaults are a fixed 200ms publication window and 32 pending snapshots.

## Configuration Composition

Adapter helpers have two common shapes:

1. configure immediately and return a Nexus instance
2. return config when explicitly asked for composition

Use direct helper calls for the standard path.

```ts
const daemonTarget = {
  context: "node-ipc-daemon",
  appId: "example-app",
} satisfies import("@nexus-js/node-ipc").NodeIpcConnectionTarget;

usingNodeIpcClient({
  appId: "example-app",
});
```

Use `configure: false` when composing helper output with policy, extra configuration, or a custom `Nexus` instance. Compose with `composeNexusConfig([...])`, not raw object spreading.

```ts
import { EchoToken, type EchoService } from "./shared";
import { composeNexusConfig, nexus } from "@nexus-js/core";
import { usingNodeIpcDaemon } from "@nexus-js/node-ipc";

const echoService: EchoService = {
  async echo(input) {
    return `echo:${input}`;
  },
};

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
- `endpoint.meta`, `endpoint.implementation`, and `endpoint.connectTo` are whole-field replacements when explicitly provided; `connectTo: []` disables inherited startup targets
- `policy` is a whole-field replacement when explicitly provided; omitted policy keeps previous layers
- `policy: undefined` clears inherited policy when callers intentionally need to remove it
- `providers` replace by `token.id`; the later provider replaces both service and policy

Compose structural config before the bootstrap snapshot. After `ready`, structural `configure(...)` calls are rejected; register or replace live providers with `provide(...)`, not `configure({ providers })`.

Do not spread a helper result. Without `configure: false`, the helper has already configured the shared `nexus` instance and returns a Nexus instance, not a config object.
