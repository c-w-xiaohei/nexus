# Nexus State Test Coverage Audit (Task 4)

Date: 2026-03-28
Scope: `packages/core` Nexus State tests only, compared with neighboring core modules for relative depth.

## 1) Coverage Matrix (6 Layers)

| Layer                           | Current Coverage                  | Evidence                                                                                                                                                                                                                                                                                                                                                         | Audit Note                                                                                            |
| ------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| protocol/schema                 | Medium                            | `packages/core/src/state/state.test.ts` (`requires subscribe baseline envelope fields`, `requires snapshot envelope shape`, `validates dispatch request payload envelope`, `provides schema boundary for connect options`)                                                                                                                                       | Core schema boundaries exist, but no direct `DispatchResultEnvelopeSchema` boundary assertion.        |
| host runtime                    | Strong                            | `packages/core/src/state/react-agnostic.test.ts` (`creates initial versioned snapshot via subscribe baseline`, `dispatch advances version monotonically`, `host business error path does not corrupt versioned state`, `serializes overlapping async dispatches without losing updates`)                                                                         | Host semantics are already deeply covered; avoid duplicating in L4 unless transport adds unique risk. |
| client runtime                  | Strong                            | `packages/core/src/state/react-agnostic.test.ts` (`handles callback-before-subscribe-return ordering without rollback`, `ignores duplicate versions...`, `await remote actions resolves only after mirror observes committed version`, `concurrent actions resolve only after their own committed versions`, `safeConnectNexusStore enforces handshake timeout`) | Client state machine and ordering logic are well covered in runtime-focused tests.                    |
| service integration             | Strong                            | `packages/core/src/state/react-agnostic.test.ts` (`translates store definition to ordinary ServiceRegistration`, `cleans orphan subscriptions on disconnect through layer3 runtime`, `binds ... ownership ... and cleans via disconnect hook`)                                                                                                                   | State service contract integration is already exercised against L3 utilities.                         |
| connection/disconnect lifecycle | Strong (L2/L3), Medium (State L4) | General: `packages/core/src/connection/connection-manager.test.ts` (B4/B6 lifecycle coverage), `packages/core/src/service/intergration.test.ts` (`should clean up resources when a connection is terminated`). State-specific: `packages/core/src/state/react-agnostic.test.ts` disconnect cases + `packages/core/src/api/e2e.test.ts` two State E2E cases.      | Lifecycle behavior is robust below L4; State-specific L4 variants are comparatively thinner.          |
| full L4/e2e                     | Thin for State                    | `packages/core/src/api/e2e.test.ts` has only two State E2E tests (`connects remote store over ordinary service path and handles disconnect`; `synchronizes state across isolated contexts...`) versus many non-State E2E scenarios in same file                                                                                                                  | This is the main under-covered layer to prioritize for Task 5.                                        |

## 2) Already Covered (Do Not Duplicate In Task 5)

These behaviors already have strong lower-layer proof and should not be re-added as redundant L4 tests unless a transport-specific hole is discovered.

1. Host dispatch monotonic versioning and rollback-on-action-error (`react-agnostic.test.ts`).
2. Listener throw isolation and subscription fanout behavior (`react-agnostic.test.ts`).
3. Client version guards (ignore duplicate, reject older), stale/disconnected terminal state transitions (`react-agnostic.test.ts`).
4. Action resolution ordering vs committed snapshot versions (`react-agnostic.test.ts`).
5. L2/L3 connection cleanup mechanics and resource cleanup on disconnect (`connection-manager.test.ts`, `service/intergration.test.ts`).

## 3) Ranked True Remaining L4 Gaps

Ranked by value for cross-layer risk reduction.

1. **State L4 stale-instance replacement path**
   - Missing: real-network E2E proving a connected remote store transitions to `stale` when host store instance identity is replaced/mismatched, and then blocks actions with the intended error class.
2. **State L4 handshake failure classification (malformed baseline + timeout)**
   - Missing: E2E proof that handshake failure classes survive full stack (`NexusStoreProtocolError` for malformed baseline; `NexusStoreConnectError` timeout classification).
3. **State L4 in-flight action + disconnect unknown-commit semantics**
   - Missing: E2E proof that disconnect during in-flight action produces the explicit unknown-commit disconnect behavior already covered in client-runtime unit/integration tests.

## 4) Routing Guidance For Next Tasks

- **Task 5 (L4/E2E):**
  - Add tests for Ranked Gaps #1, #2, #3 only.
  - Keep black-box assertions at public API level (`connectNexusStore`, `remote.getStatus()`, action promise outcomes).

- **Task 6 (runtime/protocol):**
  - Add only if Task 5 reveals unresolved behavior not already covered below L4.
  - Current likely candidate: direct `DispatchResultEnvelopeSchema` boundary assertion in `packages/core/src/state/state.test.ts`.

- **No new tests needed now:**
  - Host runtime dispatch semantics, listener isolation, and rollback logic.
  - Existing disconnect cleanup semantics already covered by L2/L3 + current State integration tests.
