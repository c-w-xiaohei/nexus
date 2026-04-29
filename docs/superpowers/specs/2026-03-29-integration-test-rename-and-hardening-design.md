# Integration Test Rename And Hardening Design

**Context**

The `feature/nexus-state` worktree already contains high-level cross-context tests under `packages/core/e2e/` and hook-oriented tests under `packages/react/src/react.test.tsx`. The current naming is inconsistent with the actual testing level: these tests are integration-style system scenarios, not strict black-box end-to-end tests. At the same time, lifecycle coverage is uneven across `runtime`, `bootstrapping`, `state`, and `react`, with React currently lacking true cross-package integration coverage against a real Nexus runtime.

**Goals**

- Rename high-level test organization from `e2e` to `integration` in a complete and internally consistent way.
- Audit integration coverage by domain and add only tests that close real behavioral gaps.
- Strengthen lifecycle-oriented coverage, especially disconnect, stale, reconnect, handoff, cleanup, and teardown semantics.
- Add React integration tests that exercise `@nexus-js/react` against real `@nexus-js/core/state` behavior instead of mocked-only hook flows.

**Non-Goals**

- Re-architecting Nexus runtime or state semantics unless the audit reveals a concrete testability or correctness bug.
- Replacing focused unit tests in `src/` with integration tests.
- Rewriting all existing React tests; mocked hook tests remain useful and should stay where they are if still valuable.

## Design

### 1. Naming And Layout

Rename the core high-level test tree from `packages/core/e2e/` to `packages/core/integration/`.

Also rename individual files from `*.e2e.test.ts` to `*.integration.test.ts` and update top-of-file comments and `describe(...)` titles to use `Integration` terminology.

Any repo docs, plans, scripts, or commands that refer to the old `e2e` location should be updated when they are still intended to describe the current tree. Historical plan references can remain if they are clearly archival, but current-facing references should match the renamed structure.

Because the renamed core tests live outside `src/`, this change must also make an explicit config decision for `packages/core/integration/**`: either include the folder in `packages/core/tsconfig.json` and package test discovery, or document that test execution is Vitest-only and intentionally outside `tsc --noEmit`. The preferred design for this change is to include `packages/core/integration/**` in package typechecking and test discovery so the renamed suite has the same quality gate as package-local test files.

### 2. Domain-Based Audit

Audit the current high-level coverage in four domains:

- `runtime`
- `bootstrapping`
- `state`
- `react`

For each domain, evaluate whether existing tests already prove the important behavior at integration level or whether the assertion exists only in lower-level/unit tests. Add tests only where the integration layer currently leaves room for regressions.

The audit should explicitly focus on lifecycle transitions and ownership cleanup, not just happy-path invocation coverage.

### 3. Lifecycle Coverage Standard

Use the following lifecycle checklist when auditing and expanding tests:

- connect succeeds and initial ready state becomes observable
- disconnect propagates to consumers promptly
- post-disconnect operations fail in the expected way
- explicit unsubscribe/destroy cleans host-owned callback resources
- connection loss also cleans host-owned callback resources
- target handoff marks prior remote views stale without over-invalidating unrelated consumers
- late resolution from superseded connection attempts does not replace the active instance
- reconnect/replacement paths do not preserve stale subscriptions or leaked resources
- unmount/teardown paths in adapters destroy remote instances and stop further observation

### 4. Core Integration Additions

Keep the existing domain split and add only the missing scenarios.

Likely additions after audit:

- `runtime`: strengthen cleanup assertions around callback/resource ownership under explicit unsubscribe versus transport loss, and verify unaffected live callers continue working when a sibling disconnects.
- `state`: expand reconnect/replacement and cross-target lifecycle cases, especially stale-to-ready replacement ordering and subscriber cleanup after disconnect or destroy.
- `bootstrapping`: add coverage only if the audit shows missing integration proof for real bootstrap preconditions or service registration timing.

The tests should continue to read like simulated product scenarios, with each file beginning with a top-of-file comment describing the distributed setup being modeled.

### 5. React Integration Coverage

Introduce a dedicated React integration test area rather than treating all React behavior as hook-unit tests.

Preferred layout:

- `packages/react/integration/`
  - `fixtures.ts` for React-local real-runtime setup
  - `real-store-lifecycle.integration.test.tsx`
  - additional scenario files only if they are meaningfully distinct

To keep boundaries explicit and avoid coupling `@nexus-js/react` tests to core-internal test-only file locations, React integration tests should own a minimal local harness in `packages/react/integration/fixtures.ts`. That fixture may copy or adapt small pieces of core test setup logic, but it should not import from `packages/core` private test files by relative path. For this repo change, the chosen approach is local React-owned fixtures rather than extracting a new shared helper.

These tests should use a real Nexus runtime and real `connectNexusStore` flow. They should verify:

- `NexusProvider` + `useRemoteStore` connects to an actually provided store
- selector values track real remote mirror updates after actions
- transport disconnect transitions hook-visible status to `disconnected`
- target changes produce stale/fallback behavior before replacement, then recover when replacement becomes ready
- component unmount destroys the active remote store and avoids dangling subscriptions

The existing `packages/react/src/react.test.tsx` should remain focused on hook-local logic and adapter edge behavior using mocks/fakes.

Because the new tests live outside `src/`, this change must also update `packages/react/tsconfig.json` and any relevant Vitest configuration so `packages/react/integration/**/*.integration.test.tsx` is included in typechecking and test discovery.

### 6. Execution Strategy

Implement in subagent-driven stages:

1. Rename `e2e` to `integration` and repair direct references.
2. Audit and harden core integration coverage by domain.
3. Add React integration infrastructure and tests.
4. Run targeted verification, then broader package verification.

Subagents should receive task-scoped context, not open-ended repo exploration instructions. Review should prioritize spec compliance first, then code/test quality.

## Validation

At minimum, verify with explicit targeted commands that cover the renamed high-level suites and the new React integration tests. The implementation should settle on a deterministic command shape after the rename, for example:

- `pnpm --filter @nexus-js/core test integration` or `pnpm --filter @nexus-js/core test:integration:file integration/<file>`
- `pnpm --filter @nexus-js/react test integration` or `pnpm --filter @nexus-js/react test:integration:file integration/<file>`

If package scripts or config do not yet make those selectors work, this change should adjust config until targeted execution is reliable. After targeted checks pass, run the package-level test commands for `@nexus-js/core` and `@nexus-js/react` to ensure the new structure integrates with existing Vitest configuration.

## Risks And Mitigations

- **Risk:** Renaming test paths breaks package scripts or Vitest include patterns.
  - **Mitigation:** inspect current config before renaming, and run targeted test commands immediately after the rename task.
- **Risk:** React integration tests become flaky because they depend on timing-heavy cross-context behavior.
  - **Mitigation:** keep a small React-owned harness, keep scenarios narrow, and assert on stable lifecycle boundaries with `waitFor`.
- **Risk:** Audit scope grows into broad runtime refactors.
  - **Mitigation:** treat this as a test-structure and coverage-hardening task; only touch implementation when a new integration test exposes a real defect.
