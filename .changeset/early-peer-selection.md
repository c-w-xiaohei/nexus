---
"@nexus-js/core": minor
"@nexus-js/chrome": minor
"@nexus-js/iframe": minor
"@nexus-js/node-ipc": minor
---

Restore optional exact `endpoint.connectTo` startup targets, also available on
Chrome/iframe helpers and the Node IPC client helper. Startup dials begin once
after listening, reuse in-flight target acquisition, do not require a remote
Token, and do not block `ready()`. Failures are logged without failing local
readiness; there is no automatic retry, reconnect, or inferred `defaultTarget`.
Use the matching core release with adapter helpers to enable startup dialing.

Chrome custom page helpers accept startup configuration in a separate optional
argument: `usingExtensionPage(meta, { connectTo })` or
`createExtensionPageConfig(meta, { connectTo })`. Existing metadata-only calls
are unchanged. Share the `ChromeAppMeta` type between identity and helper inputs
and derive context-specific option fields from their metadata types.

An owner can create a child context and select its service with `where` and
`wait` before the child connects back. Selection completes after authorized
session and provider publication. Remove unused internal group routing/indexes;
`groups` remains ordinary context metadata selected through `where`, with no
change to snapshot multicast or the wire protocol.

Remove the Node IPC helpers' `groups` option and the built-in `groups` metadata
fields. Applications that need labels must define them in their own context
metadata model and supply `endpoint.meta` through `nexus.configure(...)`, then
select with `where`; group membership is not an adapter-owned concept.

Defer outgoing iframe connections started during document loading until after
load, so parent navigation cleanup does not close a fresh startup session. Close
or unload cancels pending load waits; no extra application handshake is needed.
