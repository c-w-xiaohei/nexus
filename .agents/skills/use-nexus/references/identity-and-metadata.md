# Identity And Metadata

EndpointMeta = self-described product identity + routing identity.

PlatformMeta = adapter-observed connection facts + adapter-verified security facts when available.

Use `EndpointMeta` for targeting and product identity. Use `PlatformMeta` for adapter facts and security-sensitive policy. If a peer declares a field about itself, treat it as identity; if an adapter observes or verifies it, treat it as platform fact.

## Field Placement

- Put fields in `EndpointMeta` when they are app-declared identity, product labels, routing fields, tenant/region/context markers, or inputs for descriptors, matchers, Token `defaultTarget`, or policy that can trust peer-declared identity.
- Put fields in `PlatformMeta` when they are adapter-observed facts, transport facts, source/process details, authentication results, admission results, or stronger inputs for security-sensitive policy.
- Avoid secrets, credentials, large payloads, mutable objects, and frequently changing business state in either metadata channel. Use service calls or Nexus State for application data.
- Prefer discriminated unions with a `context` field for `EndpointMeta` roles so descriptors, matchers, and policy stay type-narrowed.
- Put shared `EndpointMeta` and `PlatformMeta` types next to shared Tokens, then use the same types with `Nexus<EndpointMeta, PlatformMeta>` and `TokenSpace<EndpointMeta, PlatformMeta>`.

## Runtime Use

- Provide `EndpointMeta` through `configure(...)`, adapter helper options, or `updateIdentity(...)` when routing-relevant identity changes.
- Treat `PlatformMeta` as adapter-owned connection metadata. Application options may feed adapter auth/admission, but the resulting facts should come from the adapter.
- Use `updateIdentity(...)` only for changes that affect targeting, policy, diagnostics, or lifecycle behavior; keep ordinary app data out of identity.
- Recreate raw `nexus.create(...)` proxies and refs after session replacement, connection loss, or identity replacement that should retarget future calls.

For the full public guide, see `docs/identity-and-metadata.md`.
