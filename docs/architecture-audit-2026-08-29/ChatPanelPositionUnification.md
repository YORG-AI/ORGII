# Chat panel position unification architecture audit

## Acceptance criteria

- One canonical persisted setting controls the chat-panel side in every station layout
- One writable atom owns reads and writes for that setting
- Settings and Spotlight expose one choice rather than station-specific choices
- Existing split settings migrate deterministically without changing the default for new users
- No production reference remains to the old atoms, action IDs, or station-specific labels
- Obsolete station-specific and superseded menu translation keys are removed from every locale

## Ten-layer audit

| Layer                                     | Verdict       | Evidence                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Compilation correctness                | pass          | TypeScript typecheck and focused tests cover the schema, atom, Settings menu, Spotlight definition, and action registration.                                                                                                                                       |
| 2. Dead code and structural deduplication | pass          | Two schema fields, two atoms, four actions, two Spotlight choices, and the station-selection branches were replaced by one source and one action pair. The repository sweep found no old runtime identifier; eight obsolete keys were removed from all 13 locales. |
| 3. Naming consistency                     | pass          | `general.chatPanelPosition` and `chatPanelPositionAtom` describe the setting without tying it to either station. Legacy names occur only in the migration boundary and its tests.                                                                                  |
| 4. Semantic overloading                   | pass          | “Station” now describes the active layout only; it no longer selects a separate meaning for chat-panel position.                                                                                                                                                   |
| 5. Default branch analysis                | pass          | New users retain the left-side default. Migration precedence is explicit: canonical value, valid legacy My Station value, valid legacy Agent Station value, then the schema default.                                                                               |
| 6. Cross-domain leakage                   | pass          | Shared layout consumers import a station-neutral atom; no My Station or Agent Station position concept leaks into shared state.                                                                                                                                    |
| 7. New-developer clarity                  | pass          | One schema key, atom, UI row, and action pair form a direct ownership chain.                                                                                                                                                                                       |
| 8. Wire and serialization                 | pass / scoped | No network or IPC payload changed. The settings JSONC persistence surface changes to one canonical key; old keys are accepted only during validation and removed from normalized runtime state.                                                                    |
| 9. Init parity                            | pass          | Startup hydration and external settings-file changes both call `validateSettings`, so both entry paths apply the same migration and canonical projection.                                                                                                          |
| 10. Resolver symmetry                     | pass          | Both station layouts resolve the same field through the same atom. There is no longer a station-dependent fallback branch.                                                                                                                                         |

## Ownership path

| Entry point             | Canonical write/read                             | My Station consumer                          | Agent Station consumer                         |
| ----------------------- | ------------------------------------------------ | -------------------------------------------- | ---------------------------------------------- |
| Layout settings submenu | `chatPanelPositionAtom`                          | App layout and workstation header affordance | App layout and agent-station header affordance |
| Action system           | `chatPanelPositionAtom`                          | Same shared projection                       | Same shared projection                         |
| Spotlight               | Shared left/right action IDs                     | Same shared projection                       | Same shared projection                         |
| Settings hydration      | `validateSettings` → `general.chatPanelPosition` | Same shared projection                       | Same shared projection                         |

## Migration invariant

`src/config/settingsSchema/index.ts:55` is the only compatibility boundary. A valid canonical value always wins. If it is absent, the prior My Station value wins when valid because it was the primary workstation preference; a valid prior Agent Station value is the fallback. The normalized settings object drops both legacy keys, and startup backfills the canonical key to disk.
