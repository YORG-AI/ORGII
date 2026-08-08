# Frontend UI Audit — Team Inbox Sections

**Scope:** `TeamInboxList.tsx`, `TeamInboxListItem.tsx`

**Method note:** the repository-referenced `frontend-ui-audit` skill file was unavailable, so this report applies the documented audit format manually against the existing Navigation Sidebar Session section and shared List Panel primitives.

| Line                       | Element                          | Verdict          | Reason                                                                                                                                                                                                                          | Suggested change                                                                           |
| -------------------------- | -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `TeamInboxList.tsx:100`    | `TeamInboxListSection`           | keep with reason | Reuses the shared `CollapsibleSection` behavior while following the Navigation Sidebar Session hierarchy with a denser 10px uppercase label, 28px header, `text-text-2`, hover/focus disclosure, and 8px inter-section spacing. | None.                                                                                      |
| `TeamInboxList.tsx:341`    | `inboxRows`                      | fix              | Nested recency headings duplicated hierarchy inside the already named `Other todos` section and introduced substantially larger gaps than sidebar Sessions.                                                                     | Render the existing ordered Work Item/mention array as one flat `sectionGroupItems` stack. |
| `TeamInboxListItem.tsx:49` | unified PR / Work Item row shell | keep with reason | Both content types continue to share selection, hover, title, metadata, preview, and truncation behavior; only semantic leading content varies.                                                                                 | None.                                                                                      |
| `TeamInboxListItem.tsx:82` | compact timestamp                | fix              | `text-text-2` competed with row metadata and gave timestamps too much prominence.                                                                                                                                               | Use `text-text-3` while keeping metadata at `text-text-2`.                                 |

## Summary

- Fix: 2
- Keep with reason: 2
- Abstract: 0
