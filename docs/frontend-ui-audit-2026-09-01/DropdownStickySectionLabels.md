# Dropdown sticky section labels UI audit

| Line                                 | Element                             | Verdict          | Reason                                                                                                      | Suggested change                                                              |
| ------------------------------------ | ----------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Dropdown/tokens.ts:467`             | Shared dropdown section-label token | fix              | Section headings scrolled away with their rows even though every grouped dropdown already shares this token | Add token-backed sticky positioning, stacking, and an opaque panel background |
| `SlashCommandPortal/MenuRows.tsx:47` | Slash-command menu section heading  | keep with reason | Reuses the shared dropdown section-label contract, so it inherits the behavior without a local style fork   | None                                                                          |

Verdict totals: **1 fix**, **1 keep with reason**, **0 abstract**.
