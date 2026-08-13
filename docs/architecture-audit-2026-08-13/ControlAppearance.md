# Control appearance architecture audit

## Acceptance criteria

- Shared field components expose one visual API: `appearance`.
- `ghost` always means transparent idle plus the shared hover/focus/open
  surface; `bare` always means permanently chromeless.
- `variant` remains reserved for semantic importance or structural/domain
  variants.
- No compatibility aliases or paired appearance flags remain on Input,
  Textarea, or Select.
- Composite controls forward the canonical vocabulary without redefining it.

## Layers reviewed

| Layer                        | Verdict        | Evidence                                                                                                                                        |
| ---------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Acceptance criteria       | pass           | Criteria above distinguish visual appearance from semantic and layout variants.                                                                 |
| 2. Type/domain model         | pass           | `controlAppearance.ts` owns the reusable unions; field types extend that vocabulary only where `bare` is valid.                                 |
| 3. Ownership/boundaries      | pass           | Base controls own rendering and state classes; SettingsTable and wrapper controls only forward appearance.                                      |
| 4. API surface               | pass           | Legacy `fieldVariant`, Select `variant`, TabPill `colorScheme`, and paired Input/Textarea flags were removed rather than shimmed.               |
| 5. Control flow/FSM          | not applicable | No lifecycle, async, or state-machine behavior changed.                                                                                         |
| 6. Persistence/wire protocol | not applicable | Appearance values are local React props and are not persisted or serialized.                                                                    |
| 7. Initialization parity     | pass           | Every component defaults to `default`; status-bar buttons default semantically to `tertiary`.                                                   |
| 8. Dead code/duplicate paths | pass           | PillGroup's duplicate ghost/strong-surface path was reduced to the existing `strongSurface` owner.                                              |
| 9. Naming collisions         | pass           | Live UI `ghost` treatment now appears under `appearance`; remaining `fieldVariant` names describe the separate row/pill property layout domain. |
| 10. Resolver symmetry        | not applicable | No multi-source resolvers or fallback chains are involved.                                                                                      |

## Sweep evidence

- TypeScript compilation covers every changed public prop and caller.
- Source-contract tests reject the removed field aliases and composite-control
  naming.
- Repository search found no live `variant="ghost"`, TabPill `colorScheme`,
  `PillGroupVariant`, `SelectorPillVariant`, or settings-select variant API.
- Remaining `ghost` variant strings are confined to literal Tool Preview demo
  source payloads, not executable component contracts.
