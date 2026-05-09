# Unit Testing With createMockNexus

Use `createMockNexus()` when the code under test accepts or reads a `NexusInstance` and you want deterministic unit tests without a real Nexus topology.

## Install

```bash
pnpm add -D @nexus-js/testing
```

## Service-Consuming Modules

Application code can accept a `NexusInstance` directly:

```ts
import type { NexusInstance } from "@nexus-js/core";
import { UserToken } from "./shared";

export async function loadUserName(nexus: NexusInstance, id: string) {
  const users = await nexus.create(UserToken, {
    target: { descriptor: { context: "background" } },
  });

  return (await users.getUser(id)).name;
}
```

The unit test registers the service behind the same Token:

```ts
import { createMockNexus } from "@nexus-js/testing";
import { UserToken, type UserService } from "./shared";
import { loadUserName } from "./load-user-name";

const mock = createMockNexus();

const users: UserService = {
  async getUser(id) {
    return { id, name: "Ada" };
  },
};

mock.service(UserToken, users);

await expect(loadUserName(mock.nexus, "u1")).resolves.toBe("Ada");

expect(mock.calls.create(UserToken)).toHaveLength(1);
expect(mock.calls.create(UserToken)[0]?.tokenId).toBe(UserToken.id);
```

## React Component Tests

Use `NexusProvider` directly. The testing package does not add a React subpath or a separate provider abstraction.

```tsx
import { render } from "@testing-library/react";
import { NexusProvider } from "@nexus-js/react";
import { createMockNexus } from "@nexus-js/testing";

const mock = createMockNexus();
mock.service(UserToken, users);

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NexusProvider nexus={mock.nexus}>{children}</NexusProvider>
);

render(<UserPanel />, { wrapper });
```

## Simulating Create Failures

Use `failCreate(...)` when the code under test needs to handle a Nexus create failure.

```ts
const error = new Error("offline");
mock.failCreate(UserToken, error);

await expect(
  mock.nexus.create(UserToken, {
    target: { descriptor: { context: "background" } },
  }),
).rejects.toBe(error);

const result = await mock.nexus.safeCreate(UserToken, {
  target: { descriptor: { context: "background" } },
});

expect(result.isErr()).toBe(true);
```

An unregistered service rejects with `NexusMockError`:

```ts
await expect(
  mock.nexus.create(UserToken, {
    target: { descriptor: { context: "background" } },
  }),
).rejects.toMatchObject({
  name: "NexusMockError",
  code: "E_MOCK_SERVICE_NOT_FOUND",
});
```

## Configuring Services In Tests

`mock.nexus.configure({ services })` records the config and registers services:

```ts
mock.nexus.configure({
  services: [{ token: UserToken, implementation: users }],
});

expect(mock.calls.configure()).toHaveLength(1);
```

Use the value returned by `configure(...)` when a test needs TypeScript's evolved matcher or descriptor types. The `mock.nexus` property itself does not change its static type in place.

The mock stores `config.policy` for assertions but does not execute `canConnect` or `canCall`.

## Release And Cleanup Assertions

```ts
const users = await mock.nexus.create(UserToken, {
  target: { descriptor: { context: "background" } },
});

mock.nexus.release(users);

expect(mock.calls.release()).toEqual([{ proxy: users }]);
```

## Unsupported Operations

`createMockNexus()` intentionally does not simulate multicast connection semantics. `createMulticast(...)` rejects with `NexusMockError` code `E_MOCK_UNSUPPORTED_OPERATION`, and `safeCreateMulticast(...)` returns an err result with the same code.

Use core or adapter integration tests when multicast behavior matters.

## Clearing State Between Tests

```ts
afterEach(() => {
  mock.clear();
});
```

`clear(token)` removes that token's registered service, injected failure, and create call records. `clear()` removes all registered services, injected failures, create records, configure records, release records, and update-identity records.

## Boundaries

`createMockNexus()` tests application behavior at the Nexus API seam. It does not validate:

- endpoint implementation correctness
- browser `postMessage`
- Chrome runtime ports
- Node socket paths, framing, or auth
- adapter metadata collection
- real disconnect or reconnect ordering
- daemon restart or iframe reload behavior
- core authorization policy execution
