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

Public types and errors:

- `NodeIpcError`
- `NodeIpcErrorCode`
- `NodeIpcAddress`
- `NodeIpcAddressResolver`
- `NodeIpcSocketAddress`
- `NodeIpcContextMeta`
- `NodeIpcDaemonMeta`
- `NodeIpcClientMeta`
- `NodeIpcConnectionTarget`
- `NodeIpcConnectionMeta`
- factory option types

## Minimal Daemon

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

## Minimal Client

```ts
import { nexus } from "@nexus-js/core";
import { usingNodeIpcClient } from "@nexus-js/node-ipc";
import { EchoToken } from "./shared";

usingNodeIpcClient({
  appId: "example-app",
  defaultTarget: { context: "node-ipc-daemon", appId: "example-app" },
});

const echo = await nexus.create(EchoToken);

console.log(await echo.echo("hello"));
```

## Runtime Notes

- Default socket path: `$XDG_RUNTIME_DIR/nexus/<appId>/<instance>.sock`
- Fallback socket path: `/tmp/nexus-<uid>/<appId>/<instance>.sock`
- `instance` defaults to `default`
- A client `NodeIpcConnectionTarget` identifies a daemon by `appId` and optional `instance`; the adapter resolves that target to a Unix socket before connecting
- Pass `resolveAddress(target)` when daemon locations are not on the default filesystem layout; return a `NodeIpcSocketAddress` or `null` for an unresolved target
- Shared-secret pre-auth is optional and configured with `authToken`
- Core `policy.canConnect` and `policy.canCall` remain the authorization authority after pre-auth
- The client `defaultTarget` applies only to `create(EchoToken)` when the Token has no default; use an exact `NodeIpcConnectionTarget` for another daemon
- `select(EchoToken, { where, wait })` never opens a socket and chooses only available daemon providers
- `NodeIpcConnectionMeta` records the selected target, resolved socket address, and observed socket/authentication facts
- Proxies and refs are session-bound; recreate them after daemon restart or disconnect

Custom target-to-socket resolution:

```ts
import {
  type NodeIpcConnectionTarget,
  type NodeIpcSocketAddress,
  usingNodeIpcClient,
} from "@nexus-js/node-ipc";

const resolveAddress = (
  target: NodeIpcConnectionTarget,
): NodeIpcSocketAddress | null => ({
  kind: "path",
  path: `/var/run/my-daemons/${target.appId}/${target.instance ?? "default"}.sock`,
});

usingNodeIpcClient({
  appId: "example-client",
  defaultTarget: {
    context: "node-ipc-daemon",
    appId: "example-app",
    instance: "main",
  },
  resolveAddress,
});
```

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
