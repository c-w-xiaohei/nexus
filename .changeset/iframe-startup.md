---
"@nexus-js/iframe": minor
---

Support optional exact `connectTo` startup targets. Defer outgoing connections
during document loading until load completes, and cancel the wait on shutdown.

Adapt to Core's lifecycle-owning VirtualPortRouter. Application targeting APIs
are unchanged; this adapter requires Core ~1.2.0 rather than the previous runtime.
