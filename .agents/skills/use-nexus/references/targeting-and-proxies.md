# Targeting And Proxies

Create proxies from configured consumer contexts.

Read `references/identity-and-metadata.md` when Token `defaultTarget`, exact targets, `where`, or identity replacement depend on `ContextMeta`; policy may also inspect adapter-provided `ConnectionMeta`.

```ts
import {
  chromeTarget,
  usingContentScript,
  whereContentScript,
} from "@nexus-js/chrome";
import type { ChromeAdapterModel } from "@nexus-js/chrome";
import type { NexusInstance } from "@nexus-js/core";
import { SettingsToken } from "./shared";

const chromeNexus: NexusInstance<ChromeAdapterModel> = usingContentScript();
const abortController = new AbortController();
const tabId = 7;
const documentId = "doc-7";

const settings = await chromeNexus.create(SettingsToken, {
  target: chromeTarget.background(),
});

await settings.saveSettings({ theme: "dark" });
```

## Acquisition And Selection

Target resolution order for unicast proxy creation is:

1. explicit `target` in `nexus.create(...)`
2. Token `defaultTarget`
3. endpoint `defaultTarget`

`create` reuses or opens one exact target, waits for its provider, and binds the returned session. `timeout` and `signal` bound acquisition; `callTimeout` controls later RPC calls. It does not retry or discover contexts.

When relying on a Token or endpoint `defaultTarget`, call `create(Token)` directly.

```ts
const settings = await chromeNexus.create(SettingsToken);
```

Use `select` when the caller wants an available provider without connecting:

```ts
const settings = await chromeNexus.select(SettingsToken, {
  where: whereContentScript,
  wait: { timeout: 30_000, signal: abortController.signal },
  callTimeout: 5_000,
});
```

## Exact Targets And Where

Use adapter targets for one exact endpoint, `createMulticast` for explicit target acquisition, and `selectMulticast` for a current provider snapshot.

```ts
const byTarget = await chromeNexus.create(SettingsToken, {
  target: chromeTarget.contentDocument({ tabId, documentId }),
});

const current = await chromeNexus.selectMulticast(SettingsToken, {
  where: (contextMeta, _connectionMeta) =>
    contextMeta.context === "content-script" && contextMeta.isVisible === true,
});

const backgroundService = await chromeNexus.create(SettingsToken, {
  target: chromeTarget.background(),
});
```

`target` and `targets` acquire exact endpoints and bind their sessions. `selectMulticast` snapshots available providers and never calls the adapter to connect. `where(contextMeta, connectionMeta)` filters remote identity and local adapter facts.

For multicast, provide non-empty explicit targets:

```ts
const selected = await chromeNexus.createMulticast(SettingsToken, {
  targets: [tabId, 8].map((tabId) =>
    chromeTarget.contentFrame({ tabId, frameId: 0 }),
  ),
  where: (contextMeta, _connectionMeta) =>
    contextMeta.context === "content-script",
});

const current = await chromeNexus.selectMulticast(SettingsToken, {
  where: (contextMeta, _connectionMeta) =>
    contextMeta.context === "content-script" && contextMeta.isVisible === true,
});
```

`createMulticast` requires a non-empty `targets` array; an empty array is `E_USAGE_INVALID`. It actively acquires every exact target under one acquisition deadline, deduplicates the accepted sessions stably, and fails the whole operation if any target cannot be acquired or does not provide the Token. It returns no partial multicast proxy. `selectMulticast` performs one ready-provider snapshot, never connects, has no `wait` option, and permits a valid empty all/stream result; call it again to include later providers.

## Multicast Signatures, Deadlines, And Errors

The public signatures are:

```ts
await chromeNexus.createMulticast(SettingsToken, {
  targets: [chromeTarget.contentFrame({ tabId, frameId: 0 })],
  where?,
  expects?: "all" | "stream",
  timeout?,
  signal?,
  callTimeout?,
});

await chromeNexus.selectMulticast(SettingsToken, {
  where?,
  expects?: "all" | "stream",
  callTimeout?,
});
```

`create` and `createMulticast` use `timeout` as the acquisition deadline, including bootstrap, target resolution, connection, handshake, `where`, and provider availability. `select` may use `wait: { timeout?, signal? }` to wait for a provider; `selectMulticast` does not wait. `callTimeout` starts only after a proxy is returned and bounds later RPC calls. Timeouts and abort signals are caller-local and do not cancel shared connection work.

Common structured failures are `E_TARGET_REQUIRED` for missing create targets, `E_TARGET_CONSTRAINT_FAILED` for a reached target rejected by `where`, `E_SERVICE_UNAVAILABLE` for a reached target without an available provider, `E_SERVICE_ACQUISITION_TIMEOUT` for create acquisition expiry, `E_SERVICE_NO_MATCH` for non-waiting select with no provider, `E_SERVICE_AMBIGUOUS` for multiple select providers, `E_SERVICE_WAIT_TIMEOUT` for select wait expiry, `E_ABORTED` for cancellation, and `E_PROTOCOL_INCOMPATIBLE` when the required provider-catalog capability is absent. Invalid options, including non-finite or negative deadlines, return `E_USAGE_INVALID` at safe API boundaries.

Multicast calls settle each recipient as `{ status: "fulfilled", value }` or `{ status: "rejected", reason }` (in an array for `"all"`, or an async iterable for `"stream"`). Public results do not expose connection IDs or a `from` field; recipient identity and ordering records remain internal.

## Session-Bound Handles

Raw core handles are lifecycle-scoped.

- `nexus.create(...)` returns a proxy bound to the resolved remote session.
- `nexus.ref(...)` creates capabilities that remain tied to the original connection scope after crossing the transport boundary.
- Existing raw proxies do not silently retarget after reconnect, daemon restart, iframe reload, or identity handoff.
- Recreate proxies and pass fresh refs after session replacement.

For an existing exact root unicast proxy, static Core status observation is
separate from targeting. `Nexus.getProxyStatus(proxy)` reads the current local
status as a synchronous immutable snapshot, and
`Nexus.subscribeProxyStatus(proxy, listener)` synchronously delivers that
current snapshot after registration, then reports future distinct transitions.
Neither recovers a session, discovers a provider, nor reconnects; acquire a
fresh proxy with the application's chosen target when replacement is wanted.

Nexus Relay does not change these service proxy and remote resource rules. Downstream callers still target the adjacent relay provider with ordinary `nexus.create(...)`; the relay provider separately uses `forwardThrough` and `forwardTarget` for its upstream call.
