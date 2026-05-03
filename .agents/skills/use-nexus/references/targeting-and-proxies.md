# Targeting And Proxies

Create proxies from configured consumer contexts.

```ts
const settings = await nexus.create(SettingsToken, {
  target: {
    descriptor: { context: "background" },
  },
});

await settings.saveSettings({ theme: "dark" });
```

## Target Resolution

Target resolution order for unicast proxy creation is:

1. explicit `target` in `nexus.create(...)`
2. Token default target
3. unique endpoint `connectTo` fallback

Keep the explicit target in introductory docs because it is easiest to debug. Use Token defaults for repeated routing intent.

When relying on a Token default target or a unique `connectTo` fallback, still pass the options object.

```ts
const settings = await nexus.create(SettingsToken, { target: {} });
```

## Descriptors And Matchers

Use named descriptors or matchers when the same route is reused.

```ts
nexus.configure({
  descriptors: {
    background: { context: "background" },
  },
  matchers: {
    activeContentScript: (identity) =>
      identity.context === "content-script" && identity.isActive === true,
  },
});

const byDescriptor = await nexus.create(SettingsToken, {
  target: { descriptor: "background" },
});

const byMatcher = await nexus.create(SettingsToken, {
  target: { matcher: "activeContentScript" },
});
```

## Session-Bound Handles

Raw core handles are lifecycle-scoped.

- `nexus.create(...)` returns a proxy bound to the resolved remote session.
- `nexus.ref(...)` creates capabilities that remain tied to the original connection scope after crossing the transport boundary.
- Existing raw proxies do not silently retarget after reconnect, daemon restart, iframe reload, or identity handoff.
- Recreate proxies and pass fresh refs after session replacement.

Nexus Relay does not change these raw-handle rules. Downstream callers still target the adjacent relay provider with ordinary `nexus.create(...)`; the relay provider separately uses `forwardThrough` and `forwardTarget` for its upstream call.
