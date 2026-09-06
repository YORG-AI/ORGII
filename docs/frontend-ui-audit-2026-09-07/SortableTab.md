# SortableTab UI audit

| Line                                                                         | Element                 | Verdict          | Reason                                                                                            | Suggested change |
| ---------------------------------------------------------------------------- | ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------- | ---------------- |
| `src/modules/WorkStation/shared/TabBar/components/SortableTab/index.tsx:127` | Interactive tab surface | keep with reason | Retains TabPillSurface, sortable keyboard attributes, selection semantics, and existing tooltips. | None.            |
| `src/modules/WorkStation/shared/TabBar/components/SortableTab/index.tsx:154` | Visible content         | keep with reason | Delegates presentation only; close controls and drag ownership stay with the regular tab.         | None.            |

Verdict totals: **0 fix**, **2 keep with reason**, **0 abstract**.
