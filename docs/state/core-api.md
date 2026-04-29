# Nexus State Core API

This Nexus State guide covers the public `@nexus-js/core/state` surface.

## Exports

Current public entrypoint:

```ts
import {
  defineNexusStore,
  provideNexusStore,
  connectNexusStore,
  safeConnectNexusStore,
  safeInvokeStoreAction,
} from "@nexus-js/core/state";
```

Types and errors are also exported from the same subpath.

## `defineNexusStore()`

Use `defineNexusStore()` to declare a Nexus State store contract.

```ts
const store = defineNexusStore({
  token,
  state: () => ({ count: 0 }),
  actions: ({ getState, setState }) => ({
    async increment(by = 1) {
      setState({ count: getState().count + by });
      return getState().count;
    },
  }),
});
```

### Responsibilities

It defines:

- the store identity via `token`
- the initial state factory
- host-side actions
- optional convenience config like `defaultTarget`

### Notes

- `token` remains the real identity source
- store actions must use serializable arguments/results
- Nexus State v1 only supports snapshot-mode sync publicly

## `provideNexusStore()`

`provideNexusStore()` adapts a Nexus State store definition into an ordinary Nexus service registration.

```ts
nexus.configure({
  services: [provideNexusStore(counterStore)],
});
```

You do not create a second registration system for Nexus State.

## `connectNexusStore()`

Connects to a remote Nexus State store and returns a `RemoteStore`.

```ts
const remote = await connectNexusStore(nexus, counterStore, {
  target: { descriptor: { context: "background" } },
});
```

### Key behavior

- resolves the target through normal Nexus rules
- creates a proxy through ordinary service paths
- performs one setup step that establishes the initial snapshot and subscription together
- initializes the local mirror from the baseline

Lifecycle boundary:

- the returned `RemoteStore` is a session-bound handle
- if the underlying session is replaced, create a new handle with `connectNexusStore(...)`
- terminal handles are not revived in place

## `safeConnectNexusStore()`

Safe variant of `connectNexusStore()`.

```ts
const result = await safeConnectNexusStore(nexus, counterStore, options);

if (result.isErr()) {
  console.error(result.error);
}
```

Use this when you want safe-first composition instead of throw-style flow.

## Choosing Throw vs Safe

Use throw-style APIs when:

- you want the most direct call sites
- you already handle errors with `try/catch`
- you are writing app code and want to optimize for readability first

Use safe-style APIs when:

- your codebase already composes `Result` / `ResultAsync`
- you want explicit error branching without exceptions
- you are writing orchestration or infrastructure code where failure handling is part of the flow

## `RemoteStore`

Nexus State `RemoteStore` is the client-side handle.

Primary capabilities:

- `getState()`
- `subscribe(listener)`
- `getStatus()`
- `destroy()`
- `actions.*`

`RemoteStore` is connection/session-scoped by design. Treat `disconnected`, `stale`, and `destroyed` as explicit lifecycle boundaries that require replacement, not in-place healing.

### Example

```ts
const remote = await connectNexusStore(nexus, counterStore, options);

const stop = remote.subscribe((state) => {
  console.log(state.count);
});

await remote.actions.increment(1);

console.log(remote.getStatus());

stop();
remote.destroy();
```

## `safeInvokeStoreAction()`

Single safe helper for Nexus State action invocation.

```ts
const result = await safeInvokeStoreAction(remote, "increment", [1]);
```

This exists to avoid generating a second mirrored `safeActions.*` tree for every store.

## Errors

Important Nexus State public errors include:

- `NexusStoreConnectError`
- `NexusStoreDisconnectedError`
- `NexusStoreActionError`
- `NexusStoreProtocolError`

Use these when you want to distinguish connection failure, disconnect, remote action failure, and protocol corruption.
