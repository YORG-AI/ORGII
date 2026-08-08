# Architecture Audit — Create Composer Scaffold

## Acceptance criteria

- Create Project and Create Work Item share their repeated composer structure.
- Title typography matches the 14px normal-weight editor body in both flows.
- Project creation has no separate brief input.
- Project and Work Item expose the same controlled Manual/Agent mode control.
- Entity-specific draft state, properties, and persistence remain with each
  feature.
- Agent and manual variants preserve the existing Session Creator extension
  points.

## Entry paths

- Project: `ChatPanelEmptyContent` → `CreateProjectView` → shared scaffold.
- Work Item: `ChatPanelEmptyContent` → `CreateWorkItemView` → shared scaffold.
- Manual editor affordances: shared scaffold → `ProjectContentEditorRef`.

## Ten-layer review

| Layer                              | Verdict        | Evidence                                                                                                                                                  |
| ---------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness         | pass           | TypeScript, focused ESLint, focused Vitest, and production Webpack build pass.                                                                            |
| 2. Structural deduplication        | pass           | Title, header/divider, pinned actions, centered launcher, Agent frame, manual shell, file/mention/skills wiring, and mode-toggle presentation are shared. |
| 3. Naming consistency              | pass           | Names describe create-composer roles without Project- or Work Item-specific aliases.                                                                      |
| 4. Semantic overload               | pass           | Existing meanings of Project, Work Item, manual, Agent, editor, and composer are unchanged.                                                               |
| 5. Default branch correctness      | pass           | Centered/non-centered and Project/Work Item mode controls are explicit; no domain state is inferred by a catch-all default.                               |
| 6. Cross-domain leakage            | pass           | The scaffold contains no entity draft, property, API, or persistence knowledge; callers provide content and refs.                                         |
| 7. New-developer confusion         | pass           | Editor affordances derived from the editor ref are owned once, and the unused Project `showFooter`/reset path is removed.                                 |
| 8. Wire/serialization completeness | not applicable | No public payload, event, IPC, or persistence schema changed.                                                                                             |
| 9. Initialization parity           | not applicable | No initialization path or state-machine transition changed.                                                                                               |
| 10. Resolver symmetry              | not applicable | No resolver, fallback, or lookup path changed.                                                                                                            |

## Systematic sweep

The feature roots and Chat Panel host were searched for the former duplicated
header classes, manual file-upload handler, centered launcher markup, and title
input construction. Remaining `composerHeaderContent` occurrences are the
existing Session Creator extension-point API, while Work Item's `showFooter`
remains valid for its separate non-composer fallback.

## Result

The shared boundary is intentionally presentation-only. Project and Work Item
creation still own their data and save semantics, so the simplification does
not create a cross-domain state abstraction.
