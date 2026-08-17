# Identity And Metadata

ContextMeta = self-described product identity and runtime identity.

ConnectionMeta = adapter-observed connection facts and adapter-verified security facts when available.

Use `ContextMeta` for peer identity and `where`. Use `ConnectionMeta` for adapter facts and security-sensitive policy. If a peer declares a field about itself, treat it as identity; if an adapter observes or verifies it, treat it as connection metadata.

## Field Placement

- Put fields in `ContextMeta` when they are app-declared identity, product labels, routing fields, tenant/region/context markers, inputs for `where`, or policy that can trust peer-declared identity.
- Put fields in `ConnectionMeta` when they are adapter-observed facts, transport facts, source/process details, authentication results, admission results, or stronger inputs for security-sensitive policy.
- Avoid secrets, credentials, large payloads, mutable objects, and frequently changing business state in either metadata channel. Use service calls or Nexus State for application data.
- Prefer discriminated unions with a `context` field for `ContextMeta` roles so `where` and policy stay type-narrowed.
- Put shared `ContextMeta` and `ConnectionMeta` types next to shared Tokens when an adapter model is needed, then use `Nexus<AdapterModel>` and `TokenSpace<AdapterModel>`.

## Runtime Use

- Provide `ContextMeta` through `configure(...)`, adapter helper options, or `updateIdentity(...)` when routing-relevant identity changes.
- Treat `ConnectionMeta` as adapter-owned, immutable, session-scoped metadata. Application options may feed adapter auth/admission, but the resulting facts should come from the adapter.
- Use `updateIdentity(...)` only for changes that affect targeting, policy, diagnostics, or lifecycle behavior; keep ordinary app data out of identity.
- Recreate raw `nexus.create(...)` proxies and refs after session replacement, connection loss, or identity replacement that should retarget future calls.

For the full public guide, see `docs/identity-and-metadata.md`.
