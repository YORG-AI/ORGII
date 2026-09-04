# CommentMentionDetail UI audit

| Line                           | Element                      | Verdict          | Reason                                                                                                                                                                                                                     | Suggested change |
| ------------------------------ | ---------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CommentMentionDetail.tsx:80`  | Mention conversation surface | keep with reason | Reuses the same `TimelineCard`, `TimelineCardHeader`, `TimelineStack`, `PersonAvatar`, Markdown renderer, and `WORK_ITEM_THREAD_TOKENS` content width used by repository issue, pull-request, and Work Item conversations. | None.            |
| `CommentMentionDetail.tsx:98`  | Unread indicator             | keep with reason | This is a non-interactive state dot inside the shared timeline header; it uses a theme color and exposes both a title and accessible label.                                                                                | None.            |
| `CommentMentionDetail.tsx:123` | Optional context excerpt     | keep with reason | A semantic paragraph with a lightweight border accent is appropriate for source-provided prose and has no design-system control equivalent.                                                                                | None.            |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.
