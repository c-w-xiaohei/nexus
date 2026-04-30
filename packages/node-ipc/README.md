# @nexus-js/node-ipc

`@nexus-js/node-ipc` is the Nexus adapter for local daemon/client IPC over filesystem Unix domain sockets.

For the product guide, read `docs/node-ipc/README.md` from the repository root. This package README is a short reference for installation, exports, and the minimum setup shape.

## Install

```bash
pnpm add @nexus-js/core @nexus-js/node-ipc
```

## Exports

Factory helpers:

- `usingNodeIpcDaemon(options)`
- `usingNodeIpcClient(options)`

Matcher helpers:

- `daemon(appId)`
- `client(appId)`
- `instance(name)`
- `group(name)`

Public types and errors:

- `NodeIpcError`
- `NodeIpcErrorCode`
- `NodeIpcAddress`
- `NodeIpcAddressResolver`
- `NodeIpcSocketAddress`
- `NodeIpcUserMeta`
- `NodeIpcDaemonMeta`
- `NodeIpcClientMeta`
- `NodeIpcPlatformMeta`
- factory option types

## Minimal Daemon

```ts
import { nexus, Token } from "@nexus-js/core";
import { usingNodeIpcDaemon } from "@nexus-js/node-ipc";

interface EchoService {
  echo(input: string): Promise<string>;
}

const EchoToken = new Token<EchoService>("example:echo");

await nexus.configure({
  ...usingNodeIpcDaemon({ appId: "example-app" }),
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

## Minimal Client

```ts
import { nexus } from "@nexus-js/core";
import { usingNodeIpcClient } from "@nexus-js/node-ipc";
import { EchoToken } from "./shared";

await nexus.configure(
  usingNodeIpcClient({
    appId: "example-app",
    connectTo: { appId: "example-app" },
  }),
);

const echo = await nexus.create(EchoToken, {
  target: {
    descriptor: { context: "node-ipc-daemon", appId: "example-app" },
  },
});

console.log(await echo.echo("hello"));
```

## Runtime Notes

- Default socket path: `$XDG_RUNTIME_DIR/nexus/<appId>/<instance>.sock`
- Fallback socket path: `/tmp/nexus-<uid>/<appId>/<instance>.sock`
- `instance` defaults to `default`
- Shared-secret pre-auth is optional and configured with `authToken`
- Core `policy.canConnect` and `policy.canCall` remain the authorization authority after pre-auth
- Proxies and refs are session-bound; recreate them after daemon restart or disconnect

## Error Codes

- `E_IPC_ADDRESS_INVALID`
- `E_IPC_ADDRESS_IN_USE`
- `E_IPC_PATH_TOO_LONG`
- `E_IPC_CONNECT_FAILED`
- `E_IPC_AUTH_FAILED`
- `E_IPC_PROTOCOL_ERROR`
- `E_IPC_STALE_SOCKET_CLEANUP_FAILED`

## Tests

```bash
pnpm --filter @nexus-js/node-ipc test
```
