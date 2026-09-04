# AssignedWorkItemDetail UI audit

| Line                             | Element                   | Verdict          | Reason                                                                                                                                                                                   | Suggested change |
| -------------------------------- | ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `AssignedWorkItemDetail.tsx:124` | Thread status notice      | keep with reason | The notice must overlay the nested thread without taking its layout space; the custom absolute status strip preserves that behavior and uses semantic theme colors plus `role="status"`. | None.            |
| `AssignedWorkItemDetail.tsx:137` | Work Item conversation    | keep with reason | Reuses the canonical `WorkItemThreadSurface`, including its repository-style activity composition and properties rail.                                                                   | None.            |
| `AssignedWorkItemDetail.tsx:355` | Detail header and actions | keep with reason | Reuses `TeamInboxDetailLayout`, `GitHubIssueHeaderContent`, and the shared header action contract for in-app and browser navigation.                                                     | None.            |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.
