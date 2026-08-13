# Architecture Audit — Creator Page Layout Unification

**Scope:** Session, Work Item, and Project creator page geometry in the Chat Panel
**Date:** 2026-08-08

## Acceptance criteria

- Session, Work Item, and Project share the same three-region contract: prompt text, centered Codex-style suggestion cards, and a bottom-docked input.
- Agent modes render the selected agent inline in the prompt; Manual modes render the regular-weight generic prompt.
- Skills, settings, and creation properties render immediately above the corresponding input.
- No `centerLauncherContent`, `CreateComposerAgentFrame`, centered-content data-test prop, or setup-action placement override remains.
- The shared layout API names the actual semantic choice (`fill` or `bottom`) and requires callers to choose it explicitly.
- Focused layout tests, TypeScript compilation, and changed-file lint complete without errors or warnings.

## Entry-point trace

| User path        | Entry point          | Shared page shell                         | Content path                                             |
| ---------------- | -------------------- | ----------------------------------------- | -------------------------------------------------------- |
| Agent Session    | `ChatPanelStartPage` | `CreatorContentLayout placement="fill"`   | Agent prompt + centered cards + `SessionCreator` input   |
| Agent Work Item  | `CreateWorkItemView` | `CreatorContentLayout placement="fill"`   | Agent prompt + centered cards + Work Item Agent input    |
| Manual Work Item | `CreateWorkItemView` | `CreatorContentLayout placement="bottom"` | Manual prompt/cards middle slot + `ManualCreateComposer` |
| Agent Project    | `CreateProjectView`  | `CreatorContentLayout placement="fill"`   | Agent prompt + centered cards + Project Agent input      |
| Manual Project   | `CreateProjectView`  | `CreatorContentLayout placement="bottom"` | Manual prompt/cards middle slot + `ManualCreateComposer` |

## Ten-layer review

| Layer                          | Coverage                                                      | Verdict                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation                 | TypeScript surface and React props                            | Passed `npm run typecheck`.                                                                                                                                                     |
| 2. Dead code and deduplication | Creator wrappers, placement flags, render callback parameters | Deleted `CreateComposerAgentFrame`, `centerLauncherContent`, `centeredDataTestId`, the setup-action placement override, and the now-unused Work Item launcher boolean argument. |
| 3. Naming                      | Shared layout API and test IDs                                | Replaced ambiguous “centered launcher” naming with required `placement` values (`fill` / `bottom`) and content-oriented test IDs.                                               |
| 4. Semantic overloading        | `centered`, `launchpad`, `placement`                          | `launchpad` now describes SessionCreator presentation; `placement` exclusively describes page geometry. The overloaded `centered` creator flag is gone.                         |
| 5. Defaults                    | Placement and setup-action branching                          | Placement has no hidden default. Launchpad alone determines above-composer setup actions; default SessionCreator layout retains below-composer actions.                         |
| 6. Cross-domain leakage        | Shared page/layout modules                                    | The shared shell knows only fill vs bottom and an optional middle slot. Work Item and Project domain content remains in their owning modules.                                   |
| 7. New-developer clarity       | View call sites and shared primitives                         | Each view selects one explicit geometry and passes domain content into one shared composer scaffold. No wrapper must infer whether “centered” means fill or middle.             |
| 8. Wire protocol               | Serialization/network payloads                                | Not applicable; no payload, schema, API, or persistence code changed.                                                                                                           |
| 9. Init parity                 | Runtime/session initialization                                | Not applicable; no initialization path changed. All five UI entry paths were traced in the matrix above.                                                                        |
| 10. Resolver symmetry          | Multi-source resolution                                       | Not applicable; no resolver or fallback chain changed.                                                                                                                          |

## Systematic sweeps

- `rg "centerLauncherContent|CreateComposerAgentFrame|centeredDataTestId|setupActionsPlacement|showSetupActionsAboveComposer" src` → zero remaining hits.
- `rg "CreatorContentLayout" src --glob '*.tsx' --glob '*.ts'` → only the shared definition/barrel, three production consumers, and focused tests remain.
- `npm run check:unused-exports | rg "Creator(ContentLayout|Page|Composer)|SessionCreatorAgentHero|ChatPanelStartPage|CreateWorkItemView|CreateProjectView|SelectorPill"` → zero target-scope hits. The unfiltered repository command reports a large pre-existing baseline outside this change.
- Changed-file ESLint is required to finish with zero warnings so unused layout parameters cannot survive the cleanup.

## Result

The creator surfaces now have one prompt / suggestion-cards / bottom-input contract and one manual composer scaffold. No wire, persistence, background-work, or runtime lifecycle behavior is affected.
