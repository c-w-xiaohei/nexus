# Node IPC Adapter

`@nexus-js/node-ipc` connects local daemon and client processes through filesystem Unix domain sockets. Use it when one long-lived local process exposes Nexus services and one or more local clients call those services.

This guide is about product behavior. For exported type names and package surface, see `packages/node-ipc/README.md`.

## When To Use It

Use `@nexus-js/node-ipc` when your application has:

- one local daemon process that owns services
- one or more local clients, such as CLIs or helper processes
- same-machine communication only
- a Unix socket path that can represent the daemon instance

Do not use it for browser contexts, cross-machine networking, or long-lived handles that must survive daemon restarts without being recreated.

## Runtime Support

The adapter is Linux-first and uses filesystem Unix domain sockets through Node-compatible socket APIs.

It is intended for Node runtimes first. Bun can run many Node-compatible `node:net` Unix socket paths, but Bun support should be treated as compatibility-mode support until the project has Bun CI coverage. The adapter does not use Node `child_process` IPC channels or socket-handle passing.

## Install

```bash
pnpm add @nexus-js/core @nexus-js/node-ipc
```

Both daemon and client processes need `@nexus-js/core`. Each side configures its own endpoint through the node-ipc factory helpers.

## Basic Shape

Shared contract:

```ts
import { Token } from "@nexus-js/core";

export interface EchoService {
  echo(input: string): Promise<string>;
}

export const EchoToken = new Token<EchoService>("example:echo");
```

Daemon process:

