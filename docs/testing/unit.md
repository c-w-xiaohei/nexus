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
    target: { context: "background" },
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
    target: { context: "background" },
  }),
).rejects.toBe(error);

const result = await mock.nexus.safeCreate(UserToken, {
  target: { context: "background" },
});

expect(result.isErr()).toBe(true);
```

An unregistered service rejects with `NexusMockError`:

```ts
await expect(
  mock.nexus.create(UserToken, {
    target: { context: "background" },
  }),
).rejects.toMatchObject({
  name: "NexusMockError",
  code: "E_MOCK_SERVICE_NOT_FOUND",
});
```

## Configuring Services In Tests

`mock.nexus.configure({ providers })` records the config and registers providers:

```ts
mock.nexus.configure({
  providers: [{ token: UserToken, service: users }],
});

expect(mock.calls.configure()).toHaveLength(1);
```

`mock.service(Token, implementation)` is an unscoped registration. Pass provider metadata as the optional third argument when a test needs `select` or `selectMulticast` to filter it.

The mock stores `config.policy` for assertions but does not execute `canConnect` or `canCall`.

## Release And Cleanup Assertions

```ts
const users = await mock.nexus.create(UserToken, {
  target: { context: "background" },
});

mock.nexus.release(users);

expect(mock.calls.release()).toEqual([{ proxy: users }]);
```

## Selection And Multicast

`select(...)` chooses a metadata-backed provider immediately, or waits for `mock.service(...)` registration when `wait: { timeout?, signal? }` is provided. It records `select` calls separately.

`createMulticast(...)` accepts non-empty exact targets and returns a bound mock fanout. `selectMulticast(...)` binds one metadata-filtered provider snapshot; zero providers is valid. Both `all` and `stream` use deterministic registration order, and later registrations do not alter an existing fanout.

Use core or adapter integration tests for real acquisition, provider-catalog protocol behavior, `where(contextMeta, connectionMeta)`, and adapter topology.

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
- transport graphs, dynamic discovery, or adapter connection-metadata evaluation
