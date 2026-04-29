# Nexus Docs And State Test Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `docs/` into Nexus-level product documentation instead of Nexus-State-only docs, and systematically harden Nexus State tests only in the layers where coverage is genuinely weaker than the rest of `packages/core`.

**Architecture:** Split the work into two streams. First, restructure documentation around Nexus as the product, with `docs/README.md` as the canonical docs landing page and Nexus State moved under a dedicated `docs/state/` section. Second, perform a coverage audit before adding tests, then improve Nexus State tests only at the layers that are genuinely under-covered, especially true L4/e2e gaps that lower-layer tests do not already prove. Keep changes focused and incremental, with every new test written red-first.

**Tech Stack:** Markdown, TypeScript, Vitest, pnpm workspaces, Nexus core test utilities.

---

## File Map

### Docs files to create or restructure

- Create: `docs/README.md`
  - Canonical root Nexus docs landing page
- Create: `docs/getting-started.md`
  - Nexus product-level quick start and installation guidance
- Create: `docs/concepts.md`
  - Replace the current state-centric root concepts page with a Nexus-wide concepts page
- Create: `docs/platforms.md`
  - High-level platform/context model and adapter framing
- Create: `docs/packages.md`
  - Product-level package map for Nexus core, adapters, and subsystems
- Create: `docs/state/README.md`
  - Nexus State overview page within docs
- Create: `docs/state/quick-start.md`
  - State-specific quick start, moved under state section
- Create: `docs/state/concepts.md`
  - State-specific mental model
- Create: `docs/state/core-api.md`
  - State core API
- Create: `docs/state/react.md`
  - State React API
- Create: `docs/state/lifecycle-and-errors.md`
  - State lifecycle/error semantics
- Create: `docs/state/testing.md`
  - State testing guide
- Create: `docs/state/faq.md`
  - State FAQ

### Docs files to remove or replace

- Remove or replace content from current root-level state docs:
  - `docs/index.md` (remove in favor of `docs/README.md`)
  - `docs/quick-start.md`
  - `docs/core-api.md`
  - `docs/react.md`
  - `docs/lifecycle-and-errors.md`
  - `docs/testing.md`
  - `docs/faq.md`
  - `docs/concepts.md`

### Test files to inspect or modify

- Inspect first: `packages/core/src/state/react-agnostic.test.ts`
- Inspect first: `packages/core/src/state/state.test.ts`
- Inspect first: `packages/core/src/api/e2e.test.ts`
- Modify: `packages/core/src/state/react-agnostic.test.ts`
- Modify: `packages/core/src/state/state.test.ts`
- Modify: `packages/core/src/api/e2e.test.ts`

### Existing files to consult

- `README.md`
- `packages/core/src/index.ts`
- `packages/core/src/api/nexus.ts`
- `packages/core/src/api/token-space.ts`
- `packages/core/src/api/kernel.ts`
- `packages/core/src/state/*`
- `packages/react/src/*`
- `packages/core/src/service/intergration.test.ts`
- `packages/core/src/connection/connection-manager.test.ts`
- `packages/core/src/api/e2e.test.ts`

## Task 1: Define Root Docs Information Architecture

**Files:**

- Create: `docs/README.md`
- Create: `docs/packages.md`
- Create: `docs/getting-started.md`
- Create: `docs/platforms.md`
- Modify: current `docs/` markdown files only enough to settle root IA decisions

- [ ] **Step 1: Write the failing structure checklist**

Create a short checklist in a scratch note or temporary test-style doc comment that asserts:

- docs root speaks about Nexus, not Nexus State only
- Nexus State appears as a subsystem section, not the product root
- `docs/README.md` is the canonical docs landing page
- there is a clear install / choose-your-path entry

- [ ] **Step 2: Inspect current docs tree and confirm failure against the checklist**

Run: `find docs -maxdepth 2 -type f | sort`
Expected: Root docs are currently state-centric and need restructuring.

- [ ] **Step 3: Create Nexus-level root docs pages**

Write:

- `docs/README.md`
- `docs/getting-started.md`
- `docs/platforms.md`
- `docs/packages.md`

Requirements:

- Nexus is the subject
- State is introduced as one component/capability
- include package/install guidance and audience routing

- [ ] **Step 4: Validate root IA before moving State content**

Requirements:

- root docs introduce Nexus
- package map includes Nexus core and adapter-level entry points
- no root page still frames Nexus State as the product

- [ ] **Step 5: Stage root docs changes only**

- `git add docs`

## Task 2: Move Nexus State Docs Under `docs/state/`

**Files:**

- Create: `docs/state/README.md`
- Create: `docs/state/quick-start.md`
- Create: `docs/state/concepts.md`
- Create: `docs/state/core-api.md`
- Create: `docs/state/react.md`
- Create: `docs/state/lifecycle-and-errors.md`
- Create: `docs/state/testing.md`
- Create: `docs/state/faq.md`
- Replace/remove previous root-level state docs

- [ ] **Step 1: Write the failing migration checklist**

Checklist must include:

- all state-specific content lives under `docs/state/`
- titles and intros clearly say “Nexus State”, not “Nexus”
- root docs link into `docs/state/` instead of duplicating subsystem docs

- [ ] **Step 2: Create `docs/state/` pages by migrating useful existing content**

Requirements:

- preserve useful content
- re-scope titles and navigation so these are clearly State docs
- avoid broken navigation references

- [ ] **Step 3: Remove or replace old root-level state pages**

Requirements:

- root docs should no longer look like a shell around state docs
- no duplicate quick-start/concepts pages at root and state level with conflicting ownership

