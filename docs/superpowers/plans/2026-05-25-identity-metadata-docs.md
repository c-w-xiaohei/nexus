# Identity Metadata Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a clear, general mental model for `EndpointMeta` and `PlatformMeta` in public docs and the `use-nexus` skill.

**Architecture:** Add one public concept page as the canonical explanation, then link it from existing concept and policy docs. Mirror the same concise guidance in the project skill so future agents can apply the model without reading every doc page.

**Tech Stack:** Markdown docs, project-level `.agents/skills/use-nexus` reference files, Prettier markdown formatting.

---

## File Structure

- Create `docs/identity-and-metadata.md`: canonical public guide for `EndpointMeta` and `PlatformMeta` definitions, data/type-safety chains, field placement rules, consumption points, and best practices.
- Modify `docs/concepts.md`: add a short pointer from runtime identity concepts to the new guide and include it in the related docs list.
- Modify `docs/auth-and-policy.md`: replace stale `User metadata` wording with `EndpointMeta`, clarify trust boundaries, and link to the new guide.
- Create `.agents/skills/use-nexus/references/identity-and-metadata.md`: compact agent-facing reference aligned with the public guide.
- Modify `.agents/skills/use-nexus/SKILL.md`: add the new reference to focused reference list and fix stale `defaultCreate.target` / `tokenSpace(...)` examples if present.
- Modify `.agents/skills/use-nexus/references/shared-contracts.md`, `.agents/skills/use-nexus/references/runtime-configuration.md`, and `.agents/skills/use-nexus/references/targeting-and-proxies.md`: add concise links or wording to the new identity/meta reference where it affects Tokens, config, targeting, and policy.

## Task 1: Public Docs Identity And Metadata Guide

**Files:**
- Create: `docs/identity-and-metadata.md`
- Modify: `docs/concepts.md`
- Modify: `docs/auth-and-policy.md`

- [ ] **Step 1: Add the canonical guide**

Create `docs/identity-and-metadata.md` with these required sections and wording goals:

```md
# Identity And Metadata

EndpointMeta is the endpoint's logical identity: what runtime context it is, how the application wants to route to it, and which product-level labels policy may inspect.

PlatformMeta is adapter-observed platform fact: connection source, authentication state, transport facts, and other information the adapter can observe or verify.

## The Short Model

EndpointMeta = self-described product identity + routing identity.

PlatformMeta = adapter-observed connection facts + verified security facts.

Use EndpointMeta for targeting and product identity. Use PlatformMeta for adapter facts and security-sensitive policy. If a field is declared by the peer, treat it as identity; if it is observed or verified by the adapter, treat it as platform fact.
```

Continue the guide with sections covering:

- data chain: configure/helper -> local identity -> handshake -> peer `remoteIdentity` / `platform` -> target/policy/diagnostics
- type-safety chain: `Nexus<EndpointMeta, PlatformMeta>`, `TokenSpace<EndpointMeta, PlatformMeta>`, Token `defaultTarget`, descriptors, matchers, policy
- field placement rules using simple questions
- who provides `EndpointMeta`
- who provides `PlatformMeta`
- who consumes both meta types
- best practices
- one general non-Chrome example using host/client/worker

- [ ] **Step 2: Link from concepts**

In `docs/concepts.md`, add one short paragraph near `Contracts And Runtime Identity` or `Startup And Configuration` explaining that `EndpointMeta` and `PlatformMeta` are the two typed metadata channels, then link `docs/identity-and-metadata.md`.

Also add `Identity and metadata: docs/identity-and-metadata.md` under `Where To Go Next`.

- [ ] **Step 3: Update policy trust wording**

In `docs/auth-and-policy.md`, replace stale `User metadata is logical identity` with `EndpointMeta is logical identity` and add one sentence linking to `docs/identity-and-metadata.md` for full field placement guidance.

- [ ] **Step 4: Verify docs formatting**

Run:

