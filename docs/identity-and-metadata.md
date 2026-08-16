# Identity And Connection Metadata

Nexus separates three information sources:

- Application code supplies a `ConnectionTarget` to acquire one exact connection.
- `ContextMeta` is peer-declared product identity supplied through the handshake.
- `ConnectionMeta` is local adapter observation or verification for one connection session.

They have different owners, trust boundaries, and lifecycles.

## ContextMeta

An endpoint declares its identity during configuration and the handshake. Typical fields include a discriminating `context`, application metadata, URL, origin, tenant, or product capabilities. The remote peer sees this as `remoteIdentity`.

Use `ContextMeta` for:

- product role and runtime context
- application-level labels used by `where`
- values used by a Token's `defaultTarget` when the adapter's target type intentionally overlaps them
- policy decisions that explicitly accept peer-declared identity as their trust level

Keep it small, serializable, and stable. Do not put secrets, mutable service state, or local adapter observations in it.

## ConnectionMeta

An adapter creates `ConnectionMeta` when a concrete connection is accepted or opened. It is connection-scoped, read-only, and retained only for that logical connection session. Examples include:

```ts
type LocalConnectionMeta = {
  observed: {
    transport: "socket" | "port";
    authenticated: boolean;
  };
};
```

Use it for transport facts, observed sender information, authentication results, source checks, or other adapter-owned facts. `ConnectionMeta` is available to `policy.canConnect`, `policy.canCall`, diagnostics, and adapter matching. It is not exchanged as endpoint identity and is not a generic target shape.

Chrome's selected route, when an outgoing adapter implementation keeps one for reuse or diagnostics, is private implementation state. It must not be documented or modeled as a public `ConnectionMeta` contract. Public Chrome connection metadata is the observed connection information exposed by the adapter.

## AdapterModel Association

Adapters bind their metadata and targeting types through one `AdapterModel`:

```ts
import type { AdapterModel } from "@nexus-js/core";

interface AppModel extends AdapterModel {
  contextMeta:
    | { context: "host"; region: string }
    | { context: "client"; clientId: string };
  connectionMeta: {
    readonly transport: "trusted" | "untrusted";
  };
  connectionTarget: { context: "host" };
}
```

Use `Nexus<AppModel>`, `TokenSpace<AppModel>`, and `IEndpoint<AppModel>` together. `AdapterModel` only associates compile-time types; it does not validate arbitrary wire data or make peer identity trusted.

## Targeting Metadata

`ConnectionTarget` is the adapter's exact connection input. `create` and `createMulticast` acquire targets asynchronously and bind the selected sessions. Neither changes the meaning of `ContextMeta`.

`where` receives each selected connection's peer-declared context identity and local adapter facts:

```ts
const clients = await appNexus.selectMulticast(ClientToken, {
  where: (contextMeta, connectionMeta) =>
    contextMeta.context === "client" &&
    contextMeta.clientId !== "admin" &&
    connectionMeta.transport === "trusted",
});
```

The target match and `where` predicate are strict AND conditions. `selectMulticast` binds a creation-time snapshot of currently available providers and never discovers or connects to a new provider. Call it again to select providers that appear later.

## Policy Trust Boundary

Policy context uses `remoteIdentity` for `ContextMeta` and `connection` for `ConnectionMeta`:

```ts
nexus.configure({
  policy: {
    canConnect({ remoteIdentity, connection }) {
      return (
        remoteIdentity.context === "client" &&
        connection.transport === "trusted"
      );
    },
  },
});
```

Treat `remoteIdentity` as peer-declared unless the adapter documents stronger verification. Prefer adapter-observed or adapter-verified connection facts for security decisions. Do not assume process IDs, user IDs, origins, or sender fields are trustworthy beyond the adapter's documented guarantees.

## Updating Identity

Use `updateIdentity()` only for local endpoint identity changes that affect routing, policy, diagnostics, or lifecycle behavior. It does not mutate existing `ConnectionMeta`, change an existing session's target, or rebind old proxies.

After session replacement, recreate proxies, references, and remote State handles. Discovery and replacement policy belong to the application.

## First-Party Examples

The first-party adapter types are public and adapter-specific:

- Chrome: `ChromeContextMeta`, `ChromeConnectionMeta`, `ChromeConnectionTarget`, and `ChromeAdapterModel`
- Node IPC: `NodeIpcContextMeta`, `NodeIpcConnectionMeta`, `NodeIpcConnectionTarget`, and `NodeIpcAdapterModel`
- Iframe: `IframeContextMeta`, `IframeConnectionMeta`, `IframeConnectionTarget`, and `IframeAdapterModel`

Use the adapter's factory and smart constructors rather than manually reconstructing platform internals.
