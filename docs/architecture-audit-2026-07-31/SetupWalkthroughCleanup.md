# Architecture Audit — Setup Walkthrough Cleanup

**Scope:** readiness onboarding entry points, step registry, WizardSystem
navigation boundary, and legacy setup export chain

**Date:** 2026-07-31

**Auditor:** Codex

## Acceptance criteria

- Production setup imports only the active readiness-flow step implementation.
- Current onboarding behavior and persisted flow state remain unchanged.
- Active/completed/locked navigation state has one shared presentation owner.
- No removed legacy symbol remains reachable through a direct or barrel import.
- TypeScript, focused behavior tests, ESLint, and systematic reference sweeps
  pass.

## Entry point and ownership trace

`SetupWalkthrough/index.tsx` is the production setup surface. Its visible steps
come from `STEP_CONFIGS` in `flow.ts`; every configured renderer is implemented
by `steps/ReadinessSteps.tsx`. The controller remains the authoritative owner of
current step, completed step ids, navigation guards, persistence, and terminal
outcome. `WizardStepNavigation` receives a projection of that state and owns
presentation only.

The deleted files were reachable only from the obsolete `steps/index.ts` and
`components/index.ts` re-export chains. Neither barrel was imported by the
production flow after the active `SetupOperationError` import was changed to
its concrete readiness module.

## Deleted legacy chain

| Symbol/file                           | Producing path                                         | Verdict                            |
| ------------------------------------- | ------------------------------------------------------ | ---------------------------------- |
| `AnimatedTitle`, `AnimatedTitleProps` | `components/AnimatedTitle.tsx` → `components/index.ts` | Delete; no active caller           |
| `CompleteStep`                        | `steps/CompleteStep.tsx` → `steps/index.ts`            | Delete; absent from `STEP_CONFIGS` |
| `DevPassportStep`                     | `steps/DevPassportStep.tsx` → `steps/index.ts`         | Delete; absent from `STEP_CONFIGS` |
| `GitHubStep`                          | `steps/GitHubStep.tsx` → `steps/index.ts`              | Delete; absent from `STEP_CONFIGS` |
| `RepoStep`                            | `steps/RepoStep.tsx` → `steps/index.ts`                | Delete; absent from `STEP_CONFIGS` |
| `ThemeSelectionStep`                  | `steps/ThemeSelectionStep.tsx` → `steps/index.ts`      | Delete; absent from `STEP_CONFIGS` |
| `WelcomeStep`                         | `steps/WelcomeStep.tsx` → `steps/index.ts`             | Delete; absent from `STEP_CONFIGS` |
| `AGENT_CODE_NAMES`                    | `constants.ts`                                         | Delete; no active caller           |

## Layer review

| Layer                            | Coverage | Result                                                                                      |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| 1. Compilation and imports       | Covered  | Direct readiness import resolves; removed barrels have no consumers.                        |
| 2. Structure and dead code       | Covered  | Obsolete step/component chains deleted; shared navigation removes duplicated structure.     |
| 3. Types and naming              | Covered  | Removed orphan `AnimatedTitleProps`; generic navigation item/props preserve step-id typing. |
| 4. Domain ownership              | Covered  | Controller/flow retain setup state and guards; the primitive owns no domain state.          |
| 5. State transitions             | Covered  | Existing `goToStep` and `canNavigateToSetupStep` paths are reused without new transitions.  |
| 6. Persistence                   | Covered  | No schema or writer changed; setup progress writes remain in the controller/settings path.  |
| 7. Error/async boundaries        | Covered  | Busy state disables navigation; async selection remains delegated to the owner.             |
| 8. Wire protocol                 | Skipped  | No RPC, serialization, or protocol change.                                                  |
| 9. Initialization parity         | Skipped  | No new initialization path or default.                                                      |
| 10. Resolver/runtime integration | Skipped  | No resolver, worker, or backend integration change.                                         |

## Systematic sweeps

- Removed-symbol search covers all of `src` and returns no references.
- Production imports of `SetupWalkthrough/steps` and
  `SetupWalkthrough/components` barrels return no references.
- Raw interactive elements under `src/modules/SetupWalkthrough` return no
  matches; native interaction now lives at the shared component boundary.
- Arbitrary `text-[Npx]` classes in SetupWalkthrough and edited WizardSystem
  primitives return no matches.

## Verification and remaining risk

Focused static-render tests cover navigation current/completed/locked/busy
states and the shared semantic description primitive. Existing flow and i18n
tests cover the unchanged state machine and localized content. TypeScript and
ESLint cover import/export integrity.

Remaining risk is limited to visual density at uncommon viewport/font-scale
combinations; no data, persistence, protocol, or backend risk was introduced.
