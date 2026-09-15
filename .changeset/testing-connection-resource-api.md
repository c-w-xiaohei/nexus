---
"@nexus-js/testing": minor
---

Reuse Core call dispatch and request/reply processing in memory, including path
validation, business-error trust and orphan-resource cleanup. Preserve direct
callbacks and shared-memory ref arguments through the mock's argument codec.

Update `createMockNexus` for the Core 2.0 alpha connection-resource API,
including connection acquisition, connection observation, and per-connection
multicast resources.
Remove standalone `MockNexus*Call` record types; call history retains its existing
object shape, with types available directly from `MockNexus["calls"]`.

Mock lazy calls now retain consumed values after disconnect, reject new
consumption with the Core disconnected error, and normalize service throws to
`E_REMOTE_EXCEPTION`. Mock service facades reuse Core proxy and payload conversion,
including refs returned by asynchronous methods and explicit resource release.
Payload conversion failures remain protocol errors, distinct from business throws.
Arguments use direct in-memory invocation rather than a transport session.
Keep Core subpaths external in the Testing build so published mock calls share
Core's private consumption registry and work with `Nexus.safeCall`.

Reuse Core pending-call handling for mocks, honor configured and per-resource
call timeouts, and allocate a fresh session after disconnect. Keep missing
services visible as per-connection errors in collection `get`.
Reuse Core's shared acquisition rules so mock targeting, cardinality, timeout,
and request-local abort behavior match Core sessions.
