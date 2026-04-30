# Nexus External Usage Style

This reference describes the preferred style for application code that uses Nexus from the outside. It summarizes the current public API conventions and documentation tone.

## Mental Model

Nexus application code usually has four parts:

1. shared service contracts and Tokens
2. runtime configuration in every context
3. service exposure in host contexts
4. proxy creation in consumer contexts

Keep those concerns separate in examples and docs. Adapter docs should not redefine the whole service contract pattern unless the topic is explicitly shared contracts.

## Shared Contracts And Tokens

Define service interfaces and Tokens in shared modules imported by both host and consumer contexts.

Preferred pattern:

```ts
import { TokenSpace } from "@nexus-js/core";
import type { ChromePlatformMeta, ChromeUserMeta } from "@nexus-js/chrome";

export interface SettingsService {
  getSettings(): Promise<Record<string, unknown>>;
  saveSettings(settings: Record<string, unknown>): Promise<void>;
}

const appSpace = new TokenSpace<ChromeUserMeta, ChromePlatformMeta>({
  name: "my-extension",
});

const backgroundServices = appSpace.tokenSpace("background-services", {
  defaultTarget: {
    descriptor: { context: "background" },
  },
});

export const SettingsToken =
  backgroundServices.token<SettingsService>("settings");
```

Use `TokenSpace` when token IDs should be hierarchical or a family of tokens should share default targeting. Use direct `new Token<T>(...)` only for small examples or when namespacing/default targets are unnecessary.

Avoid defining an anonymous service shape inline at call sites. Import the existing service type when it already exists.

Good:

```ts
import type { SettingsService } from "./contracts";

export const SettingsToken = services.token<SettingsService>("settings");
```

Avoid:

```ts
export const SettingsToken = services.token<{
  getSettings(): Promise<Record<string, unknown>>;
}>("settings");
```

## Runtime Configuration

Every context needs runtime configuration before useful Nexus work can happen. A host context and a consumer context each need their own endpoint wiring and identity metadata.

For first-party or adapter-provided runtimes, prefer adapter helpers:

```ts
usingBackgroundScript();
usingContentScript();
await usingPopup();
usingIframeParent({ appId: "app", frames: [] });
usingIframeChild({ appId: "app", parentOrigin: "https://host.example" });
```

Adapter helpers usually configure endpoint implementation, metadata, common matchers, descriptors, and default `connectTo` values.

Use `nexus.configure(...)` directly when code needs custom endpoint wiring or explicit configuration composition:

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

Each instance has its own endpoint, metadata, policy, services, connections, proxies, and refs. It does not share a connection graph with the other instances.

Do not use `@Expose` or `@Endpoint` in multi-instance runtimes. Decorator registrations are process-global, so one instance can consume registrations intended for another. Use explicit `configure({ endpoint, services })` on every instance:

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

## Exposing Services

Use `@Expose(Token)` for the normal singleton Nexus setup:

```ts
import { Expose } from "@nexus-js/core";
import { SettingsToken, type SettingsService } from "./shared";

@Expose(SettingsToken)
class SettingsServiceImpl implements SettingsService {
  async getSettings() {
    return {};
  }

  async saveSettings(settings: Record<string, unknown>) {
    await persist(settings);
  }
}
```

Use explicit `configure({ services })` for multi-instance setups, tests, or architectures that avoid process-global decorators:

```ts
nexus.configure({
  endpoint: endpointConfig,
  services: [
    {
      token: SettingsToken,
      implementation: settingsService,
    },
  ],
});
```

Decorator registrations are process-global. Multi-instance or isolated test setups must use explicit services.

## Creating Proxies

Create a proxy from a configured consumer context:

```ts
const settings = await nexus.create(SettingsToken, {
  target: {
    descriptor: { context: "background" },
  },
});

await settings.saveSettings({ theme: "dark" });
```

Target resolution order for unicast proxy creation is:

1. explicit `target` in `nexus.create(...)`
2. Token default target
3. unique endpoint `connectTo` fallback

Keep the explicit target in introductory docs because it is easiest to debug. Use Token defaults for repeated routing intent.

When relying on a Token default target or a unique `connectTo` fallback, still pass the options object:

```ts
const settings = await nexus.create(SettingsToken, { target: {} });
```

Use named descriptors or matchers when the same route is reused:

```ts
nexus.configure({
  descriptors: {
    background: { context: "background" },
  },
  matchers: {
    activeContentScript: (identity) =>
      identity.context === "content-script" && identity.isActive === true,
  },
});

const byDescriptor = await nexus.create(SettingsToken, {
  target: { descriptor: "background" },
});

const byMatcher = await nexus.create(SettingsToken, {
  target: { matcher: "activeContentScript" },
});
```

## Adapter Helpers Versus Configuration Composition

Adapter helpers have two common shapes:

1. configure immediately and return a Nexus instance
2. return config when explicitly asked for composition

Use direct helper calls for the standard path:

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

Use `configure: false` for node-ipc when composing with `services`, `policy`, or extra configuration:

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

Do not spread a node-ipc helper result unless `configure: false` is set. Without it, the helper has already configured the shared `nexus` instance and returns a Nexus instance, not a config object.

## Node IPC Style

For node-ipc, keep contract code shared and adapter code focused on daemon/client wiring.

