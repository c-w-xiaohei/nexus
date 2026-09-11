---
"@nexus-js/core": major
"@nexus-js/react": major
---

Rebuild Nexus State around native Zustand stores bound through Nexus callbacks.
Create a new host with `createNexusStore(definition, nativeCreator, options)` or
bind an existing store with `bindNexusStore(definition, store, options)`. The
required options are a pure `snapshot` projection and explicit `expose` action
allowlist; `publishWindowMs` defaults to 200 and `maxPendingSnapshots` to 32.
The returned `store` is the original Zustand API. Shared
`{ token, validation? }` definitions no longer execute business
factories in clients or carry separate `sync.mode` or `defaultTarget` options.
Put targeting defaults on the Token.

Remove `defineNexusStore()`: pass the shared definition object directly to State
and React APIs. The helper's eager `instanceof Token` check is removed along with
it; use typed Tokens and, when needed, `satisfies NexusStoreDefinition<...>`.
Organize internal State modules around contracts, protocol, binding, acquisition,
and mirrors, with explicit public exports and no new subpath entrypoints.
Use relative type imports in State declarations so plain typed-Token definitions
retain inference when consumed from another package.

The State service now has one `subscribe(callback)` method. Its initial callback
delivers the snapshot, action callbacks, and unsubscribe callback. Updates and
termination use the same callback channel. Remove string-based dispatch,
subscription IDs, and custom proxy routing. Upgrade all State endpoints and
State relays together; the previous wire contract is not supported.

Remote actions are ordinary Core function references and wait only for the
caller's fixed-window snapshot acknowledgement. State does not serialize
actions, add drafts, rollback, queues, receipts, or waiter protocols; failures
may follow an already executed mutation and are not automatically retried.
Initial callback acknowledgement and explicit unsubscribe handle failed or late
subscriptions without changing the core resource lifecycle. State requires
native `structuredClone` and uses es-toolkit for handshake timeouts.

Update React bindings to the unified Store handle types and remove the redundant
`RemoteStoreWithInitialState` export and Core 1.0 runtime compatibility check.
React bindings now require Core >=2.0.0 and use the required status subscription
instead of polling older handles. Upgrade both packages together.

Remove `useStore` from `@nexus-js/react`; import Zustand's `useStore` directly for
local stores and acquired RemoteStore handles. Remove Nexus's revision and
selector caches. Scope selection handles missing stores and fallback inline and
follows Zustand 5 snapshot stability rules, including `useShallow` for selectors
that construct shallow-equal objects or arrays. Stores that clone on each read
are no longer supported by an extra Nexus cache.
Align RemoteStore subscriptions with Zustand's `(state, previousState)` callback;
observers registered before init receive the baseline as both values on init.

Make `useRemoteStore` acquisition-only: `{ store, pending, error, reconnect }`
replaces the result's `status` field. Add `useStoreStatus(store, selector?)` and
selector support to `RemoteStoreScope.useStatus(selector?)`; both return null
without a handle and during SSR. Full status observation includes versions;
phase selectors avoid version-only renders. The Scope Provider no longer
subscribes to snapshots or lifecycle changes, so they do not rerender unrelated
context consumers. Acquisition errors remain distinct from later disconnects.

On React replacement, hide the old handle immediately and destroy it in effect
cleanup rather than retaining it as stale until the next attempt settles. Remove
the private React-to-Core stale marker; Core-originated stale signals remain.
