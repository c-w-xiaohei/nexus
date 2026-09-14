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

const connection = await mock.nexus.connect({
  target: { context: "host" },
});
const ping = connection.get(PingToken);
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

## Assertions

Use call records for application-level assertions:

```ts
expect(mock.calls.connect()).toHaveLength(1);
expect(mock.calls.configure()).toHaveLength(1);
expect(mock.calls.release()).toHaveLength(1);
```

## Boundaries

`createMockNexus()` does not simulate endpoints, transports, adapter auth gates, real connection sessions, connection collections, identity subscriptions, iframe reloads, daemon restarts, or Chrome runtime ports. Its connection seam is for application-level tests, not proof of real acquisition behavior.

Use core, adapter, browser, or socket integration tests for real restart, transport, and session behavior.
