# WorkManagementSearchInput UI audit

| Line                                                             | Element                             | Verdict          | Reason                                                                                                                                                        | Suggested change |
| ---------------------------------------------------------------- | ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/modules/shared/components/WorkManagementSearchInput.tsx:41` | Shared search field                 | keep with reason | Reuses the design-system `SearchInput` and centralizes the treatment consumed by Projects, Work Items, GitHub Work Items, Team Inbox, and Kanban.             | None.            |
| `src/modules/shared/components/WorkManagementSearchInput.tsx:50` | Header width                        | keep with reason | `w-180` resolves through the existing `--spacing-180` token; split-list placements intentionally retain `w-full` so narrow panes remain usable.               | None.            |
| `src/components/SearchInput/searchControlInputStyles.ts:17`      | Ghost idle, hover, and focus states | keep with reason | Uses theme tokens (`transparent`, `fill-2`, `primary-6`, and `pane-input`) and preserves a 1px border in every state so focus and typed content do not shift. | None.            |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.
