---
"@nexus-js/node-ipc": minor
---

Support optional exact `connectTo` startup targets in the client helper with
Core 1.2. Startup dialing does not block local readiness or automatically retry.

Breaking change: remove the helpers' `groups` option and built-in group metadata.
Applications define labels in their own context metadata, configure them through
`endpoint.meta`, and select providers with `where`. The existing declared Core
range is unchanged; this release was verified with the matching Core source.
