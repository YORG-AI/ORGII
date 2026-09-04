# RecentlyClosedTabsMenuSection UI audit

| Line                                         | Element                     | Verdict          | Reason                                                                                                                                          | Suggested change |
| -------------------------------------------- | --------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `RecentlyClosedTabsMenuSection/index.tsx:29` | Section separator and label | keep with reason | Reuses the shared dropdown separator and section-label tokens, so spacing, borders, typography, and themes stay aligned with existing menus.    | None.            |
| `RecentlyClosedTabsMenuSection/index.tsx:38` | Restore action rows         | keep with reason | This shared menu scaffold owns native menu-item buttons and applies the canonical `menuActionItem` token, preserving keyboard/button semantics. | None.            |
| `RecentlyClosedTabsMenuSection/index.tsx:30` | Labeled menu group          | keep with reason | `role="group"` and `aria-labelledby` expose the non-interactive section heading while each restore row remains an actual button.                | None.            |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.
