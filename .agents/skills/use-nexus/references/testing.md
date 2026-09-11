# Testing Nexus Application Code

Use `createMockNexus()` from `@nexus-js/testing` for user-level unit tests where code consumes a `NexusInstance`.

## Main Pattern

```ts
import { createMockNexus } from "@nexus-js/testing";
import { PingToken, type PingService } from "./shared";

const mock = createMockNexus();

const pingService: PingService = {
  async ping(input) {
    return `pong:${input}`;
  },
};

mock.service(PingToken, pingService);

const ping = await mock.nexus.create(PingToken, {
  target: { context: "host" },
});
```

## React

Inject the mock through `NexusProvider`. Do not add a separate testing provider abstraction unless the app already has one.

```tsx
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NexusProvider nexus={mock.nexus}>{children}</NexusProvider>
);
```

When React components share one remote Nexus State store across a subtree, prefer testing that component tree with `createRemoteStoreScope(...)`: keep `NexusProvider` at the top, mount the scope provider inside it, and let leaf components call `useSelector` and `useActions`. For direct ownership, render a child only after `remote.store` exists and select with `useStore(remote.store, selector)` from `zustand`. Use real Zustand stores or faithful stable-snapshot test doubles, not getters that clone state on every read.

For React remote-store replacement, test `reconnectKey` changes, the stable `reconnect()` function reference, disposal of an older pending acquisition after a newer request, and scope sharing of both the store and reconnect command. A failed replacement exposes selector fallback with an acquisition error and null status, not a synthetic `disconnected` status. A cross-target handoff exposes fallback immediately and destroys the previous handle before the replacement resolves.

Use `useStoreStatus(store, selector?)` or `Scope.useStatus(selector?)` for lifecycle UI; select `status.type` if versions are irrelevant. Verify with separate publications that unchanged selectors and actions/error-only consumers do not rerender. An acquired handle disconnecting should update status observers, not the acquisition result or its `error`.

For passed-proxy status UI, a unit test may mock the static
`Nexus.getProxyStatus` / `Nexus.subscribeProxyStatus` pair. This can prove UI
subscription and selector behavior, not a real proxy lifecycle. Use a Core and
adapter integration test for actual stale/disconnect ordering and terminal
status; `createMockNexus()` cannot prove real lifecycle behavior.

## Assertions

Use call records for application-level assertions:

```ts
expect(mock.calls.create(PingToken)).toHaveLength(1);
expect(mock.calls.configure()).toHaveLength(1);
expect(mock.calls.release()).toHaveLength(1);
```

## Boundaries

`createMockNexus()` supports API-level `createMulticast` and `selectMulticast` behavior for `"all"` and `"stream"` results, including selection snapshots. It does not simulate endpoints, transports, adapter auth gates, real connection sessions, iframe reloads, daemon restarts, Chrome runtime ports, or transport-level multicast behavior.

Use core, adapter, browser, or socket integration tests for real restart, transport, and session behavior.
