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
  target: { descriptor: { context: "host" } },
});
```

## React

Inject the mock through `NexusProvider`. Do not add a separate testing provider abstraction unless the app already has one.

```tsx
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NexusProvider nexus={mock.nexus}>{children}</NexusProvider>
);
```

## Assertions

Use call records for application-level assertions:

```ts
expect(mock.calls.create(PingToken)).toHaveLength(1);
expect(mock.calls.configure()).toHaveLength(1);
expect(mock.calls.release()).toHaveLength(1);
```

## Boundaries

`createMockNexus()` does not simulate endpoints, transports, adapter auth gates, real connection sessions, reconnects, iframe reloads, daemon restarts, Chrome runtime ports, or multicast semantics.

Use core, adapter, browser, or socket integration tests for those behaviors.
