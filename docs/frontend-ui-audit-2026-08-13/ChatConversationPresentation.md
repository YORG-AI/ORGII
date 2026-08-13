# Chat conversation presentation audit

The routed `frontend-ui-audit` skill was unavailable at both documented locations, so this report records the equivalent manual review over the changed chat UI surfaces.

| Line                                 | Element                                 | Verdict          | Reason                                                                                                                                               | Suggested change                                                  |
| ------------------------------------ | --------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `UserChatItem.tsx:387`               | Shared-message ownership projection     | keep with reason | Alignment is derived from the copied event namespace rather than UI text or a display-only predicate, preserving local continuations on the right.   | None.                                                             |
| `UserChatItem.tsx:546`               | Remote message row and avatar           | keep with reason | Reuses the shared `Avatar` component, `fill-2` theme token, existing bubble width constraints, and an accessible sender label.                       | None.                                                             |
| `ChatPanelHeader.tsx:285`            | Two-row glass header backdrop           | keep with reason | One pointer-inert, theme-token-backed backdrop spans both header rows without wrapping the tab strip or altering its pinned geometry.                | None.                                                             |
| `ChatHistoryList.tsx:391`            | Static and virtual transcript top inset | keep with reason | Both rendering paths use identical geometry, preserving first-message spacing and preventing pagination-mode drift.                                  | None.                                                             |
| `FocusedChatWorkstationRail.tsx:815` | Workstation trail top inset             | keep with reason | The rail remains below overlaid chrome while the transcript alone scrolls beneath the glass; compact controls remain in their published-header host. | None.                                                             |
| `chatPanelHeaderLayout.ts:1`         | Shared header geometry                  | abstract         | Header, transcript, and rail dimensions were centralized after the audit identified duplicated 84px/108px magic values.                              | Keep future header-height changes routed through these constants. |

## Verdict totals

- Fix: 0
- Keep with reason: 5
- Abstract: 1

No multi-file sweep candidates remain.
