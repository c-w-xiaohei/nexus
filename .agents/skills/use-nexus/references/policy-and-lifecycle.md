# Policy And Lifecycle

Configure policy through `nexus.configure({ policy })`.

```ts
nexus.configure({
  endpoint: endpointConfig,
  policy: {
    canConnect({ remoteIdentity, platform }) {
      return (
        platform.authenticated === true || remoteIdentity.context === "trusted"
      );
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

## Documentation Style

For adapter docs:

- Show only adapter-specific setup after referencing the shared contract pattern.
- Avoid redefining service interfaces inline in every adapter guide.
- Keep examples minimal but type-correct.
- Prefer explicit targets in first examples.
- Explain default-target fallback only after the explicit version.
- State when a helper configures `nexus` directly versus returning config.

For deeper details, read the repository documentation under `c-w-xiaohei/nexus/docs`.
