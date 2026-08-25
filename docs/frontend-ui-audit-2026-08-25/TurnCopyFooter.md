# Frontend UI Audit: Turn Copy Footer

## Scope

- `src/components/MessageFooter/index.tsx`
- `src/engines/ChatPanel/blocks/AgentMessageBlock/index.tsx`
- `src/engines/ChatPanel/ChatHistory/renderers/GroupItemRenderer.tsx`

The configured `frontend-ui-audit` skill file is not present at the workspace path documented in `AGENTS.md`. This report applies the repository's stated audit dimensions directly: shared-component usage, design-token consistency, arbitrary Tailwind values, accessibility basics, and visual-pattern duplication.

## Findings

| Line                                                                    | Element               | Verdict          | Reason                                                                                                                                               | Suggested change                                                                      |
| ----------------------------------------------------------------------- | --------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/components/MessageFooter/index.tsx:35`                             | copy action input     | fix              | A static message string bound the round-level action to the surviving rendered item, so collapsed projection silently changed copy semantics.        | Resolve the authoritative turn content lazily from the turn context on click.         |
| `src/components/MessageFooter/index.tsx:49`                             | clipboard write       | fix              | Direct `navigator.clipboard` use had no fallback or user-visible failure state.                                                                      | Reuse the shared clipboard helper and keep the button retryable after an error toast. |
| `src/engines/ChatPanel/blocks/AgentMessageBlock/index.tsx:139`          | accessible copy label | keep with reason | The native icon button keeps its keyboard/focus treatment and now uses the existing localized `Copy turn` label, which describes the action's scope. | None.                                                                                 |
| `src/engines/ChatPanel/ChatHistory/renderers/GroupItemRenderer.tsx:441` | turn action ownership | keep with reason | Copy source ids and the resolver travel through the existing turn context instead of introducing a second DOM lookup or global UI state owner.       | None.                                                                                 |

## Summary

- Fix: 2
- Keep with reason: 2
- Abstract: 0
- Multi-file sweep candidates: 0

No new arbitrary Tailwind values, color literals, duplicate copy controls, or unlabeled interactive elements were introduced.