- [ ] **Step 4: Validate root-vs-state boundary**

Check that:

- root docs introduce Nexus
- state docs introduce Nexus State
- navigation is coherent

- [ ] **Step 5: Stage docs migration changes**

- `git add docs`

## Task 3: Improve Nexus And State Docs Content Quality

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/packages.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/concepts.md` or equivalent Nexus-wide concept page if created
- Modify: `docs/state/*.md`

- [ ] **Step 1: Write the failing docs quality checklist**

Checklist must include:

- root docs explain package choices clearly
- quick start is actually actionable
- examples are complete enough to follow
- jargon is reduced on first contact
- docs are task-oriented, not just architecture-oriented

- [ ] **Step 2: Compare docs against checklist and identify specific gaps**

Use the latest reviewer findings as input.

- [ ] **Step 3: Add package/install guidance and audience routing**

Requirements:

- clarify `@nexus-js/core`, `@nexus-js/core/state`, `@nexus-js/react`
- make “which package do I need?” answer immediate

- [ ] **Step 4: Add practical recipes**

Requirements:

- one headless lifecycle recipe
- one React loading/error recipe
- one throw-vs-safe API choice recipe

- [ ] **Step 5: Tighten wording for implementation accuracy**

Requirements:

- avoid overstating reconnect behavior
- use replacement/new-handle language where appropriate
- reduce maintainer-only jargon on first mention

- [ ] **Step 6: Stage docs content improvements**

- `git add docs`

## Task 4: Audit Nexus State Coverage Before Adding Tests

**Files:**

- Inspect: `packages/core/src/state/state.test.ts`
- Inspect: `packages/core/src/state/react-agnostic.test.ts`
- Inspect: `packages/core/src/api/e2e.test.ts`
- Inspect: neighboring core tests for comparison only

- [ ] **Step 1: Build a coverage matrix by layer**

Map current Nexus State coverage across:

- protocol/schema
- host runtime
- client runtime
- service integration
- connection/disconnect lifecycle
- full L4/e2e

- [ ] **Step 2: Compare that matrix to neighboring `packages/core` modules**

Identify where State is genuinely thinner, especially at L4/e2e.

- [ ] **Step 3: Produce a short gap list before writing new tests**

Requirements:

- do not duplicate behaviors already strongly covered in lower layers
- identify only the high-value missing tests

- [ ] **Step 4: Stage any audit notes only if stored in repo**

Skip if no repo artifact is needed.

## Task 5: Add Missing Nexus State L4/E2E Tests

**Files:**

- Modify: `packages/core/src/api/e2e.test.ts`

- [ ] **Step 1: Write failing end-to-end tests only for gaps proven missing by Task 4**

Add failing tests only for the highest-value L4 gaps identified in the audit.

- [ ] **Step 2: Run only the new failing state e2e tests**

Run the specific Vitest test names or file with focused matcher.
Expected: FAIL for newly added cases.

- [ ] **Step 3: Implement the minimal runtime/test-harness changes needed**

Requirements:

- prefer black-box assertions over internal resource-manager poking where possible
- only add supporting code if the missing behavior truly exists but is unobservable today

- [ ] **Step 4: Re-run focused e2e tests**

Run: `pnpm --filter @nexus-js/core test -- src/api/e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Stage e2e test changes**

- `git add packages/core/src/api/e2e.test.ts packages/core/src/state packages/core/src/service`

## Task 6: Add Missing State Runtime/Protocol Tests Only If Audit Still Justifies Them

**Files:**

- Modify: `packages/core/src/state/react-agnostic.test.ts`
- Modify: `packages/core/src/state/state.test.ts`

- [ ] **Step 1: Write failing focused tests only for runtime/protocol gaps still missing after Task 4**

Candidates:

- malformed baseline cleanup edge case
- malformed dispatch result cleanup edge case
- explicit timeout behavior in `safeConnectNexusStore`
- any remaining race-condition gap identified after Task 4

These are examples only. If Task 4 shows a candidate is already sufficiently covered, do not add it.

- [ ] **Step 2: Run focused state tests and confirm failures**

Run:

- `pnpm --filter @nexus-js/core test -- src/state/state.test.ts`
- `pnpm --filter @nexus-js/core test -- src/state/react-agnostic.test.ts`

- [ ] **Step 3: Implement minimal fixes or assertions**

Requirements:

- only add tests for semantics the implementation intends to guarantee
- avoid overfitting to internals

- [ ] **Step 4: Re-run focused state tests**

Expected: PASS.

- [ ] **Step 5: Stage runtime/protocol test changes**

- `git add packages/core/src/state/state.test.ts packages/core/src/state/react-agnostic.test.ts`

## Task 7: Final Verification And Docs/Test Review

**Files:**

- Modify only if review finds real issues

- [ ] **Step 1: Run full verification**

Run:

- `pnpm --filter @nexus-js/core test`
- `pnpm --filter @nexus-js/core typecheck`
- `pnpm --filter @nexus-js/react test`
- `pnpm --filter @nexus-js/react typecheck`
- `pnpm --filter @nexus-js/react build`

- [ ] **Step 2: Run docs quality review**

Check:

- Nexus docs root is product-level
- State docs are a subsection
- quick start and concepts are complete enough for new users

- [ ] **Step 3: Run final test quality review**

Check:

- state coverage no longer lags true L4/e2e needs
- new tests are not overly white-box

- [ ] **Step 4: Fix any remaining review findings**

Only if issues are real and in scope.

- [ ] **Step 5: Commit the completed docs/test hardening work**

```bash
git add docs packages/core packages/react
git commit -m "docs: complete nexus docs and state test hardening"
```
