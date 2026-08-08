# Architecture Audit — Setup Readiness Implementation

**Date:** 2026-07-30
**Scope:** goal-driven setup FSM, secret-free tool detection, Cloud membership,
repo policy, history import, sync verification, destination routing, native
setup reentry accelerator
**Mode:** implementation audit

## Acceptance criteria

- [x] Goal-specific visible steps and guards replace slide-index completion.
- [x] Progress is resumable and normalized through one versioned schema.
- [x] Completion persists progress and outcome in one settings write.
- [x] Key detection cannot retain secret-bearing RPC fields.
- [x] Cloud create/join has one shared membership command boundary.
- [x] Organization success requires authoritative roster convergence.
- [x] Admin and member team paths have distinct mutation permissions.
- [x] Workspace, Project, Work Item, Session, and Org remain separate concepts.
- [x] Dismissed/completed users can reopen the same checklist.
- [x] Personal, work-management, and team goals land on existing product
      surfaces.

## Layer 1 — Compilation correctness

- `npm run typecheck`: passed.
- ESLint over every changed TypeScript/TSX file: passed.
- Focused Vitest suite: 26 tests passed across flow guards, secret-safe
  detection, hidden test reentry, route reentry, Settings reentry, outcome
  migration, and the atomic settings commit boundary.
- Native menu changes are checked through the `system_services` crate; no
  network or persistence wire schema changed.

## Layer 2 — Dead code and structural deduplication

- `useCloudOrgMembershipActions` is called by both onboarding and
  `CreateCollabOrgView`; create/join auth refresh, alias creation, and roster
  convergence no longer have parallel implementations.
- Existing Key validation, external-history rescan, workspace remote resolver,
  appearance settings, Cloud policy clients, sync engine, tutorial registry,
  Chat Panel tab factories, and sidebar scope atoms remain authoritative.
- Legacy presentation-only onboarding steps remain exported for now; removing
  them is a separate cleanup because other imports/tests may still reference
  them. They are no longer in the production `STEP_CONFIGS` execution path.

## Layer 3 — Naming consistency

| Name                       | Meaning                                                  |
| -------------------------- | -------------------------------------------------------- |
| `SetupWalkthroughProgress` | Durable, secret-free decisions and confirmed results     |
| `SetupOperation`           | One foreground mutation/detection command                |
| `selectedOrgId`            | Managed Cloud organization membership selected for setup |
| `repoScopes`               | Normalized Git remote identities, never local paths      |
| `verifiedAt`               | The current team-path postcondition completed            |

The app retains the existing `SetupWalkthrough` route/component name for
compatibility; user-facing copy calls it a setup checklist/readiness flow.

## Layer 4 — Semantic overloading

The implementation does not merge domain objects to simplify the wizard:

| Term         | Product meaning in the flow                    |
| ------------ | ---------------------------------------------- |
| Workspace    | Local folders/files used by an agent           |
| Session      | Agent conversation and execution context       |
| Work Item    | Trackable task with status/assignee/discussion |
| Project      | Planning container for Work Items              |
| Organization | Cloud membership and team policy boundary      |

The dedicated work-model step exposes these distinctions before the user lands
in Work Management.

## Layer 5 — Default branch analysis

- No goal is selected by default; the first transition is guarded.
- Personal and work-management goals omit Cloud steps rather than silently
  pretending team readiness.
- Sharing defaults to `metadata_only`, retaining an explicit privacy boundary.
- A local folder with no Git remote is rejected as a team scope.
- Tool detection failures resolve per provider and do not fail the complete
  scan; the UI still reports “not found” rather than claiming success.
- Future/unknown persisted progress fails schema parsing and resets to the
  version-1 initial state.

## Layer 6 — Cross-domain concept leakage

`useSetupWalkthroughController` is an application-layer orchestrator. It reads
domain state and invokes domain-owned commands; it does not implement
credential parsing, Git remote normalization, Cloud membership, policy RPCs,
sync traversal, appearance persistence, or Chat Panel tab construction.

The only setup-owned persisted data is readiness metadata. No domain credential
or remote session payload is copied into setup state.

## Layer 7 — New developer confusion test

- Step visibility is pure (`getVisibleSetupStepIds`).
- Transition guards are pure (`canCompleteSetupStep`).
- Navigation reachability is pure (`canNavigateToSetupStep`).
- Secret stripping is named and independently tested
  (`sanitizeDetectedTool`).
- Foreground operations have explicit names and one active-operation gate.
- The acceptance matrix lives next to the feature in `TEST_CASES.md`.

## Layer 8 — Wire protocol and serialization

- The detection RPC remains secret-bearing, but `sanitizeDetectedTool`
  constructs a new allow-listed summary synchronously; tests prove API key,
  session token, and environment values do not survive.
- `createCloudInvite` retains the existing plaintext-on-device/hash-on-wire
  contract.
- Repo scopes sent to `cloud_set_org_repo_scopes` come only from
  `resolveShareableScopeKeys`.
- Sharing floor uses the existing typed `CollabSessionAccessMode`.
- Repo scopes and sharing floor are two existing server RPCs, not one
  transaction. The UI reports success only after both finish; if the second
  fails, the step stays incomplete and is safely retryable. No false
  cross-RPC atomicity is claimed.
- No live payload capture was added; existing client schema tests remain the
  wire-format gate.

## Layer 9 — Init parity across entry points

| Entry point                         | Shared path                                     |
| ----------------------------------- | ----------------------------------------------- |
| First Release run                   | Setup route → readiness FSM                     |
| Settings “Setup checklist”          | Same route and persisted FSM                    |
| DOM shortcut fallback               | Atomic setup-only reset → same route and FSM    |
| macOS/Linux native app menu         | `menu-reopen-setup` → same reset and route      |
| Windows custom/native menu          | `menu-reopen-setup` → same reset and route      |
| Existing organization selection     | Same `Org2CloudOrg` roster and namespaced scope |
| Create organization from setup      | Shared membership hook                          |
| Create organization from regular UI | Shared membership hook                          |
| Join via pasted link/code           | Shared membership hook and parser               |

OS deep-link acceptance remains owned by the existing Cloud deep-link handler;
it converges on the same roster atom, which setup reads when reopened.

## Layer 10 — Resolver symmetry

All step decisions resolve in the same order:

1. normalize persisted progress;
2. derive visible steps from goal;
3. normalize current step against the visible set;
4. enforce the current step’s postcondition;
5. persist the next progress snapshot;
6. on completion, atomically persist terminal outcome plus final progress.

Cloud membership similarly resolves auth refresh → mutation → roster
postcondition → local selection. A superseded/expired session cannot commit a
false organization result.

## Verification

- `rustfmt --edition 2021 --check src-tauri/crates/system-services/src/app_menu.rs`: passed.
- `cargo check -p system_services`: passed.

## Architecture verdict

All 10 layers were covered. The implementation removes the disconnected
slide-deck architecture and introduces one small orchestration layer over
existing domain owners. Remaining risks are explicit: Cloud admin policy spans
two server RPCs, sync-engine drain does not provide a server receipt count, and
the live team path depends on the existing cloud/dual-instance E2E suites.
