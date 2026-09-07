---
"@nexus-js/core": patch
---

Simplify the session-bound RPC runtime and pending-call bookkeeping while
preserving protocol conversion tables and public acquisition semantics.

Fix remote/local resource ID attribution collisions, release undelivered stream
and failed-dispatch results, and clean up capabilities when reply delivery fails.
Preserve authorization snapshots and the synchronous invocation scope used by
State and Relay.
