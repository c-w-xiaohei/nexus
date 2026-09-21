---
"@nexus-js/core": minor
---

Accept Standard Schema validators for State snapshots and action results,
including Valibot, Zod, and Zod Mini. Validation remains synchronous and preserves
the original wire state and action result; transformed outputs are not installed.
Remove the production Zod dependency and keep validator-library details outside
the public State contract.
