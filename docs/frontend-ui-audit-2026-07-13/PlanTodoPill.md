# Frontend UI Audit — Plan Todo Pill

Scope: moving active-session todo progress from chat-history group chrome into a compact composer pill with a click-revealed checklist.

The repository-referenced `frontend-ui-audit` skill is not installed in either documented location. This report follows the required table convention and manually checks design-system usage, arbitrary Tailwind values, accessibility, responsive behavior, and duplicated visual patterns.

| Line                               | Element                       | Verdict          | Reason                                                                                                                                                                                          | Suggested change |
| ---------------------------------- | ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `PlanTodoPill.tsx:70`              | Session-scoped todo selection | keep with reason | Reads the per-session todo map using the composer session id, preventing a secondary composer or embedded surface from showing another session's checklist.                                     | None.            |
| `PlanTodoPill.tsx:117`             | Compact progress trigger      | keep with reason | Reuses the shared small rounded `Button` with a standard todo icon, tabular completed/total count, tooltip, `aria-expanded`, and `aria-controls`; no parallel button primitive is introduced.   | None.            |
| `PlanTodoPill.tsx:134`             | Checklist disclosure          | keep with reason | Reuses the shared dropdown engine, portal, panel tokens, top placement, outside-click handling, and Escape handling so the composer overflow cannot clip the checklist.                         | None.            |
| `PlanTodoPill.tsx:142`             | Viewport-constrained panel    | keep with reason | The `min()` width and height constraints are intentionally viewport-relative because the composer supports narrow side panels; semantic surface and border tokens still own the visual styling. | None.            |
| `InputAreaChrome.tsx:41`           | Composer-row placement        | keep with reason | Inserts the todo pill into the existing leading-content slot so it follows the same horizontal overflow and spacing behavior as the other composer pills.                                       | None.            |
| `GroupHeaderRenderer.tsx:220`      | History todo-bar removal      | keep with reason | Todo state no longer changes message-group structure or editing wrappers; turn collapse behavior and user-message rendering remain independent.                                                 | None.            |
| `SubagentPinnedPreviewPopover.tsx` | Separate compact status icons | keep with reason | The subagent title preview remains session-scoped and denser than the interactive composer checklist; retaining its smaller status glyphs avoids changing the simulator cell layout.            | None.            |
| `ChatPinnedBars.tsx`               | Obsolete history todo wrapper | fix              | The composer pill replaces this wrapper and no callers remain; retaining it would preserve a second, conflicting todo presentation path.                                                        | Removed.         |
| `ComposerStackHeader.tsx`          | Unused `strong` variant       | fix              | The deleted history todo bar was the only consumer, so the extra variant and color branch became unreachable.                                                                                   | Removed.         |

## Summary

- fix: 2
- keep with reason: 7
- abstract: 0
- sweep candidates: none
