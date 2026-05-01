# Nexus External Usage Style

Use this entry point for application code that consumes Nexus from the outside. Keep examples organized around four concerns:

1. shared service contracts and Tokens
2. runtime configuration in every context
3. service exposure in host contexts
4. proxy creation in consumer contexts

Keep adapter docs focused on adapter-specific setup. Do not redefine the full service contract pattern unless the topic is shared contracts.

## Core Rules

- Put service interfaces and Tokens in shared modules imported by every host and consumer context.
- Prefer `TokenSpace` for hierarchical token IDs and repeated default targeting intent.
- Configure every runtime context before exposing services or creating proxies.
- Prefer adapter helpers for standard runtimes; use `nexus.configure(...)` for composition, custom endpoints, policy, descriptors, matchers, or explicit services.
- Use explicit service registration instead of decorators for multi-instance runtimes and isolated tests.
- Pass an options object to `nexus.create(...)`; keep explicit targets in introductory examples.
- Treat raw proxies and refs as session-bound. Recreate them after disconnect, reload, restart, or session replacement.

## Focused References

- `references/shared-contracts.md` - service interfaces, `TokenSpace`, Token defaults, and service exposure style
- `references/runtime-configuration.md` - adapter helpers, direct `nexus.configure(...)`, multi-instance runtimes, and composition rules
- `references/targeting-and-proxies.md` - `nexus.create(...)`, target resolution, descriptors, matchers, proxies, and refs
- `references/adapter-node-ipc.md` - node-ipc daemon/client setup, `configure: false`, auth gates, and default-target routing
- `references/adapter-iframe.md` - iframe parent/child setup, origin checks, nonce usage, heartbeat, reconnect, and session-bound handles
- `references/policy-and-lifecycle.md` - core policy, authorization style, lifecycle expectations, and documentation style

For deeper details, read the repository documentation under `c-w-xiaohei/nexus/docs`.
