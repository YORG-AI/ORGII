# WorkManagementSearchInput UI audit

| Line                                                             | Element                             | Verdict          | Reason                                                                                                                                                        | Suggested change |
| ---------------------------------------------------------------- | ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/modules/shared/components/WorkManagementSearchInput.tsx:41` | Shared search field                 | keep with reason | Reuses the design-system `SearchInput` and centralizes the treatment consumed by Projects, Work Items, GitHub Work Items, Team Inbox, and Kanban.             | None.            |
| `src/modules/shared/components/WorkManagementSearchInput.tsx:50` | Search width                        | keep with reason | Regular headers use the existing `w-180` token; left split-list/title rows intentionally use `w-full` so the search fills the available row width.            | None.            |
| `src/components/SearchInput/searchControlInputStyles.ts:17`      | Ghost idle, hover, and focus states | keep with reason | Uses theme tokens (`transparent`, `fill-2`, `primary-6`, and `pane-input`) and preserves a 1px border in every state so focus and typed content do not shift. | None.            |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.
