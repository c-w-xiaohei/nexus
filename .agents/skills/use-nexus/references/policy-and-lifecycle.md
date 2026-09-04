# Policy And Lifecycle

Configure policy during bootstrap through `nexus.configure({ policy })`. After `ready`, policy is structural runtime configuration; create a new Nexus instance to change it.

Keep `configure(...)` in main/bootstrap/runtime modules. Service modules should not configure endpoints or policies while declaring implementations.

```ts
nexus.configure({
  endpoint: endpointConfig,
  policy: {
    canConnect({ remoteIdentity }) {
      return remoteIdentity.context === "trusted";
    },
    canCall({ serviceName, operation }) {
      return (
        serviceName === "my-app:services:settings" && operation === "APPLY"
      );
    },
  },
});
```

## Authorization Style

Keep adapter-level checks and core policy separate.

- Use adapter gates for transport-specific pre-auth, such as shared secrets, origin checks, app ids, channels, and nonces.
- Use `policy.canConnect` for app-level connection authorization.
- Use `policy.canCall` for service and operation authorization.
- Preserve core policy as the final authorization authority after adapter pre-auth.

## Lifecycle Style

Raw core handles are lifecycle-scoped.

- `nexus.create(...)` returns a proxy bound to the resolved remote session.
- `nexus.ref(...)` creates capabilities tied to the original connection scope after crossing the transport boundary.
- Existing raw proxies do not silently retarget after reconnect, daemon restart, iframe reload, or identity handoff.
- Recreate proxies and pass fresh refs after session replacement.
- For an exact same-Core ordinary unicast root, `Nexus.getProxyStatus(proxy)` is a current immutable read and `Nexus.subscribeProxyStatus(proxy, listener)` synchronously sends that current snapshot after registration, then each future transition.
- `active/stale` does not make a proxy unusable; `disconnected` is terminal for its local session. Neither status selects a replacement or authorizes recovery.
- `Nexus.inspectProxy(proxy)` is a diagnostic-only snapshot. Its connection ID is opaque and runtime-local; do not use it as a routing input or behavior oracle.
- `Nexus.release` and `nexus.release` are resource-only operations. Service proxies are not releasable, and legacy invalid release behavior is permissive rather than a validation contract.
- Local same-copy closure can use `instanceof NexusDisconnectedError`; cross-context or duplicate-copy code must check `error.code === "E_CONN_CLOSED"`.

Relay-backed services and stores keep this lifecycle model explicit. Relay policy receives direct downstream caller identity from invocation context, and relay-backed store handles become terminal when the upstream source is disconnected, stale, or replaced. Create fresh downstream handles for fresh sessions.

## Documentation Style

For adapter docs:

- Show only adapter-specific setup after referencing the shared contract pattern.
- Avoid redefining service interfaces inline in every adapter guide.
- Keep examples minimal but type-correct.
- Prefer explicit targets in first examples.
- Explain default-target fallback only after the explicit version.
- State when a helper configures `nexus` directly versus returning config.
- Show class-style service exposure with `@xxNexus.Expose(Token)` and function/object/helper provider exposure with `xxNexus.provide(...)`.

For deeper details, read the repository documentation under `c-w-xiaohei/nexus/docs`.
