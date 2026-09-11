# Nexus State Core API

This Nexus State guide covers the public `@nexus-js/core/state` surface.

## Exports

Current public entrypoint:

```ts
import {
  createStoreToken,
  createNexusStore,
  bindNexusStore,
  connectNexusStore,
  safeConnectNexusStore,
  safeInvokeStoreAction,
} from "@nexus-js/core/state";
```

Types and errors are also exported from the same subpath.

`relayNexusStore` is available from `@nexus-js/core/relay` and re-exported from `@nexus-js/core/state` for store-focused code. Use it only when a bridge context needs to project an upstream authoritative store into a downstream Nexus graph. See `docs/relay.md` for relay semantics.

## Shared Store Token

Declare one shared store type containing data and methods. The token derives
snapshot and remote-action types internally; callers do not describe the wire service.

```ts
interface CounterStore {
  count: number;
  increment(by?: number): number;
}

const counterStore = createStoreToken<CounterStore>("app:counter");
```

### Responsibilities

The StoreToken carries:

- the store identity
- optional state and action validation through `validation`
- optional convenience targeting through the store token's `defaultTarget`

### Notes

- pass the StoreToken directly to State APIs, without a `{ token }` wrapper
- store default targeting comes from the token's `defaultTarget`; Nexus State does not define a second store-level default target source
- host-side state and actions are supplied separately to `createNexusStore()` as a native Zustand `StateCreator`
- store actions must use serializable arguments/results
- synchronization publishes full snapshots

`RemoteStore<CounterStore>` derives data-only reads and asynchronous methods from
the same contract. `createStoreToken<Store, Model>(id, options)` supports typed
`defaultTarget` and optional `validation: { state, actionResults }` schemas.
Use `space.storeToken<Store>(name, options?)` or `space.safeStoreToken<Store>(...)`
with TokenSpace to inherit namespaced IDs and default targets. Without a model,
the token is portable across adapters. A local store may contain additional
private fields; `snapshot` and `expose` still define the runtime sharing boundary.

## `createNexusStore()`

`createNexusStore()` creates one authoritative store host and returns the Nexus provider, the original Zustand store, and binding lifecycle methods.

```ts
const { provider, store, destroy } = createNexusStore(
  counterStore,
  (set, get) => ({
    count: 0,
    increment(by = 1) {
      const count = get().count + by;
      set({ count });
      return count;
    },
  }),
  {
    snapshot: (local) => ({ count: local.count }),
    expose: ["increment"],
  },
);

nexus.configure({
  providers: [provider],
});

console.log(store.getState());
console.log(store.getInitialState());
```

Use `provider` with `nexus.configure({ providers: [provider] })`. Use `store` only in the hosting context for local authoritative reads, subscriptions, and actions.

`store` is the original `Mutate<StoreApi<...>>` returned by Zustand. It keeps
the creator's middleware mutator types and extensions. Local actions continue
to use `store.getState().action()` and do not wait for Nexus publication.

```ts
const { store } = createNexusStore(counterStore, creator, options);
```

The binding result supports `using` through `[Symbol.dispose]()`; scope exit
delegates to the same synchronous, idempotent `destroy()` transition. Destroy
does not destroy the original Zustand store.

The binding does not replace or recreate Zustand's API. Its `snapshot` function
is the complete shared data projection, and `expose` is the runtime action
allowlist. Validation schemas validate payloads; parsed transform outputs are
not installed into the source or remote store.

### `bindNexusStore()`

Use `bindNexusStore(token, existingStore, options)` for an already-created
Zustand store, including one composed with `persist`, `immer`, `devtools`, or
`subscribeWithSelector`. The same options apply to both creation paths.

```ts
const binding = bindNexusStore(counterStore, store, {
  snapshot: (local) => ({ count: local.count }),
  expose: ["increment"],
});

binding.destroy(); // store remains usable
```

`publishWindowMs` is a fixed window beginning with the first update (default
200ms), not a debounce; action completion does not force a flush.
`maxPendingSnapshots` defaults to 32. A subscription that exceeds this budget or
fails to acknowledge a callback within five seconds is stopped, without closing
other services on the shared connection. Terminal notification is best effort;
State does not retry failed actions or replay snapshots automatically.

## `connectNexusStore()`

Connects to a remote Nexus State store and returns a `RemoteStore`.

```ts
const remote = await connectNexusStore(nexus, counterStore, {
  target: { context: "background" },
});
```

### Key behavior

- resolves the target through normal Nexus rules
- creates a proxy through ordinary service paths
- establishes the initial snapshot and live subscription through one callback-init setup
- initializes the local mirror from the baseline
- returns no Store handle when the handshake fails

The init callback supplies the initial state, the raw Core function proxies for each
action, and an idempotent unsubscribe capability. State does not add an action-name
dispatch protocol or wrap those action proxies. Consequently, direct action failures
retain Core error codes such as `E_CONN_CLOSED`, `E_CALL_TIMEOUT`, and
`E_RESOURCE_ACCESS_DENIED`; `safeInvokeStoreAction()` may normalize them only at its
public safe-result boundary.

Timeout boundaries remain separate: `connectNexusStore()` uses its State `timeout`
only for acquisition and the callback-init handshake. Action calls use Core's existing
resource-call timeout defaults; State does not translate the acquisition timeout into
Core's `callTimeout` option.

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

`RemoteStore` is the client-side Store interface returned by
`connectNexusStore()` and `safeConnectNexusStore()`.

`RemoteStore` capabilities:

- `getState()`
- `subscribe(listener)`
- `getStatus()`
- `subscribeStatus(listener)`
- `destroy()`
- `actions.*`

`RemoteStore` supports `getInitialState()` and JavaScript `using` through
`[Symbol.dispose]()`. The local `store` returned by `createNexusStore()` is the
original Zustand API; the binding result, not the store, owns `destroy()` and
`[Symbol.dispose]()`.

A remote Store handle is tied to one connection session. After it becomes
`disconnected`, `stale`, or `destroyed`, create a replacement instead of
reusing it.

On `RemoteStore`, `getInitialState()` returns the stable successful-handshake
baseline. Later snapshots do not change it. Treat both initial and current state
as immutable; repeated reads of the same snapshot preserve its identity.

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
