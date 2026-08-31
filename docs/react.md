# React Integration

`@nexus-js/react` lets React components access a Nexus instance, observe a
service proxy, and use Nexus State.

```ts
import {
  createNexusScope,
  NexusProvider,
  useNexus,
  useProxyStatus,
} from "@nexus-js/react";
```

For synchronized remote state, continue to the
[Nexus State React guide](state/react.md).

## `NexusProvider`

Provide a Nexus instance to the React tree:

```tsx
<NexusProvider nexus={nexus}>
  <App />
</NexusProvider>
```

## `useNexus()`

`useNexus()` returns the Nexus instance from the nearest `NexusProvider`. It
fails fast outside a provider.

## `createNexusScope()`

Use a typed React scope when one application uses more than one adapter. The
scope prevents a target or State definition for one adapter from being used
with another adapter's Nexus instance:

```tsx
import { createNexusScope } from "@nexus-js/react";
import {
  usingBackgroundScript,
  type ChromeAdapterModel,
} from "@nexus-js/chrome";

const ChromeNexus = createNexusScope<ChromeAdapterModel>();
const chromeNexus = usingBackgroundScript();

function ChromeApp() {
  return (
    <ChromeNexus.NexusProvider nexus={chromeNexus}>
      <App />
    </ChromeNexus.NexusProvider>
  );
}
```

Use `ChromeNexus.useNexus()` inside that tree. The scope also exposes typed
Nexus State hooks and scope factories documented in the
[Nexus State React guide](state/react.md).

## `useProxyStatus()`

Observe an existing service proxy returned by unicast `create`, `safeCreate`,
`select`, or `safeSelect`. The hook does not need `NexusProvider` and does not
create, release, reconnect, or replace the proxy.

```tsx
import { useProxyStatus } from "@nexus-js/react";

function OrderStatus({ orders }: { orders: object | null }) {
  const status = useProxyStatus(orders);
  return <span>{status?.type ?? "unavailable"}</span>;
}
```

Pass a selector to subscribe to a derived value. React compares selected
snapshots with `Object.is`:

```tsx
const connected = useProxyStatus(orders, (status) => status.type === "active");
```

Only `null` and `undefined` mean no proxy and return `null`. Other invalid
values go through Core validation and throw its original `NexusUsageError`.
The proxy remains tied to its connection session. Application code decides when
to create a replacement. See
[Service Proxy Lifecycle](proxy-lifecycle.md) for the Core status and
replacement rules.

During server rendering the hook returns `null` without reading Core. Hydration
starts from that same `null` snapshot, then reads and observes the service proxy.
Supplying a service proxy on the client requires `@nexus-js/core` >= 1.1.0; the
React package otherwise remains compatible with Core >= 1.0.0 for its existing
APIs.

## Nexus State

For `createRemoteStoreScope()`, `useRemoteStore()`, `useStoreSelector()`, and
State-specific loading, replacement, and selector semantics, use the
[Nexus State React guide](state/react.md).
