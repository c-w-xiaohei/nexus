# Testing Nexus State

Nexus State has three useful testing layers.

## 1. Store Runtime Tests

Use focused Nexus State runtime tests when you want to verify:

- host runtime behavior
- version ordering
- handshake semantics
- disconnect classification
- action acknowledgement behavior

Current examples live in:

- `packages/core/src/state/state-host-runtime.test.ts`
- `packages/core/src/state/state-provide-store.test.ts`
- `packages/core/src/state/state-client-runtime.test.ts`
- `packages/core/src/state/state-errors.test.ts`
- `packages/core/src/state/state.test.ts`

## 2. React Adapter Tests

Use React tests when you want to verify:

- provider wiring
- `useNexus()` fail-fast behavior
- `useRemoteStore()` lifecycle semantics
- selector fallback behavior
- target handoff behavior

Current examples live in:

- `packages/react/src/react.test.tsx`

## 3. Multi-Context Integration Tests

This is the most important level for Nexus State cross-context correctness.

Use integration tests when you need to prove:

- one context hosts the store
- multiple isolated contexts connect to it
- updates fan out correctly
- a disconnected context stops receiving updates
- host-side cleanup removes orphaned remote resources/subscriptions

Current examples live in:

- `packages/core/integration/state/lifecycle-and-cleanup.integration.test.ts`
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

1. add a focused state/runtime test first
2. add a React test if the behavior affects hooks
3. add or extend multi-context integration tests only for user-visible cross-context semantics

## Good Integration Questions

Ask questions like:

- Does every connected client converge to the same state?
- Does a disconnected client stop receiving snapshots?
- Do surviving clients continue to progress after one context is torn down?
- Does the disconnected handle reject actions explicitly?

Those questions are more valuable than testing internal bookkeeping alone.
