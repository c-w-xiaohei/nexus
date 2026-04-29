# Integration Test Rename And Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename Nexus high-level tests from `e2e` to `integration`, harden lifecycle-oriented integration coverage across core domains, and add missing React integration and unit tests until review finds no major issues.

**Architecture:** First, rename and reconfigure the high-level test layout so `packages/core/integration/**` and `packages/react/integration/**` are first-class test locations with deterministic path-based execution. Then audit and extend core lifecycle coverage and add React real-runtime integration tests plus focused hook/unit tests. Keep React integration tests on public package APIs and a React-owned local harness, and use review loops to stop only when major concerns are gone.

**Tech Stack:** TypeScript, Vitest, React Testing Library, pnpm workspaces, Nexus core/state public APIs, Turbo.

---

## File Map

### Core rename/config files

- Modify: `packages/core/tsconfig.json`
  - Include `packages/core/integration/**` in package typechecking inputs
- Modify: `packages/core/vitest.config.ts`
  - Ensure renamed integration paths are discoverable and path-based execution is stable
- Create or rename under: `packages/core/integration/`
  - `fixtures.ts`
  - `runtime/basic-rpc.integration.test.ts`
  - `runtime/lifecycle-and-errors.integration.test.ts`
  - `runtime/resource-and-callbacks.integration.test.ts`
  - `runtime/target-resolution.integration.test.ts`
  - `bootstrapping/service-bootstrapping.integration.test.ts`
  - `state/protocol-and-errors.integration.test.ts`
  - `state/lifecycle-and-cleanup.integration.test.ts`
  - `state/targeting-and-handoff.integration.test.ts`
- Remove/rename from: `packages/core/e2e/**`

### React config/test files

- Modify: `packages/react/tsconfig.json`
  - Include `packages/react/integration/**`
- Modify: `packages/react/vite.config.ts`
  - Make integration test discovery deterministic and ensure tests resolve package dependencies reliably
- Modify: `packages/react/src/react.test.tsx`
  - Add missing hook/unit tests that do not require a real runtime
- Create: `packages/react/integration/fixtures.ts`
  - React-owned real-runtime harness using public `@nexus-js/core` and `@nexus-js/core/state` APIs only
- Create: `packages/react/integration/real-store-lifecycle.integration.test.tsx`
  - Real Nexus + React integration coverage for provider/store/selector lifecycle

### Docs/spec references to update if current-facing

- Modify: `docs/state/testing.md`
- Modify: `docs/superpowers/specs/2026-03-29-integration-test-rename-and-hardening-design.md`
- Modify only if current-facing references require it: other docs mentioning `e2e` as the active high-level suite name

## Task 1: Rename Core High-Level Tests To Integration And Reconfigure Discovery

**Files:**

- Modify: `packages/core/tsconfig.json`
- Modify: `packages/core/vitest.config.ts`
- Rename: `packages/core/e2e/fixtures.ts` -> `packages/core/integration/fixtures.ts`
- Rename: `packages/core/e2e/**/*.e2e.test.ts` -> `packages/core/integration/**/*.integration.test.ts`
- Modify: renamed test files to update top comments and `describe(...)` titles
- Modify: `docs/state/testing.md`

- [ ] **Step 1: Write the failing config/path expectations**

Document the intended path-based commands in the renamed layout:

- `pnpm --filter @nexus-js/core test integration/runtime/basic-rpc.integration.test.ts`
- `pnpm --filter @nexus-js/core test integration/state/lifecycle-and-cleanup.integration.test.ts`

Also note that `packages/core/tsconfig.json` currently excludes the new folder and must be updated.

- [ ] **Step 2: Verify the current state fails the renamed-path expectation**

Run: `pnpm --filter @nexus-js/core test integration/runtime/basic-rpc.integration.test.ts`
Expected: FAIL because `integration/` does not exist yet.

- [ ] **Step 3: Rename the directory and files**

Rename `packages/core/e2e/` to `packages/core/integration/` and all `*.e2e.test.ts` files to `*.integration.test.ts`.

Update in each file:

