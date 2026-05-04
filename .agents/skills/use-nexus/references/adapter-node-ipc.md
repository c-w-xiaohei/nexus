# Node IPC Adapter

For node-ipc, keep contract code shared and adapter code focused on daemon/client wiring.

## Shared Contract

```ts
import { TokenSpace } from "@nexus-js/core";
import type { NodeIpcPlatformMeta, NodeIpcUserMeta } from "@nexus-js/node-ipc";
import type { EchoService } from "./contracts";

const appSpace = new TokenSpace<NodeIpcUserMeta, NodeIpcPlatformMeta>({
  name: "example-app",
});

const daemonServices = appSpace.tokenSpace("daemon-services", {
  defaultCreate: {
    target: {
      descriptor: { context: "node-ipc-daemon", appId: "example-app" },
    },
  },
});

export const EchoToken = daemonServices.token<EchoService>("echo");
```

## Daemon

For class-style services, bind the class to the daemon Nexus instance.

```ts
import { usingNodeIpcDaemon } from "@nexus-js/node-ipc";
import { EchoToken, type EchoService } from "./shared";

const daemonNexus = usingNodeIpcDaemon({ appId: "example-app" });

@daemonNexus.Expose(EchoToken)
class EchoServiceImpl implements EchoService {
  async echo(input: string) {
    return `echo:${input}`;
  }
}
```

For function/object style, use `daemonNexus.provide(EchoToken, echoService)`.

## Client

Use `nexus.create(EchoToken)` when the Token default target or unique node-ipc `connectTo` fallback supplies the daemon target.

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

const echo = await nexus.create(EchoToken);
```

Use explicit targets for debugging or multiple daemon topologies.

```ts
const echo = await nexus.create(EchoToken, {
  target: {
    descriptor: { context: "node-ipc-daemon", appId: "example-app" },
  },
  expects: "one",
});
```

This works because core resolves `create(Token)` through the Token `defaultCreate.target` or the unique node-ipc `connectTo` fallback.

## Authorization

Treat shared-secret pre-auth as an adapter gate. Keep core policy as the authorization authority after adapter pre-auth.

The standard provider path is helper plus `@daemonNexus.Expose(...)` for class services or `.provide(...)` for object services. If you also need to compose daemon policy at bootstrap, ask the helper for pure config with `configure: false` and configure once.

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

nexus.provide(EchoToken, echoService);
```

Do not spread a node-ipc helper result unless `configure: false` is set. Without it, the helper has already configured the shared `nexus` instance and returns a Nexus instance, not a config object.