```ts
import { nexus } from "@nexus-js/core";
import { usingNodeIpcDaemon } from "@nexus-js/node-ipc";
import { EchoToken } from "./shared";

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

Client process:

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

The daemon owns `listen`. The client owns `connect`. Both still use the same core Nexus target and service model.

## Addressing Model

Nexus descriptors identify logical targets. Socket paths are adapter transport details.

The default daemon descriptor is:

```ts
{ context: "node-ipc-daemon", appId: string, instance?: string }
```

`instance` defaults to `default`.

Default filesystem paths are resolved as:

```text
$XDG_RUNTIME_DIR/nexus/<appId>/<instance>.sock
```

If `XDG_RUNTIME_DIR` is not set, the fallback is:

```text
/tmp/nexus-<uid>/<appId>/<instance>.sock
```

The default resolver rejects unsafe `appId` and `instance` segments. Path separators, path traversal, empty segments, and paths longer than the platform socket path limit fail before bind/connect.

Use a custom resolver when the socket path belongs to your own application layout:

```ts
usingNodeIpcClient({
  appId: "example-app",
  resolveAddress(descriptor) {
    if (descriptor.context !== "node-ipc-daemon") return null;
    return { kind: "path", path: "/run/user/1000/example-app.sock" };
  },
});
```

Returning `null` is explicit. Nexus treats it as an address resolution failure instead of guessing another path.

## Runtime Directory And Stale Socket Safety

Daemon startup creates the socket parent directory with user-private permissions where possible.

If a socket path already exists, the daemon checks whether it is live:

- live socket: startup fails with `E_IPC_ADDRESS_IN_USE`
- stale socket file: the adapter removes it and starts listening
- regular file, symlink, unsafe parent, or unknown cleanup failure: startup fails instead of unlinking blindly

The adapter validates the directory it owns and allows normal system ancestors such as `/`, `/run`, `/run/user`, and `/tmp` when they have safe system ownership semantics.

## Shared-Secret Pre-Auth

Shared-secret pre-auth is an adapter-level gate before the socket is handed to Nexus core.

Configure the daemon with an `authToken`:

```ts
usingNodeIpcDaemon({
  appId: "example-app",
  authToken: process.env.NEXUS_IPC_TOKEN,
});
```

Configure clients with the same token:

```ts
usingNodeIpcClient({
  appId: "example-app",
  connectTo: { appId: "example-app" },
  authToken: process.env.NEXUS_IPC_TOKEN,
});
```

Empty tokens are rejected. Wrong tokens fail with `E_IPC_AUTH_FAILED`. Malformed pre-auth messages fail with `E_IPC_PROTOCOL_ERROR`.

Pre-auth is not a replacement for service authorization. It only proves that the peer knows the shared secret.

## Core Authorization Policy

After adapter pre-auth, Nexus core policy is still the authority for connection and service access.

Use `policy.canConnect` to decide whether a peer may complete the Nexus handshake:

```ts
await nexus.configure({
  ...usingNodeIpcDaemon({ appId: "example-app", authToken }),
  policy: {
    canConnect({ platform }) {
      return platform.authenticated === true;
    },
  },
});
```

Use `policy.canCall` to authorize service calls:

```ts
await nexus.configure({
  ...usingNodeIpcDaemon({ appId: "example-app", authToken }),
  policy: {
    canCall({ serviceName, operation }) {
      return serviceName === "example:echo" && operation === "APPLY";
    },
  },
});
```

Connection denial is reported as `E_AUTH_CONNECT_DENIED`. Service-call denial is reported to the caller as `E_AUTH_CALL_DENIED`, and the local service is not invoked.

## Metadata Semantics

Node-ipc user metadata is logical identity declared by each process:

- daemon: `{ context: "node-ipc-daemon", appId, instance?, pid, groups? }`
- client: `{ context: "node-ipc-client", appId, pid, groups? }`

Platform metadata contains adapter-observed facts:

- socket address
- whether adapter pre-auth succeeded
- auth method: `"none"` or `"shared-secret"`

The adapter does not currently claim OS-verified peer `pid`, `uid`, or `gid`. Treat `pid` in user metadata as self-declared diagnostic data, not an authorization boundary.

## Matchers

The package exports reusable matcher helpers:

```ts
import { daemon, client, group, instance } from "@nexus-js/node-ipc";
```

Use them when registering named matchers or when constructing explicit target rules:

- `daemon(appId)` matches daemon identities for one app id
- `client(appId)` matches client identities for one app id
- `instance(name)` matches daemon instances
- `group(name)` matches identities whose `groups` include the group

## Framing And Serialization

Unix sockets are byte streams. The adapter frames each Nexus L1 packet as:

```text
[uint32 byteLength][ArrayBuffer packet bytes]
```

The frame only restores packet boundaries. Message semantics remain in `@nexus-js/core`.

Current `BinarySerializer` is not MessagePack. It serializes the compact Nexus JSON packet and UTF-8 encodes that JSON into an `ArrayBuffer`. The serializer benchmark compares this current behavior with MessagePack candidates, but the runtime protocol today is still compact JSON over binary packet framing.

## Session-Bound Handles

Raw Nexus proxies and remote refs are bound to the logical connection that created them.

If a daemon restarts, the socket disconnects, auth settings change, or the connection is otherwise replaced:

- old proxies should fail
- old remote refs should be treated as invalid
- callers should create a fresh proxy with `nexus.create()` after reconnecting

This behavior is intentional. Nexus does not silently retarget raw handles across daemon sessions.

## Error Codes

Node-ipc adapter errors:

- `E_IPC_ADDRESS_INVALID`: descriptor or resolver result cannot produce a valid socket address
- `E_IPC_ADDRESS_IN_USE`: another live daemon owns the socket
- `E_IPC_PATH_TOO_LONG`: filesystem socket path exceeds the platform limit
- `E_IPC_CONNECT_FAILED`: socket connection failed
- `E_IPC_AUTH_FAILED`: shared-secret pre-auth failed
- `E_IPC_PROTOCOL_ERROR`: framing or pre-auth protocol was malformed
- `E_IPC_STALE_SOCKET_CLEANUP_FAILED`: stale socket recovery could not safely remove the socket file

Core authorization errors commonly seen with node-ipc:

- `E_AUTH_CONNECT_DENIED`: `policy.canConnect` rejected the handshake
- `E_AUTH_CALL_DENIED`: `policy.canCall` rejected the service call

## Testing A Node IPC Setup

The package includes real Unix socket integration tests for:

- basic daemon/client RPC
- shared-secret auth success and failure
- core `canConnect` and `canCall` policy integration
- stale socket handling
- daemon close and recreate behavior

Run them with:

```bash
pnpm --filter @nexus-js/node-ipc test
```

## Next Steps

- Package surface: `packages/node-ipc/README.md`
- General setup flow: `docs/getting-started.md`
- Platform selection: `docs/platforms.md`
- Package selection: `docs/packages.md`