- top-of-file scenario comment still accurate after rename
- `describe(...)` titles use `Integration` instead of `E2E`

- [ ] **Step 4: Update package config for the renamed location**

Adjust `packages/core/tsconfig.json` and `packages/core/vitest.config.ts` so:

- `packages/core/integration/**` is included in typechecking inputs
- Vitest can execute path-based selections in `integration/**`

- [ ] **Step 5: Update active docs references to integration terminology**

At minimum update `docs/state/testing.md` so it talks about multi-context integration tests instead of E2E tests when describing the current suite.

- [ ] **Step 6: Run targeted renamed-suite checks**

Run:

- `pnpm --filter @nexus-js/core test integration/runtime/basic-rpc.integration.test.ts`
- `pnpm --filter @nexus-js/core test integration/state/lifecycle-and-cleanup.integration.test.ts`
- `pnpm --filter @nexus-js/core typecheck`

Expected: renamed test paths execute and package typecheck includes the renamed suite successfully.

## Task 2: Audit And Harden Core Integration Lifecycle Coverage

**Files:**

- Inspect/modify: `packages/core/integration/runtime/*.integration.test.ts`
- Inspect/modify: `packages/core/integration/bootstrapping/*.integration.test.ts`
- Inspect/modify: `packages/core/integration/state/*.integration.test.ts`
- Inspect/modify if needed: `packages/core/integration/fixtures.ts`

- [ ] **Step 1: Write the failing lifecycle-gap checklist**

Audit against this checklist:

- sibling disconnect does not break unaffected live callers
- callback/resource cleanup happens for explicit unsubscribe and transport loss
- target replacement ignores superseded late resolution
- disconnected or stale store does not keep leaking subscribers
- reconnect/replacement path reaches the correct final visible state
- bootstrap/service registration still has at least one real integration proof if needed

- [ ] **Step 2: Run the current integration files and identify missing proofs**

Run:

- `pnpm --filter @nexus-js/core test integration/runtime`
- `pnpm --filter @nexus-js/core test integration/state`
- `pnpm --filter @nexus-js/core test integration/bootstrapping`

Expected: existing files pass, but the checklist reveals concrete missing lifecycle assertions.

- [ ] **Step 3: Add one failing integration test per missing behavior**

Add only genuinely missing scenarios. Candidate additions include:

- runtime case proving one client disconnect does not break another still-live caller sharing the host
- runtime/resource case proving callback resources are fully cleaned on both explicit unsubscribe and connection close
- state case proving replacement/late-resolve ordering and stale subscriber cleanup
- state case proving destroy/unsubscribe of one remote does not affect other remotes still attached to the host store

- [ ] **Step 4: Run each new test to confirm RED**

Run path-specific Vitest commands for each newly added test file or test name.
Expected: FAIL for the intended lifecycle gap, not due to typo or path issues.

- [ ] **Step 5: Implement the minimal test or runtime changes to make the new assertions pass**

Prefer test-only additions first. If a real bug is exposed, apply the smallest production change needed.

- [ ] **Step 6: Re-run targeted core integration verification**

Run:

- `pnpm --filter @nexus-js/core test integration/runtime`
- `pnpm --filter @nexus-js/core test integration/state`
- `pnpm --filter @nexus-js/core test integration/bootstrapping`

Expected: all targeted core integration suites pass with stronger lifecycle coverage.

## Task 3: Add React Real-Runtime Integration Tests

**Files:**

- Modify: `packages/react/tsconfig.json`
- Modify: `packages/react/vite.config.ts`
- Create: `packages/react/integration/fixtures.ts`
- Create: `packages/react/integration/real-store-lifecycle.integration.test.tsx`

- [ ] **Step 1: Write the failing React integration scenarios**

Add tests that use public package APIs only and a React-owned local harness. Required scenarios:

- provider + `useRemoteStore` connects to a real provided store
- action updates become visible through `useStoreSelector`
- transport disconnect becomes hook-visible `disconnected`
- target change causes fallback/stale transition before ready replacement
- unmount destroys the active remote store / subscription path

