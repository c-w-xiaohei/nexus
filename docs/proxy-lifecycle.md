# Service Proxy Lifecycle

Ordinary unicast service proxies are session-bound. This page describes how to
observe one already-acquired proxy; it does not add discovery, recovery, or
ownership controls.

## Status

`Nexus.getProxyStatus(proxy)` and `Nexus.subscribeProxyStatus(proxy, listener)`
apply only to the exact root proxy returned by a successful same-copy Core
unicast `create`, `safeCreate`, `select`, or `safeSelect`. They do not accept a
descendant proxy, a resource or multicast proxy, a plain object, or a proxy from
another copy of `@nexus-js/core`. Invalid inputs synchronously throw
`NexusUsageError` with code `E_USAGE_INVALID`.

```ts
import { Nexus, type ProxyStatus } from "@nexus-js/core";

const status: ProxyStatus = Nexus.getProxyStatus(orders);
// { type: "active", selection: "current" | "stale" }
// { type: "disconnected", error: NexusDisconnectedError }
```

`active` means this local session has not disconnected. `selection: "stale"`
means the selection predicate captured during acquisition no longer matches;
the proxy remains callable. `disconnected` is terminal for that exact local
session. None of these states identifies a replacement target or provider.

The getter returns an immutable cached snapshot. Subscription registers first,
then synchronously sends the current snapshot and each future transition:

```ts
const stop = Nexus.subscribeProxyStatus(orders, (status) => {
  if (status.type === "disconnected") cancelLocalWork(status.error);
});

// `stop()` removes only this observer. It does not release or reconnect.
```

After disconnection, the terminal snapshot remains readable. A later
subscription synchronously receives it and returns an inert cleanup.

## Replacement Is Application Policy

Nexus never reconnects, retargets, retries, or replays calls for a raw proxy.
Keep a stale proxy if your UI can tolerate it, or explicitly acquire a fresh
proxy when the application chooses a replacement target and time:

```ts
// Structural pseudocode. Application code owns discovery and target selection;
// see docs/concepts.md#connectiontarget-and-where for concrete targets.
async function replaceOrders() {
  const next = await nexus.create(OrdersToken, { target: ordersTarget });
  // Publish `next` through the application's own state or context.
  return next;
}
```

An acquisition failure happens before a proxy exists and is distinct from a
later `disconnected` status on an existing proxy. A listener cleanup only ends
observation; it never owns acquisition cancellation or replacement.

## Diagnostics

`Nexus.inspectProxy(proxy)` returns an immutable diagnostic snapshot with the
token ID, an opaque runtime-local `connectionId`, and the same `ProxyStatus`
shape returned by `getProxyStatus`. Use it for logs and debugging only. It is a
failure artifact, not a behavior oracle: connection IDs cannot target a
connection, and the snapshot intentionally exposes no target, provider
identity, predicate, URL, pending calls, live controls, or registry access.
