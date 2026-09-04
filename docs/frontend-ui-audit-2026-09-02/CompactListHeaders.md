# Compact list headers UI audit

| Line                        | Element                   | Verdict          | Reason                                                                                                                 | Suggested change |
| --------------------------- | ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CompactListHeader.tsx:13`  | Split-list control header | abstract         | Inbox, GitHub, and Work Items now share one compact control row instead of rebuilding padding and background per page. | None.            |
| `CompactListPanel.tsx:95`   | Compact list container    | keep with reason | The semantic section retains its accessible label without a redundant visible title strip.                             | None.            |
| `CompactListPanel.tsx:100`  | Loading indicator         | keep with reason | Reuses the shared `LoadingBar` directly above list content for PR, Issue, and Work Item panes.                         | None.            |
| `GitHubWorkItemList.tsx:30` | PR/Issue refresh action   | keep with reason | Reuses the shared tertiary icon action, including the standard loading spin and accessible label.                      | None.            |

Verdict totals: **0 fix**, **3 keep with reason**, **1 abstract**.
