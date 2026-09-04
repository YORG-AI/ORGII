# TeamInboxList UI audit

| Line                    | Element               | Verdict          | Reason                                                                                                    | Suggested change |
| ----------------------- | --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- | ---------------- |
| `TeamInboxList.tsx:436` | Inbox control row     | keep with reason | Uses the existing chat-pane token and standard spacing utilities for the shared filter/search/action row. | None.            |
| `TeamInboxList.tsx:451` | Inbox filter controls | keep with reason | Reuses the design-system `Button` primitive with pressed state and accessible labels.                     | None.            |
| `TeamInboxList.tsx:478` | Inbox search          | keep with reason | Reuses the sidebar variant of the shared `SearchInput` component.                                         | None.            |
| `TeamInboxList.tsx:488` | Mark-all-read action  | keep with reason | Reuses the compact tertiary design-system button and preserves its accessible name.                       | None.            |
| `TeamInboxList.tsx:509` | Refresh action        | keep with reason | Reuses the compact tertiary design-system button and remains disabled while the list is refreshing.       | None.            |

Verdict totals: **0 fix**, **5 keep with reason**, **0 abstract**.
