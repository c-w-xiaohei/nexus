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

- `conn.get(...)` returns a proxy bound to that remote session.
- `nexus.ref(...)` creates capabilities tied to the original connection scope after crossing the transport boundary.
- Existing raw proxies do not silently retarget after reconnect, daemon restart, iframe reload, or identity handoff.
- Reconnect, get fresh proxies, and pass fresh refs after session replacement.
- Observe session lifetime from the `Connection`: `onDisconnected` reports terminal closure, `nexus.onConnect` reports each ready session once, and `subscribeIdentity` reports the peer's full identity snapshot and updates. None selects a replacement or authorizes recovery.
- `Nexus.release` and `nexus.release` are resource-only operations. Service proxies are not releasable, and `safeRelease` is the Result-returning form for expected release failures.
- Local same-copy closure can use `instanceof NexusDisconnectedError`; cross-context or duplicate-copy code must check `error.code === "E_CONN_CLOSED"`.

Relay-backed services and stores keep this lifecycle model explicit. Relay policy receives direct downstream caller identity from invocation context, and relay-backed store handles become terminal when the upstream source is disconnected, stale, or replaced. Create fresh downstream handles for fresh sessions.

## Documentation Style

For adapter docs:

- Show only adapter-specific setup after referencing the shared contract pattern.
- Avoid redefining service interfaces inline in every adapter guide.
- Keep examples minimal but type-correct.
- Prefer explicit targets in first examples.
- Do not document Token, TokenSpace, endpoint, or adapter default-target fallback.
- State when a helper configures `nexus` directly versus returning config.
- Show class-style service exposure with `@xxNexus.Expose(Token)` and function/object/helper provider exposure with `xxNexus.provide(...)`.

For deeper details, read the repository documentation under `c-w-xiaohei/nexus/docs`.
