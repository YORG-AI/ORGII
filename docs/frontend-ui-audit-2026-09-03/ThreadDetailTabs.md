# ThreadDetailTabs UI audit

Scope: the Conversation / Related items detail-tab labels and glyphs in
`src/modules/shared/components/ThreadDetailTabs.tsx`.

| Line                         | Element                           | Verdict          | Reason                                                                                                                                                                                            | Suggested change                                          |
| ---------------------------- | --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `ThreadDetailTabs.tsx:40-82` | Detail tab shell                  | keep with reason | Reuses the shared `DetailTabStrip`, which already owns accessible tab semantics, count loading states, and the selected-tab treatment across detail surfaces.                                     | None.                                                     |
| `ThreadDetailTabs.tsx:64-71` | Related-items tab label and glyph | fix (applied)    | `LinkSquare02Icon` communicates opening a new surface, not an item relationship, and the untranslated `Linked` label was vague for GitHub issues and pull requests mentioned in the conversation. | Use `Link02Icon` and the localized `Related items` label. |

Verdict totals: **1 fix (applied)**, **1 keep with reason**, **0 abstract**.