```bash
pnpm exec prettier --check docs/identity-and-metadata.md docs/concepts.md docs/auth-and-policy.md
```

Expected: all files use Prettier code style.

## Task 2: use-nexus Skill Identity And Metadata Guidance

**Files:**
- Create: `.agents/skills/use-nexus/references/identity-and-metadata.md`
- Modify: `.agents/skills/use-nexus/SKILL.md`
- Modify: `.agents/skills/use-nexus/references/shared-contracts.md`
- Modify: `.agents/skills/use-nexus/references/runtime-configuration.md`
- Modify: `.agents/skills/use-nexus/references/targeting-and-proxies.md`

- [ ] **Step 1: Add the skill reference**

Create `.agents/skills/use-nexus/references/identity-and-metadata.md` as a compact reference with these sections:

```md
# Identity And Metadata

EndpointMeta = self-described product identity + routing identity.

PlatformMeta = adapter-observed connection facts + verified security facts.

Use EndpointMeta for targeting and product identity. Use PlatformMeta for adapter facts and security-sensitive policy.
```

Include concise bullets for:

- place fields in `EndpointMeta` when they are app-declared, routing-related, product labels, or used by descriptors/matchers
- place fields in `PlatformMeta` when they are adapter-observed, transport facts, auth results, or stronger policy inputs
- avoid secrets and large objects in either
- prefer discriminated unions with `context`
- use `updateIdentity(...)` only for routing/policy/lifecycle relevant identity changes
- recreate raw proxies after session/identity replacement

- [ ] **Step 2: Add reference entry to SKILL.md**

In `.agents/skills/use-nexus/SKILL.md`, add the new reference to `When More Detail Is Needed`:

```md
- `references/identity-and-metadata.md` - `EndpointMeta`, `PlatformMeta`, field placement, trust boundaries, and metadata consumption
```

While editing, fix stale proposal 09 terminology if present:

- `defaultCreate.target` -> `defaultTarget`
- `tokenSpace(...)` -> `space(...)`
- `services: [config]` -> `providers: [provider]`
- `const { config, store } = createNexusStore(...)` -> `const { provider, store } = createNexusStore(...)`

- [ ] **Step 3: Link focused references**

Add short pointers to `.agents/skills/use-nexus/references/shared-contracts.md`, `runtime-configuration.md`, and `targeting-and-proxies.md` so agents know when to read the identity/meta reference.

- [ ] **Step 4: Verify skill docs formatting and stale terms**

Run:

```bash
pnpm exec prettier --check .agents/skills/use-nexus/SKILL.md .agents/skills/use-nexus/references/*.md
```

Search for stale terms:

```bash
rg "defaultCreate|tokenSpace\(|services: \[config\]|User metadata" .agents/skills/use-nexus docs
```

Expected: no stale hits except intentional historical context if explicitly marked as migration text.

## Task 3: Final Verification And PR Update

**Files:**
- All modified docs and skill files

- [ ] **Step 1: Run docs verification**

Run:

```bash
pnpm exec prettier --check docs/**/*.md .agents/skills/use-nexus/**/*.md .changeset/*.md AGENTS.md README.md packages/*/README.md
```

Expected: all matched files use Prettier code style.

- [ ] **Step 2: Inspect diff**

Run:

```bash
git diff --stat
git diff -- docs/identity-and-metadata.md docs/concepts.md docs/auth-and-policy.md .agents/skills/use-nexus
```

Expected: diff is scoped to identity/meta docs and skill guidance.

- [ ] **Step 3: Commit and push**

Run:

```bash
git add docs/identity-and-metadata.md docs/concepts.md docs/auth-and-policy.md docs/superpowers/plans/2026-05-25-identity-metadata-docs.md .agents/skills/use-nexus
git commit -m "docs: explain endpoint and platform metadata"
git push
```

- [ ] **Step 4: Confirm PR CI**

Run:

```bash
gh pr checks 12 --watch
```

Expected: all checks pass.
