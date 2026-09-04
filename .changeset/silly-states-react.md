---
"@nexus-js/core": minor
"@nexus-js/react": minor
---

Add `getInitialState()` and JavaScript `using` support to concrete local and
remote Core Store handles without widening the existing compatibility-facing
Store interfaces. Remove
`useStoreSelector` in favor of Zustand-shaped `useStore(store, selector?)`.
Scoped `useSelector` now returns its explicit fallback whenever no current
`RemoteStore` handle exists, without retaining values from a previous handle.
