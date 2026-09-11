---
"@nexus-js/react": minor
---

Separate remote-store acquisition from observation. `useRemoteStore` returns
`{ store, pending, error, reconnect }`; observe lifecycle explicitly through
`useStoreStatus(store, selector?)` or `Scope.useStatus(selector?)`. Status hooks
return null without a handle and during SSR. Snapshot versions no longer cause
the owner or unrelated Scope consumers to rerender.

Breaking changes: import `useStore` from Zustand, remove
`RemoteStoreWithInitialState` usage, and replace `remote.status` reads with status
selectors. Replacement destroys the old handle without retaining a stale session.
Requires Core ~1.2.0. See the
[migration guide](https://github.com/c-w-xiaohei/nexus/blob/main/docs/migrations/1.2.md).
