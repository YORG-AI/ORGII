# Work Management header controls UI audit

| Line                                                                    | Element                    | Verdict          | Reason                                                                                                                             | Suggested change |
| ----------------------------------------------------------------------- | -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/modules/shared/components/WorkManagementSearchInput.tsx:18`        | Shared search input        | keep with reason | The shared component owns the generic placeholder and the existing design-system `SearchInput`, preventing dataset-specific drift. | None.            |
| `src/modules/shared/components/WorkManagementRefreshButton.tsx:20`      | Shared refresh action      | keep with reason | The design-system `Button`, header icon token, and shared spin hook now define one refresh treatment for Work Management headers.  | None.            |
| `src/modules/MainApp/WorkManagement/GitHubWorkItemList.tsx:30`          | GitHub header action group | keep with reason | The explicit `gap-px` group matches the Work Items action cluster and prevents spacing inherited from adjacent filters.            | None.            |
| `src/modules/MainApp/WorkManagement/WorkManagementDatasetSwitch.tsx:31` | Work dataset selector      | keep with reason | Inbox is represented as another option in the existing design-system `Select`, preserving one navigation format across datasets.   | None.            |

Verdict totals: **0 fix**, **4 keep with reason**, **0 abstract**.
