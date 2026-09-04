# Nexus State Core API

This Nexus State guide covers the public `@nexus-js/core/state` surface.

## Exports

Current public entrypoint:

```ts
import {
  defineNexusStore,
  createNexusStore,
  connectNexusStore,
  safeConnectNexusStore,
  safeInvokeStoreAction,
} from "@nexus-js/core/state";
```

Types and errors are also exported from the same subpath.

`relayNexusStore` is available from `@nexus-js/core/relay` and re-exported from `@nexus-js/core/state` for store-focused code. Use it only when a bridge context needs to project an upstream authoritative store into a downstream Nexus graph. See `docs/relay.md` for relay semantics.

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
- optional convenience config through the store token's `defaultTarget`

### Notes

- `token` remains the real identity source
- store default targeting comes from the token's `defaultTarget`; Nexus State does not define a second store-level default target source
- store actions must use serializable arguments/results
- Nexus State v1 only supports snapshot-mode sync publicly

## `createNexusStore()`

`createNexusStore()` creates one authoritative store host and returns both the Nexus service registration and a same-context store handle.

```ts
const { provider, store } = createNexusStore(counterStore);

nexus.configure({
  providers: [provider],
});

console.log(store.getState());
console.log(store.getInitialState());
```

Use `provider` with `nexus.configure({ providers: [provider] })`. Use `store` only in the hosting context for local authoritative reads, subscriptions, and actions.

`store` is a local `NexusStoreHandleWithInitialState`, which extends the
Core 1.0-compatible `NexusStoreHandle` with `getInitialState()` and JavaScript
`using` support:

```ts
using store = createNexusStore(counterStore).store;
```

On scope exit, `using` delegates to the same synchronous, idempotent
`destroy()` transition.

`getInitialState()` returns a defensive clone of the state captured when the
authoritative host was created. Later actions do not change it; every returned
snapshot has a new identity.

## `connectNexusStore()`

Connects to a remote Nexus State store and returns a
`RemoteStoreWithInitialState`.

```ts
const remote = await connectNexusStore(nexus, counterStore, {
  target: { context: "background" },
});
```

### Key behavior

- resolves the target through normal Nexus rules
- creates a proxy through ordinary service paths
- performs one setup step that establishes the initial snapshot and subscription together
- initializes the local mirror from the baseline
- returns no Store handle when the handshake fails

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
} else {
  const remote = result.value;
}
```

Use this when you want safe-first composition instead of throw-style flow.

## Choosing Throw vs Safe

Use throw-style APIs when:

- you want the most direct call sites
- you already handle errors with `try/catch`
- you are writing app code and want to optimize for readability first

Use safe-style APIs when:

- your codebase already composes better-result `Result` / `Promise<Result>`
- you want explicit error branching without exceptions
- you are writing orchestration or infrastructure code where failure handling is part of the flow

## Store Handle Types

`RemoteStore` is the Core 1.0-compatible client-side Store interface.
`RemoteStoreWithInitialState` is the concrete Core 1.1 handle returned by
`connectNexusStore()` and `safeConnectNexusStore()`; it adds
`getInitialState()` and `[Symbol.dispose]()`.

`RemoteStore` capabilities:

- `getState()`
- `subscribe(listener)`
- `getStatus()`
- `destroy()`
- `actions.*`

`RemoteStoreWithInitialState` also supports `getInitialState()` and JavaScript
`using` through `[Symbol.dispose]()`. The local
`NexusStoreHandleWithInitialState` returned by `createNexusStore()` provides
the same two capabilities.

A remote Store handle is tied to one connection session. After it becomes
`disconnected`, `stale`, or `destroyed`, create a replacement instead of
reusing it.

On `RemoteStoreWithInitialState`, `getInitialState()` returns a defensive clone of the successful handshake
baseline. Later synchronized snapshots do not change that baseline, and every
returned snapshot has a new identity.

### Example

```ts
using remote = await connectNexusStore(nexus, counterStore, options);

const stop = remote.subscribe((state) => {
  console.log(state.count);
});

await remote.actions.increment(1);

console.log(remote.getStatus());

stop();
```

`using` delegates to the same synchronous, idempotent terminal transition as
`destroy()`. It starts the existing best-effort remote unsubscribe but does not
add an acknowledgement or asynchronous cleanup guarantee.

## `safeInvokeStoreAction()`

Single safe helper for Nexus State action invocation.

```ts
const result = await safeInvokeStoreAction(remote, "increment", [1]);

if (result.isErr()) {
  console.error(result.error.code, result.error.message);
} else {
  console.log(result.value);
}
```

This exists to avoid generating a second mirrored `safeActions.*` tree for every store.

## Errors

Important Nexus State public errors include:

- `NexusStoreConnectError`
- `NexusStoreDisconnectedError`
- `NexusStoreActionError`
- `NexusStoreProtocolError`

Use these when you want to distinguish connection failure, disconnect, remote action failure, and protocol corruption.
