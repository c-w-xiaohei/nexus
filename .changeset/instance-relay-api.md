---
"@nexus-js/core": minor
"@nexus-js/testing": minor
---

Move Relay registration to `nexus.relay()` and `nexus.safeRelay()`. The receiver
owns the registration, and omitted `to.nexus` uses that same runtime. Explicit
upstream runtimes retain their own target and metadata types.

Breaking change: replace `Nexus.relay({ from, to, services })` with
`from.relay({ to, services })`, and likewise for `safeRelay`. Remove `to.nexus`
when it is the same instance as `from`.

Testing mocks explicitly reject Relay registration with `E_USAGE_INVALID`;
forwarding integration tests must use real Nexus runtimes.
