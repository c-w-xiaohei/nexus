# Node IPC Adapter

For node-ipc, keep contract code shared and adapter code focused on daemon/client wiring.

## Shared Contract

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

## Daemon

Use `configure: false` when composing daemon helper output with explicit service registration.

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

## Client

Prefer explicit daemon targets in introductory examples.

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

Use the Token default target for repeated daemon routing after showing the explicit form.

```ts
const echo = await nexus.create(EchoToken, { target: {} });
```

This works because core resolves the empty target to the Token default target, and the node-ipc client endpoint resolves the daemon descriptor to a Unix socket path.

## Authorization

Treat shared-secret pre-auth as an adapter gate. Keep core policy as the authorization authority after adapter pre-auth.

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

Do not spread a node-ipc helper result unless `configure: false` is set. Without it, the helper has already configured the shared `nexus` instance and returns a Nexus instance, not a config object.
