# Node IPC Adapter

For node-ipc, keep contract code shared and adapter code focused on daemon/client wiring.

## Shared Contract

```ts
import { Token } from "@nexus-js/core";
import type { NodeIpcConnectionTarget } from "@nexus-js/node-ipc";
import type { EchoService } from "./contracts";

export const daemonTarget = {
  context: "node-ipc-daemon",
  appId: "example-app",
} satisfies NodeIpcConnectionTarget;

// This shared target-free contract is usable by another model.
export const EchoToken = new Token<EchoService>("example-app:echo");
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

Use `nexus.connect({ target })` with the daemon's exact target, then
`connection.get(EchoToken)`.

```ts
import { nexus } from "@nexus-js/core";
import { usingNodeIpcClient } from "@nexus-js/node-ipc";
import { EchoToken } from "./shared";

usingNodeIpcClient({
  appId: "example-app",
});

const connection = await nexus.connect({
  target: { context: "node-ipc-daemon", appId: "example-app" },
});
const echo = connection.get(EchoToken);
```

Use explicit targets for debugging or multiple daemon topologies.

```ts
const connection = await nexus.connect({
  target: daemonTarget,
});
const echo = connection.get(EchoToken);
```

Targetless `connect({ where, timeout, signal })` waits for one existing ready
connection and never opens a socket or discovers a provider. Use `canConnect` and
`canCall` for authorization.

## Authorization

Treat shared-secret pre-auth as an adapter gate. Keep core policy as the authorization authority after adapter pre-auth.

The standard provider path is helper plus `@daemonNexus.Expose(...)` for class services or `.provide(...)` for object services. If you also need to compose daemon policy at bootstrap, ask the helper for pure config with `configure: false`, combine layers with `composeNexusConfig([...])`, and configure once.

```ts
import type { EchoService } from "./contracts";
import { composeNexusConfig, nexus } from "@nexus-js/core";
import { EchoToken } from "./shared";

const echoService: EchoService = {
  async echo(input) {
    return `echo:${input}`;
  },
};

nexus.configure(
  composeNexusConfig([
    usingNodeIpcDaemon({
      appId: "example-app",
      authToken: process.env.NEXUS_IPC_TOKEN,
      configure: false,
    }),
    {
      policy: {
        canConnect({ connection }) {
          return connection.observed.authenticated === true;
        },
      },
    },
  ]),
);

nexus.provide(EchoToken, echoService);
```

Do not spread a node-ipc helper result. Without `configure: false`, the helper has already configured the shared `nexus` instance and returns a Nexus instance, not a config object.