Shared contract:

```ts
import { TokenSpace } from "@nexus-js/core";
import type { NodeIpcPlatformMeta, NodeIpcUserMeta } from "@nexus-js/node-ipc";

export interface EchoService {
  echo(input: string): Promise<string>;
}

const appSpace = new TokenSpace<NodeIpcUserMeta, NodeIpcPlatformMeta>({
  name: "example-app",
});

const daemonServices = appSpace.tokenSpace("daemon-services", {
  defaultTarget: {
    descriptor: { context: "node-ipc-daemon", appId: "example-app" },
  },
});

export const EchoToken = daemonServices.token<EchoService>("echo");
```

Daemon with explicit service registration:

```ts
import { nexus } from "@nexus-js/core";
import { usingNodeIpcDaemon } from "@nexus-js/node-ipc";
import { EchoToken } from "./shared";

nexus.configure({
  ...usingNodeIpcDaemon({ appId: "example-app", configure: false }),
  services: [
    {
      token: EchoToken,
      implementation: {
        async echo(input) {
          return `echo:${input}`;
        },
      },
    },
  ],
});
```

Client with explicit target:

```ts
import { nexus } from "@nexus-js/core";
import { usingNodeIpcClient } from "@nexus-js/node-ipc";
import { EchoToken } from "./shared";

usingNodeIpcClient({
  appId: "example-app",
  connectTo: [
    {
      descriptor: { context: "node-ipc-daemon", appId: "example-app" },
    },
  ],
});

const echo = await nexus.create(EchoToken, {
  target: {
    descriptor: { context: "node-ipc-daemon", appId: "example-app" },
  },
});
```

Client relying on Token default target:

```ts
const echo = await nexus.create(EchoToken, { target: {} });
```

This works because core resolves the empty target to the Token default target, and the node-ipc client endpoint resolves the daemon descriptor to a Unix socket path.

## Iframe Style

For iframe integrations, keep contracts shared and keep parent/child setup focused on iframe wiring.

Shared contract:

```ts
import { TokenSpace } from "@nexus-js/core";
import type { IframePlatformMeta, IframeUserMeta } from "@nexus-js/iframe";

export interface GreetingService {
  greet(name: string): Promise<string>;
}

const appSpace = new TokenSpace<IframeUserMeta, IframePlatformMeta>({
  name: "iframe-demo",
});

const childServices = appSpace.tokenSpace("child-services", {
  defaultTarget: {
    descriptor: {
      context: "iframe-child",
      appId: "iframe-demo",
      frameId: "preview",
    },
  },
});

export const GreetingToken = childServices.token<GreetingService>("greeting");
```

Parent with explicit target:

```ts
usingIframeParent({
  appId: "iframe-demo",
  frames: [
    {
      frameId: "preview",
      iframe,
      origin: "https://child.example.com",
    },
  ],
});

const greeting = await nexus.create(GreetingToken, {
  target: {
    descriptor: {
      context: "iframe-child",
      appId: "iframe-demo",
      frameId: "preview",
      origin: "https://child.example.com",
    },
  },
});
```

Child with explicit service registration:

```ts
nexus.configure({
  ...usingIframeChild({
    appId: "iframe-demo",
    frameId: "preview",
    parentOrigin: "https://parent.example.com",
    configure: false,
  }),
  services: [{ token: GreetingToken, implementation: greetingService }],
});
```

Use exact origins, add `nonce` when a frame session needs extra binding, and avoid `allowAnyOrigin: true` except for intentionally public frames. Proxies and refs are session-bound; recreate them after iframe reloads or reconnects.

## Policy And Authorization

Configure policy through `nexus.configure({ policy })`.

```ts
nexus.configure({
  endpoint: endpointConfig,
  policy: {
    canConnect({ remoteIdentity, platform }) {
      return (
        platform.authenticated === true || remoteIdentity.context === "trusted"
      );
    },
    canCall({ serviceName, operation }) {
      return (
        serviceName === "my-app:services:settings" && operation === "APPLY"
      );
    },
  },
});
```

For node-ipc, shared-secret pre-auth is an adapter gate. Core policy remains the authorization authority after adapter pre-auth:

```ts
nexus.configure({
  ...usingNodeIpcDaemon({
    appId: "example-app",
    authToken: process.env.NEXUS_IPC_TOKEN,
    configure: false,
  }),
  policy: {
    canConnect({ platform }) {
      return platform.authenticated === true;
    },
  },
});
```

## Lifecycle Style

Raw core handles are lifecycle-scoped.

- `nexus.create(...)` returns a proxy bound to the resolved remote session.
- `nexus.ref(...)` creates capabilities that remain tied to the original connection scope after crossing the transport boundary.
- Existing raw proxies do not silently retarget after reconnect, daemon restart, or identity handoff.
- Recreate proxies and pass fresh refs after session replacement.

## Documentation Style

For adapter docs:

- Show only adapter-specific setup after referencing the shared contract pattern.
- Avoid redefining service interfaces inline in every adapter guide.
- Keep examples minimal but type-correct.
- Prefer explicit targets in first examples.
- Explain default-target fallback only after the explicit version.
- State when a helper configures `nexus` directly versus returning config.

For deeper details, read the repository documentation under `c-w-xiaohei/nexus/docs`.
