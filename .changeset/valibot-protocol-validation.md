---
"@nexus-js/core": patch
"@nexus-js/iframe": patch
"@nexus-js/node-ipc": patch
---

Validate Core message and known payload-placeholder structures with Valibot before
dispatch or revival. Preserve the existing wire format, legacy invocation
packets, opaque payloads, and session-owned resource cleanup. Migrate internal
VirtualPort, State, and decorator schemas from Zod to Valibot.

Validate iframe envelope payload presence and nonce types. Share Node IPC auth
request and response schemas while preserving authentication error codes and
socket framing.
