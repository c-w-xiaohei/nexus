---
"@nexus-js/core": minor
"@nexus-js/testing": minor
---

Preserve Token endpoint metadata across core and testing public APIs so runtime-specific tokens can be provided, exposed, registered as store providers, and created safely without local casting shims.

Tighten runtime create-token metadata acceptance for `create`, `safeCreate`, `createMulticast`, `safeCreateMulticast`, and mock `create`/`safeCreate`: tokens with unrelated metadata or metadata narrower than the runtime are rejected, while plain/default metadata and metadata that can safely accept runtime identities remain accepted.
