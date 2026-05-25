# Identity And Metadata

EndpointMeta is the endpoint's logical identity: what runtime context it is, how the application wants to route to it, and which product-level labels policy may inspect.

PlatformMeta is adapter-observed platform fact: connection source, authentication state, transport facts, and other information the adapter can observe or verify.

## The Short Model

EndpointMeta = self-described product identity + routing identity.

PlatformMeta = adapter-observed connection facts + adapter-verified security facts when available.

Use EndpointMeta for targeting and product identity. Use PlatformMeta for adapter facts and security-sensitive policy. If a field is declared by the peer, treat it as identity; if it is observed or verified by the adapter, treat it as platform fact.

## Data Chain

Metadata moves through Nexus in one direction: from local configuration into remote decisions.

1. A runtime calls `configure(...)` or an adapter helper and provides its local endpoint identity.
2. Nexus stores that identity as the local `EndpointMeta` for the endpoint.
3. During handshake, peers exchange endpoint identity and the adapter attaches observed `PlatformMeta` for the connection.
4. Other contexts see the peer's `EndpointMeta` as `remoteIdentity` and adapter facts as `platform`.
5. Targeting, policy contexts, service-level policy, diagnostics, connection snapshots, and lifecycle handling can then use those typed values.

EndpointMeta is the application-facing identity channel. PlatformMeta is the adapter-facing facts channel.

## Type-Safety Chain

The two metadata types are carried through different parts of the type system. `EndpointMeta` drives targeting and routing types; `PlatformMeta` is available where adapter-observed connection facts are evaluated.

```ts
type AppEndpointMeta =
  | { context: "host"; region: string }
  | { context: "client"; clientId: string }
  | { context: "worker"; workerName: string };

type AppPlatformMeta = {
  authenticated: boolean;
  transport: "local-bus";
};

const appNexus = new Nexus<AppEndpointMeta, AppPlatformMeta>();

const tokens = new TokenSpace<AppEndpointMeta, AppPlatformMeta>({
  name: "example",
});
```

Those type parameters keep one shared metadata model visible to the APIs that need it:

- `Nexus<EndpointMeta, PlatformMeta>` instances
- `TokenSpace<EndpointMeta, PlatformMeta>` namespaces
- Tokens created from that space, whose `defaultTarget` descriptors are checked against `EndpointMeta`
- configured descriptors and matchers, which match `EndpointMeta`
- `policy.canConnect` and `policy.canCall`, which can inspect both peer `EndpointMeta` and adapter-provided `PlatformMeta`
- connection snapshots, diagnostics, and lifecycle handling

This is the type-safety chain: declare the two metadata shapes once, use them in the local Nexus face and shared TokenSpace, and let TypeScript check endpoint targeting against `EndpointMeta` while policy code can also use `PlatformMeta` for adapter facts.

## Choosing Fields

Use these questions to decide where a field belongs.

Put a field in `EndpointMeta` when:

- the runtime declares it about itself
- the field describes product role, runtime context, tenant, region, group, or feature state
- target descriptors or matchers need it for routing
- Token `defaultTarget` values should match it
- policy may inspect it as peer-declared application identity

Put a field in `PlatformMeta` when:

- the adapter observes it from the connection
- the adapter verifies it during authentication or admission
- it describes transport facts, source address, credential result, process information, or platform context
- policy needs stronger security input than peer-declared identity

If the peer says "I am the worker for tenant A", that is `EndpointMeta`. If the adapter proves "this connection authenticated with the tenant A credential", that is `PlatformMeta`.

Avoid putting secrets, large payloads, mutable objects, or frequently changing business state in either metadata channel. Use service calls or Nexus State for application data.

## Providers And Consumers

`EndpointMeta` is provided by the application runtime. It usually comes from `configure(...)`, adapter helper options, or an identity update when routing-relevant identity changes.

`PlatformMeta` is provided by the adapter. The application can configure adapter inputs such as credentials or admission settings, but the resulting platform facts should be treated as adapter-owned connection metadata.

Metadata is consumed by:

- target descriptors, matchers, and Token `defaultTarget` routing defaults that match `EndpointMeta`
- `policy.canConnect` and `policy.canCall`, which can inspect both `EndpointMeta` and `PlatformMeta`
- service-level policy attached through `serviceProvider(...)` or `provide(..., { policy })`
- diagnostics, connection snapshots, and lifecycle handling

## Example: Host, Client, And Worker

This example uses a generic host/client/worker topology. The host exposes a scheduler service, clients call the host, and workers are routed by capability.

```ts
import { Nexus, TokenSpace, serviceProvider } from "@nexus-js/core";

type EndpointMeta =
  | { context: "host"; region: string }
  | { context: "client"; clientId: string; tenantId: string }
  | { context: "worker"; workerName: string; capabilities: string[] };

type PlatformMeta = {
  authenticated: boolean;
  channel: "in-memory" | "tcp";
};

interface SchedulerService {
  enqueue(jobName: string): Promise<void>;
}

const AppTokens = new TokenSpace<EndpointMeta, PlatformMeta>({
  name: "example",
}).space("app");

export const SchedulerToken = AppTokens.token<SchedulerService>("scheduler", {
  defaultTarget: { descriptor: { context: "host" } },
});

const schedulerService: SchedulerService = {
  async enqueue(jobName) {
    console.log("enqueue", jobName);
  },
};

const hostNexus = new Nexus<EndpointMeta, PlatformMeta>();

hostNexus.configure({
  endpoint: {
    implementation: createHostEndpoint(),
    meta: { context: "host", region: "us-east" },
  },
  providers: [serviceProvider(SchedulerToken, schedulerService)],
  matchers: {
    imageWorker: (identity) =>
      identity.context === "worker" &&
      identity.capabilities.includes("image-processing"),
  },
  policy: {
    canConnect({ remoteIdentity, platform }) {
      if (!platform.authenticated) return false;

      return (
        remoteIdentity.context === "client" ||
        remoteIdentity.context === "worker"
      );
    },
  },
});
```

The `context`, `tenantId`, `region`, and `capabilities` fields are `EndpointMeta` because the application uses them for product identity and routing. The `authenticated` and `channel` fields are `PlatformMeta` because the adapter observes or verifies them for each connection.

## Best Practices

- Keep `EndpointMeta` small, serializable, and stable enough for routing.
- Prefer discriminated unions with a `context` field for endpoint roles.
- Use `PlatformMeta` for security-sensitive facts only when the adapter actually observes or verifies them.
- Treat `remoteIdentity` as peer-declared unless your adapter documents stronger guarantees.
- Put shared metadata types next to shared Tokens so every context imports the same model.
- Use `new TokenSpace<EndpointMeta, PlatformMeta>({ name: "..." })` and instance `.space("...")` calls so token defaults, descriptors, and matchers stay type-aligned.
- Use `updateIdentity(...)` only for changes that affect routing, policy, diagnostics, or lifecycle behavior.
- Recreate raw `nexus.create(...)` proxies after session replacement, connection loss, or identity changes that should retarget future calls.