- [ ] **Step 2: Verify RED for the new React integration file**

Run: `pnpm --filter @nexus-js/react test:integration:file integration/react.integration.test.tsx`
Expected: FAIL because the harness/config/tests do not exist yet.

- [ ] **Step 3: Add React integration harness and config support**

Implement `packages/react/integration/fixtures.ts` using public package APIs only.

Update `packages/react/tsconfig.json` and `packages/react/vite.config.ts` so:

- `integration/**` is included for typechecking/test discovery
- tests can deterministically resolve `@nexus-js/core` and `@nexus-js/core/state`
- if dist-based package resolution is required, make verification run after a core build step or add explicit test aliasing

- [ ] **Step 4: Run the new React integration tests to confirm RED against real behavior gaps if any remain**

Run: `pnpm --filter @nexus-js/react test:integration:file integration/react.integration.test.tsx`
Expected: FAIL only on behavior not yet implemented/covered.

- [ ] **Step 5: Add the minimal code or test harness changes to make the integration tests pass**

Keep React integration tests focused on package-consumer behavior, not core private internals.

- [ ] **Step 6: Re-run targeted React integration verification**

Run:

- `pnpm --filter @nexus-js/core build`
- `pnpm --filter @nexus-js/react test:integration:file integration/react.integration.test.tsx`
- `pnpm --filter @nexus-js/react typecheck`

Expected: React integration test and typecheck pass reliably.

## Task 4: Add Missing React Unit Tests

**Files:**

- Modify: `packages/react/src/react.test.tsx`
- Modify only if needed: `packages/react/src/use-remote-store.ts`
- Modify only if needed: `packages/react/src/use-store-selector.ts`

- [ ] **Step 1: Write failing unit tests for uncovered hook-local behavior**

Focus on logic that does not require a real runtime and still appears thin. Good candidates:

- active store is destroyed on hook unmount after successful connect
- stale replacement store is cleared/destroyed after a successful next connect
- selector fallback behavior after adapter-stale transition remains stable across rerenders
- connect rejection normalization when non-Error values are thrown

- [ ] **Step 2: Run the focused React unit test selection to confirm RED**

Run path/test-name filtered Vitest commands against `packages/react/src/react.test.tsx`.
Expected: new tests fail for the intended missing behavior.

- [ ] **Step 3: Implement the minimal hook changes if tests expose a real gap**

Keep changes narrow and avoid reworking hook structure unless necessary.

- [ ] **Step 4: Re-run the focused React unit tests**

Run: `pnpm --filter @nexus-js/react test src/react.test.tsx`
Expected: target file passes with the new unit assertions.

## Task 5: Verification And Review Loop Until No Major Issues Remain

**Files:**

- Verify all changed files from Tasks 1-4

- [ ] **Step 1: Run targeted package verification**

Run:

- `pnpm --filter @nexus-js/core typecheck`
- `pnpm --filter @nexus-js/core test integration`
- `pnpm --filter @nexus-js/react typecheck`
- `pnpm --filter @nexus-js/react test src/react.test.tsx`
- `pnpm --filter @nexus-js/react test integration`
- `pnpm --filter @nexus-js/react test:integration:file integration/react.integration.test.tsx`

Expected: all targeted checks pass.

- [ ] **Step 2: Run broader package verification**

Run:

- `pnpm --filter @nexus-js/core test`
- `pnpm --filter @nexus-js/react test`

Expected: package-level suites remain green.

- [ ] **Step 3: Dispatch review agents and fix all major issues**

Required review passes:

- spec compliance review against `docs/superpowers/specs/2026-03-29-integration-test-rename-and-hardening-design.md`
- code quality review focused on test design, lifecycle assertions, config reliability, and React harness boundaries
- final high-level review focused on whether any major concerns remain

- [ ] **Step 4: Re-run verification after each non-trivial review fix**

Expected: no unresolved major review concerns remain.

- [ ] **Step 5: Delete the cron loop when the quality bar is reached**

Delete task: `nexus-integration-final-gate`
Only do this after the final review states there are no major issues left.
