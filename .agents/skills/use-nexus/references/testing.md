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

When React components share one remote Nexus State store across a subtree, prefer testing that component tree with `createRemoteStoreScope(...)` in the same way the app uses it: keep `NexusProvider` at the top, mount the scope provider inside it, and let leaf components call scope hooks such as `useSelector` and `useActions`.

For React remote-store replacement, test `reconnectKey` changes, the stable `reconnect()` function reference, disposal of an older pending acquisition after a newer request, and scope sharing of both the store and reconnect command. Cover same-target continuity after a failed replacement with `disconnected` status/error separately from cross-target handoff, where selectors immediately use fallback until the new target is ready.

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
