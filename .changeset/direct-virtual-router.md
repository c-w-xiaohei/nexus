---
"@nexus-js/core": major
"@nexus-js/iframe": major
---

Replace the VirtualPortRouter context-and-functions API with a lifecycle-owning
class. Construct routers with `new VirtualPortRouter(options)` and call
`router.safeListen(handler)`, `router.safeConnect()` and `router.safeClose()`.
Use `VirtualPortRouter` instead of `VirtualPortRouter.Context` for instance types.
The `listening` and `closed` observations are read-only; internal configuration,
callbacks, subscriptions and channel collections are private. No static
compatibility wrappers remain. The wire protocol is unchanged.

Update the iframe adapter to the class API and require core 2.x. Iframe
application APIs are unchanged, but the previous core 1.x runtime is no longer
compatible with this adapter release.
