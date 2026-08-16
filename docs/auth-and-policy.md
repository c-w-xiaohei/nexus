# Authorization And Policy

Nexus authorization is part of core runtime configuration. Adapter packages can add transport-specific checks before a Nexus connection exists, but core policy is the shared authorization layer that applies across adapters.

Use this page for `policy.canConnect` and `policy.canCall`. Use adapter docs for adapter-specific mechanisms such as Chrome context metadata or node-ipc shared-secret pre-auth.

## Two Authorization Layers

There are two different gates:

- adapter gate
- core policy gate

The adapter gate runs before or while the physical transport is established. It can validate transport facts that only the adapter knows.

Examples:

- a node-ipc shared secret
- a platform-specific context check
- a transport-specific protocol check

The core policy gate runs after Nexus has enough `ContextMeta` and `ConnectionMeta` to evaluate connection and service access. It is configured through `nexus.configure({ policy })` and is the same concept across adapters.

## Configure A Global Policy

Add `policy` to `nexus.configure(...)`:

```ts
import { usingNodeIpcDaemon } from "@nexus-js/node-ipc";

const daemonNexus = usingNodeIpcDaemon({
  appId: "example-app",
  authToken: process.env.NEXUS_IPC_TOKEN,
  policy: {
    canConnect({ remoteIdentity, connection }) {
      return (
        remoteIdentity.context === "node-ipc-client" &&
        connection.observed.authenticated === true
      );
    },

    canCall(context) {
      return context.serviceName === "example:service";
    },
  },
});
```

Both hooks are optional. If no policy hook is configured, Nexus allows the operation.

## `canConnect`

`canConnect` decides whether a logical Nexus connection may complete the handshake.

The context includes:

- `localIdentity`
- `remoteIdentity`
- `connection`
- `direction`: `"incoming"` or `"outgoing"`

Return `true` to allow the connection and `false` to deny it. Throwing or rejecting also denies the connection.

Denied connections do not become ready connections, acquire services, or participate in provider selection.

Denial code:

```text
E_AUTH_CONNECT_DENIED
```

## `canCall`

`canCall` decides whether a peer may invoke a local service or local resource reference.

The context includes:

- `localIdentity`
- `remoteIdentity`
- `connection`
- `connectionId`
- `serviceName`
- `path`
- `operation`: `"GET"`, `"SET"`, or `"APPLY"`

Return `true` to allow the call and `false` to deny it. Throwing or rejecting also denies the call.

`connectionId` is an opaque identifier for policy and audit context only. It is
not a public `ConnectionTarget`, acquisition input, selection key, or routing
handle, and applications must not use it to route or reacquire services.

Denied calls do not invoke the local service implementation.

Denial code:

```text
E_AUTH_CALL_DENIED
```

## Service-Level Policy

Global policy applies to all services. Service-level policy narrows or customizes policy for one exposed service.

Use service-level policy when one service needs stricter rules than the rest of the process:

```ts
nexus.configure({
  endpoint: endpointConfig,
});

nexus.provide(AdminToken, adminService, {
  policy: {
    canCall({ remoteIdentity }) {
      return remoteIdentity.groups?.includes("admin") === true;
    },
  },
});
```

`configure({ providers })` can also attach service-level policy during bootstrap bulk composition, for example `providers: [{ token: AdminToken, service: adminService, policy }]`, but `provide(Token, service, { policy })` is the ordinary provider registration path.

Policy composition is per capability. If a service policy omits `canCall`, Nexus falls back to the global `canCall`. If a service policy provides `canCall`, that service-level hook decides the service call.

Resource references returned by a service keep the policy snapshot from the service invocation that created them. Re-registering a service later does not silently change the policy for existing resource references.

## Metadata Trust Boundaries

Policy decisions are only as strong as the metadata they rely on.

ContextMeta is logical identity. It is usually declared by the peer and should not be treated as OS-verified unless the adapter documentation says it is verified.

ConnectionMeta is adapter-observed data scoped to one connection. It can include facts such as the transport address, an authenticated flag, or adapter-specific context information.

See `docs/identity-and-metadata.md` for the full field placement model and trust boundary guidance.

When writing policy:

- prefer adapter-observed `connection` facts for security decisions
- treat peer-declared `remoteIdentity` fields as routing and product identity unless independently authenticated
- do not assume `pid`, `uid`, or `gid` are OS-verified unless the adapter explicitly documents peer credential support

## Node IPC Example

For node-ipc, shared-secret pre-auth sets `connection.observed.authenticated` before core policy runs:

When composing node-ipc with additional bootstrap configuration, ask the helper for a pure config object with `configure: false`, then combine layers with `composeNexusConfig([...])` before passing the result to `nexus.configure(...)`. This is a low-level bootstrap composition path; the standard path is to call `usingNodeIpcDaemon(...)` directly and register providers through the returned instance, for example `@daemonNexus.Expose(...)` for class services or `daemonNexus.provide(...)` for object services.

```ts
import { composeNexusConfig, nexus } from "@nexus-js/core";
import { usingNodeIpcDaemon } from "@nexus-js/node-ipc";

const daemonConfig = usingNodeIpcDaemon({
  appId: "example-app",
  authToken: process.env.NEXUS_IPC_TOKEN,
  configure: false,
});

nexus.configure(
  composeNexusConfig([
    daemonConfig,
    {
      policy: {
        canConnect({ connection }) {
          return connection.observed.authenticated === true;
        },
      },
    },
  ]),
);
```

`composeNexusConfig([...])` applies layers left-to-right; later layers win for the same domain.

The shared secret proves the peer knows the configured token. Core policy still decides whether that authenticated peer may connect and call services.

## Failure Model

Authorization failure is expected control flow. Prefer safe APIs when you need to handle denial without throwing.

At a high level:

- connection denial prevents the connection from becoming ready
- call denial returns an error to the caller
- local service implementations are not invoked when `canCall` denies
- existing raw proxies remain session-bound and do not silently retarget after reconnect

## Related Pages

- Node IPC adapter: `docs/node-ipc/README.md`
- Core concepts: `docs/concepts.md`
- Identity and metadata: `docs/identity-and-metadata.md`
- Platform selection: `docs/platforms.md`
