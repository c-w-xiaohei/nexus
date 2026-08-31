# Testing Nexus State

Nexus State has four useful testing layers.

## 1. Application Unit Tests

For general `createMockNexus()` setup and React provider examples, see the
[application testing guide](../testing/README.md). This page covers the parts
specific to Nexus State.

For Nexus State app code, prefer registering the real store service contract from `createNexusStore(...)` instead of hand-writing `NexusStoreServiceContract` objects:

```ts
const mock = createMockNexus();
const { provider, store } = createNexusStore(counterStore);

mock.nexus.configure({
  providers: [provider],
  endpoint: {
    meta: { context: "background" },
    defaultTarget: { context: "background" },
  },
});

const remote = await connectNexusStore(mock.nexus, counterStore, {
  target: { context: "background" },
});

expect(store.getState()).toEqual(remote.getState());
```

This verifies application collaboration with the store service contract. It does not verify real cross-runtime message delivery, browser extension behavior, disconnect timing, or adapter lifecycle semantics.

## 2. Store Runtime Tests

Use focused Nexus State runtime tests when you want to verify:

- host runtime behavior
- version ordering
- handshake semantics
- disconnect classification
- action acknowledgement behavior

Current examples live in:

- `packages/core/src/state/state-host-runtime.test.ts`
- `packages/core/src/state/state-create-store.test.ts`
- `packages/core/src/state/state-client-runtime.test.ts`
- `packages/core/src/state/state-errors.test.ts`
- `packages/core/src/state/state.test.ts`

## 3. React Binding Tests

Use React tests when you want to verify:

- remote store scope wiring
- `useRemoteStore()` lifecycle semantics
- `reconnectKey` changes and stable `reconnect()` commands
- disposal of a pending acquisition that resolves after a newer request
- scope sharing, including shared reconnect controls
- selector fallback behavior
- same-target continuity after a failed replacement, with `disconnected` status/error
- immediate cross-target fallback handoff, including after a same-target failure

Current examples live in:

- `packages/react/src/react.test.tsx`

## 4. Multi-Context Integration Tests

This is the most important level for Nexus State cross-context correctness.

Use integration tests when you need to prove:

- one context hosts the store
- multiple isolated contexts connect to it
- updates fan out correctly
- a disconnected context stops receiving updates
- host-side cleanup removes remote resources and subscriptions left by disconnected clients
- reconnect paths create new `RemoteStore` handles instead of reusing terminal handles
- connection session changes require a new `RemoteStore` handle

Use React binding tests for hook replacement behavior. Use real multi-context integration tests for restart, transport, and connection session behavior.

Current examples live in:

- `packages/core/integration/state/lifecycle-and-cleanup.integration.test.ts`
- `packages/core/integration/state/background-restart.integration.test.ts`
- `packages/core/integration/state/protocol-and-errors.integration.test.ts`
- `packages/core/integration/state/targeting-and-handoff.integration.test.ts`

## A Small Example Test

For app-level Nexus State testing, the most useful assertion pattern is usually:

```ts
const remote = await connectNexusStore(nexus, counterStore, options);

expect(remote.getState().count).toBe(0);

await remote.actions.increment(1);

expect(remote.getState().count).toBe(1);
expect(remote.getStatus().type).toBe("ready");
```

Then add the failure-mode assertion you care about, for example:

```ts
await expect(remote.actions.increment(1)).rejects.toMatchObject({
  name: "NexusStoreDisconnectedError",
});
```

This is one common failure assertion, not the only one. Depending on the path you are testing, you may also assert protocol-oriented or connect-oriented errors.

## Recommended Strategy

When adding new Nexus State behavior:

1. start with `createMockNexus()` when the behavior only needs a Nexus API seam
2. add a focused state/runtime test when behavior depends on state internals
3. add a React test if the behavior affects hooks
4. add or extend multi-context integration tests only for user-visible cross-context semantics

## Good Integration Questions

Ask questions like:

- Does every connected client converge to the same state?
- Does a disconnected client stop receiving snapshots?
- Do surviving clients continue to progress after one context is torn down?
- Does the disconnected handle reject actions explicitly?
- After session replacement, does the app rebuild with a new handle instead of relying on silent healing?

Those questions are more valuable than testing internal bookkeeping alone.
