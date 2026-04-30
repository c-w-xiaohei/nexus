# Node IPC Concepts

This page explains the adapter mental model. Read `docs/node-ipc/quick-start.md` first if you want working code before concepts.

## Daemon And Client Roles

The node-ipc adapter models one local daemon process and one or more local clients.

The daemon:

- listens on a filesystem Unix socket
- exposes Nexus services
- owns the socket lifecycle

The client:

- connects to a daemon socket
- creates Nexus proxies
- calls services exposed by the daemon

Both sides are normal Nexus runtimes. The adapter only supplies endpoint wiring and metadata.

## Descriptor vs Socket Address

Nexus targets use descriptors. The adapter maps descriptors to socket addresses.

Descriptor example:

```ts
{ context: "node-ipc-daemon", appId: "example-app", instance: "default" }
```

Socket address example:

```ts
{ kind: "path", path: "/run/user/1000/nexus/example-app/default.sock" }
```

Keep this distinction clear:

- descriptors are part of Nexus routing intent
- socket addresses are adapter transport details

Application code should normally target descriptors. Custom resolvers are the escape hatch when you need a specific socket layout.

## Adapter Pre-Auth vs Core Policy

Shared-secret pre-auth is an adapter gate. It proves the peer knows the configured token before the socket is handed to Nexus core.

Core policy is the shared Nexus authorization layer. It decides whether authenticated or unauthenticated peers may complete the logical handshake and call services.

The common pattern is:

1. node-ipc validates the shared secret
2. node-ipc sets `platform.authenticated`
3. `policy.canConnect` checks `platform.authenticated`
4. `policy.canCall` checks service access

## User Metadata vs Platform Metadata

User metadata is logical identity declared by the process.

Daemon metadata shape:

```ts
{
  context: "node-ipc-daemon";
  appId: string;
  instance?: string;
  pid: number;
  groups?: string[];
}
```

Client metadata shape:

```ts
{
  context: "node-ipc-client";
  appId: string;
  pid: number;
  groups?: string[];
}
```

Platform metadata is adapter-observed data:

```ts
{
  socket: NodeIpcSocketAddress;
  authenticated: boolean;
  authMethod?: "none" | "shared-secret";
}
```

The adapter does not currently claim OS-verified peer `pid`, `uid`, or `gid`. Treat `pid` in user metadata as diagnostic self-declared data unless peer credential support is implemented later.

## Framing vs Serialization

Unix sockets are byte streams. The adapter must restore packet boundaries before Nexus core can process packets.

The frame format is:

```text
[uint32 byteLength][ArrayBuffer packet bytes]
```

Framing does not define Nexus message semantics. It only says where one packet ends and the next begins.

Serialization still belongs to core. Current `BinarySerializer` is compact Nexus JSON encoded as UTF-8 bytes, not MessagePack.

## Session-Bound Handles

Raw Nexus proxies and remote refs are tied to the logical connection that created them.

If the daemon restarts or the socket disconnects:

- old proxies should fail
- old remote refs should be treated as invalid
- clients should create a new proxy after reconnecting

This keeps lifecycle boundaries explicit. The raw core proxy does not silently retarget itself to a new daemon session.

## Runtime Boundary

The adapter is a local IPC adapter, not a network adapter.

It does not provide:

- cross-machine transport
- TLS
- service discovery outside local descriptor-to-socket mapping
- durable reconnecting proxy handles
- OS peer credential authorization

Those features can be added above or below the adapter, but they are not part of the current package contract.
