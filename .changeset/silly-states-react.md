---
"@nexus-js/core": minor
"@nexus-js/react": minor
---

Add `getInitialState()` to local and remote Core Store handles. Remove
`useStoreSelector` in favor of Zustand-shaped `useStore(store, selector?)`.
Scoped `useSelector` now returns its explicit fallback whenever no current
`RemoteStore` handle exists, without retaining values from a previous handle.
