# Node IPC Quick Start

This guide shows the shortest path to a working daemon/client call with `@nexus-js/node-ipc`.

Both processes need Nexus configuration. The daemon listens and exposes services. The client connects and creates proxies.

## 1. Install Packages

```bash
pnpm add @nexus-js/core @nexus-js/node-ipc
```

## 2. Start From A Shared Contract

Node IPC does not change how Nexus shared contracts work.

Start with the shared token pattern from `docs/getting-started.md`: put the token in shared code, and if the service type already exists elsewhere, import that type instead of redefining it inline.

Assume both daemon and client can already import the shared token:

```ts
import { EchoToken } from "./shared";
```

## 3. Configure The Daemon

The daemon owns the listening endpoint and service implementation.

```ts
import { nexus } from "@nexus-js/core";
import { usingNodeIpcDaemon } from "@nexus-js/node-ipc";
import { EchoToken } from "./shared";

usingNodeIpcDaemon({ appId: "example-app" }).provide(EchoToken, {
  async echo(input) {
    return `echo:${input}`;
  },
});
```

The default daemon identity is a `node-ipc-daemon` descriptor with your `appId` and optional `instance`.

## 4. Configure The Client

The client owns an outgoing endpoint. `connectTo` gives the client a default daemon target.

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

console.log(await echo.echo("hello"));
```

`create(EchoToken)` works when `EchoToken` has a `defaultCreate.target` for the daemon or when the client has exactly one `connectTo` fallback. If neither is true, Nexus fails instead of guessing. Keep an explicit target while debugging or when several daemons are reachable:

```ts
const echo = await nexus.create(EchoToken, {
  target: {
    descriptor: { context: "node-ipc-daemon", appId: "example-app" },
  },
  expects: "one",
});
```

## 5. Add Shared-Secret Pre-Auth

Shared-secret pre-auth is optional but recommended for daemon/client setups where only known local clients should connect.

Daemon:

```ts
usingNodeIpcDaemon({
  appId: "example-app",
  authToken: process.env.NEXUS_IPC_TOKEN,
}).provide(EchoToken, echoService);
```

Client:

```ts
usingNodeIpcClient({
  appId: "example-app",
  connectTo: [
    {
      descriptor: { context: "node-ipc-daemon", appId: "example-app" },
    },
  ],
  authToken: process.env.NEXUS_IPC_TOKEN,
});
```

Empty tokens are rejected. Wrong tokens fail before Nexus core receives the socket.

## 6. Add Core Policy

Use adapter pre-auth to establish `platform.authenticated`, then use core policy to make authorization decisions.

Policy composition is a low-level bootstrap path. Ask the helper for pure config with `configure: false`, then register the provider with `nexus.provide(...)`.

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
    canCall({ serviceName, operation }) {
      return serviceName === "example:echo" && operation === "APPLY";
    },
  },
});

nexus.provide(EchoToken, echoService);
```

For general policy semantics, read `docs/auth-and-policy.md`.

## First Failure Checklist

If the first call fails, check these in order:

1. Is the daemon process still running?
2. Are daemon and client using the same `appId` and `instance`?
3. Does the socket path resolve where you expect? See `docs/node-ipc/addressing.md`.
4. If `authToken` is configured, do both sides use the same non-empty token?
5. Does `policy.canConnect` allow the client?
6. Does `policy.canCall` allow the service name and operation?
7. Are you reusing an old proxy after daemon restart? Create a fresh proxy.

## Next Steps

- Addressing details: `docs/node-ipc/addressing.md`
- Adapter pre-auth: `docs/node-ipc/auth.md`
- Lifecycle and errors: `docs/node-ipc/lifecycle-and-errors.md`
