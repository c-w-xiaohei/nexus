# Session Reconnect/Session-Loss Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement explicit reconnect/session-loss semantics so terminal handles never silently revive, replacement handles become the only recovery path, and behavior is proven by integration tests and docs updates.

**Architecture:** Keep the existing state model (`initializing`/`ready`/`disconnected`/`stale`/`destroyed`) and tighten transition rules around transport loss, replacement, and late in-flight responses. Drive changes from integration RED tests first, then patch runtime/state internals minimally to satisfy those tests. Cascade docs so API-level and React guidance match enforced runtime semantics.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces, Nexus core state runtime, Nexus React docs.

---

## File Map

- Modify (likely): `packages/core/integration/state/background-restart.integration.test.ts`
- Modify (likely): `packages/core/integration/state/lifecycle-and-cleanup.integration.test.ts`
- Modify (likely): `packages/core/integration/state/targeting-and-handoff.integration.test.ts`
- Modify (likely): `packages/core/src/state/client/remote-store.ts`
- Modify (likely): `packages/core/src/state/connect-store.ts`
- Modify (if needed): `packages/core/src/state/client/mirror-store.ts`
- Modify (if needed): `packages/core/src/state/state-client-runtime.test.ts`
- Modify (if needed): `packages/core/src/state/state-host-runtime.test.ts`
- Modify docs: `docs/state/lifecycle-and-errors.md`
- Modify docs: `docs/state/concepts.md`
- Modify docs: `docs/state/react.md`
- Modify docs: `docs/state/testing.md`

## Task 1: Core Reconnect Semantics and Integration Tests

**Files:**

- Test: `packages/core/integration/state/background-restart.integration.test.ts`
- Test: `packages/core/integration/state/lifecycle-and-cleanup.integration.test.ts`
- Test: `packages/core/integration/state/targeting-and-handoff.integration.test.ts`
- Modify (as required by failing tests): `packages/core/src/state/client/remote-store.ts`
- Modify (as required by failing tests): `packages/core/src/state/connect-store.ts`
- Modify (if required): `packages/core/src/state/client/mirror-store.ts`
- Test (unit guardrails if runtime changed): `packages/core/src/state/state-client-runtime.test.ts`

- [ ] **Step 1: Add/adjust failing integration tests for reconnect and session-loss rules**

Cover these explicit behaviors:

- transport/session loss moves active handle to `disconnected` (or transitional `stale` where intended) and action calls reject with disconnect-class errors
- old handle never returns to `ready` after host restart/replacement
- replacement connect produces a new usable handle that advances state independently
- late in-flight responses from torn-down sessions do not revive or mutate superseded handles
- sibling disconnect cleans only its own resources; surviving clients continue progressing

- [ ] **Step 2: Run targeted state integration tests to confirm RED**

Run:

- `pnpm --filter @nexus-js/core test integration/state/background-restart.integration.test.ts`
- `pnpm --filter @nexus-js/core test integration/state/lifecycle-and-cleanup.integration.test.ts`
- `pnpm --filter @nexus-js/core test integration/state/targeting-and-handoff.integration.test.ts`

Expected: failures represent missing/incorrect reconnect-session semantics, not test harness issues.

- [ ] **Step 3: Implement minimal runtime changes to satisfy semantics**

Adjust client/runtime transition logic so:

- terminal instances (`disconnected`/`stale`/`destroyed`) are non-revivable
- replacement path creates/binds a fresh instance instead of mutating old identity
- late protocol events are ignored once session ownership changes
- disconnect cleanup remains scoped per-connection/per-subscription owner

- [ ] **Step 4: Add/adjust focused unit tests only where new guards were introduced**

Prefer narrow tests in `packages/core/src/state/state-client-runtime.test.ts` (and host runtime tests only if touched) to lock in anti-revival and late-event drop behavior.

- [ ] **Step 5: Re-run verification for core state runtime and integration**

Run:

- `pnpm --filter @nexus-js/core test src/state/state-client-runtime.test.ts`
- `pnpm --filter @nexus-js/core test integration/state/background-restart.integration.test.ts`
- `pnpm --filter @nexus-js/core test integration/state/lifecycle-and-cleanup.integration.test.ts`
- `pnpm --filter @nexus-js/core test integration/state/targeting-and-handoff.integration.test.ts`

Expected: all targeted tests pass with reconnect/session-loss guarantees preserved.

## Task 2: Docs Cascade Updates Under `docs/`

**Files:**

- Modify: `docs/state/lifecycle-and-errors.md`
- Modify: `docs/state/concepts.md`
- Modify: `docs/state/react.md`
- Modify: `docs/state/testing.md`

- [ ] **Step 1: Add failing docs checklist from implemented semantics**

Capture required doc outcomes:

- explicitly distinguish replacement vs in-place recovery
- state terminal-handle non-revival semantics clearly
- define behavior for late in-flight events after session loss/replacement
- align React hook wording with stale/disconnected replacement lifecycle
- keep testing guidance aligned with current integration coverage paths

- [ ] **Step 2: Update lifecycle semantics doc first**

Update `docs/state/lifecycle-and-errors.md` as the canonical semantics source for reconnect/session loss, terminal states, and action failure guarantees.

- [ ] **Step 3: Cascade conceptual and React-facing wording**

Update `docs/state/concepts.md` and `docs/state/react.md` to match runtime semantics exactly (no silent-recovery wording, clear stale/disconnected replacement guidance).

- [ ] **Step 4: Update testing guide to reflect current proofs**

Update `docs/state/testing.md` with the specific integration files proving reconnect/session-loss behavior and when to add new integration coverage.

- [ ] **Step 5: Quick docs consistency pass**

Ensure status names, error class names, and replacement terminology are consistent across updated docs.

## Task 3: Final Verification

**Files:**

- Verify repository state after Task 1 and Task 2 changes.

- [ ] **Step 1: Run targeted core verification suite**

Run:

- `pnpm --filter @nexus-js/core test integration/state`
- `pnpm --filter @nexus-js/core test src/state/state-client-runtime.test.ts`

Expected: state integration and targeted unit checks pass.

- [ ] **Step 2: Run package-level safety checks for touched surfaces**

Run:

- `pnpm --filter @nexus-js/core typecheck`

Expected: typecheck passes with no regressions from reconnect/session-loss changes.

- [ ] **Step 3: Verify docs link/path sanity for touched docs**

Run a docs lint/check command if available in-repo; if no docs checker exists, manually confirm the updated docs reference existing paths and symbols.

- [ ] **Step 4: Capture implementation notes for dispatch handoff**

Record any residual edge cases discovered during verification (for example, whether any path still reports `stale` before `disconnected` under specific teardown ordering) so later subagents can execute follow-up tasks deterministically.
