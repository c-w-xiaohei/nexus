# Testing Nexus Applications

`@nexus-js/testing` provides user-level unit test utilities for application code that consumes Nexus through a `NexusInstance`.

Use `createMockNexus()` when a component, hook, service-consuming module, or cleanup path needs an injectable Nexus instance without starting real runtime contexts, endpoints, transports, or adapters.

## Install

```bash
pnpm add -D @nexus-js/testing
```

## Main Path

```ts
import { createMockNexus } from "@nexus-js/testing";
import { UserToken, type UserService } from "../shared/user";

const mock = createMockNexus();

const userService: UserService = {
  async getUser(id) {
    return { id, name: "Ada" };
  },
};

mock.service(UserToken, userService);

const user = await mock.nexus.create(UserToken, {
  target: { descriptor: { context: "background" } },
});

await expect(user.getUser("u1")).resolves.toEqual({ id: "u1", name: "Ada" });
```

## React Components

```tsx
import { NexusProvider } from "@nexus-js/react";
import { createMockNexus } from "@nexus-js/testing";

const mock = createMockNexus();
mock.service(UserToken, userService);

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NexusProvider nexus={mock.nexus}>{children}</NexusProvider>
);
```

## What This Covers

- application code that calls `nexus.create(...)` or `nexus.safeCreate(...)`
- React components and hooks that receive Nexus through `NexusProvider`
- setup code that calls `configure(...)`
- cleanup code that calls `release(...)`
- error paths for missing services or injected create failures
- assertions against recorded calls

## What This Does Not Cover

- endpoint or transport behavior
- connection handshakes
- adapter auth, origin, socket, tab, frame, or runtime-port behavior
- real disconnect, reconnect, reload, or daemon restart timing
- multicast connection semantics

Use adapter or integration tests for those behaviors.

## Related Guides

- Unit testing guide: `docs/testing/unit.md`
- Package map: `docs/packages.md`
- Platform testing boundaries: `docs/platforms.md`
- Nexus State testing: `docs/state/testing.md`
- Iframe adapter: `docs/iframe/README.md`
- Node IPC testing: `docs/node-ipc/testing.md`
