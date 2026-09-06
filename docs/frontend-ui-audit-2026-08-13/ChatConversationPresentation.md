# Chat conversation presentation audit

This report records the frontend UI audit over the changed chat presentation surfaces.

| Line                                 | Element                                 | Verdict          | Reason                                                                                                                                                        | Suggested change                                                  |
| ------------------------------------ | --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `UserChatItem.tsx:387`               | Shared-message ownership projection     | keep with reason | Alignment is derived from the copied event namespace rather than UI text or a display-only predicate, preserving local continuations on the right.            | None.                                                             |
| `UserChatItem.tsx:546`               | Remote message row and avatar           | keep with reason | Reuses the shared `Avatar` component, `fill-2` theme token, existing bubble width constraints, and an accessible sender label.                                | None.                                                             |
| `ChatPanelHeader.tsx:471`            | Two-row header surface                  | keep with reason | One pointer-inert, opaque theme-token surface spans both header rows without wrapping the tab strip or altering its pinned geometry.                          | None.                                                             |
| `ChatHistoryList.tsx:391`            | Static and virtual transcript top inset | keep with reason | Both rendering paths use identical geometry, preserving first-message spacing and preventing pagination-mode drift.                                           | None.                                                             |
| `FocusedChatWorkstationRail.tsx:815` | Workstation trail top inset             | keep with reason | The rail remains below overlaid chrome while the transcript alone scrolls beneath the header surface; compact controls remain in their published-header host. | None.                                                             |
| `chatPanelHeaderLayout.ts:1`         | Shared header geometry                  | abstract         | Header, transcript, and rail dimensions were centralized after the audit identified duplicated 84px/108px magic values.                                       | Keep future header-height changes routed through these constants. |

## Verdict totals

- Fix: 0
- Keep with reason: 5
- Abstract: 1

No multi-file sweep candidates remain.
