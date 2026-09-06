# CliConfigSwitchCard UI audit

| Line                          | Element      | Verdict          | Reason                                                                                                      | Suggested change |
| ----------------------------- | ------------ | ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
| `CliConfigSwitchCard.tsx:302` | Apply gating | keep with reason | Existing shared controls are retained for other harnesses; the predicate now permits explicit proxy startup | None             |

Verdict totals: **0 fix**, **1 keep with reason**, **0 abstract**.

Dimensions D1–D5 inspected in the changed surface. No arbitrary colors, fixed pixel sizes, click-only controls, or new pattern repeated three times were found. Desktop visual verification was not performed because computer control was not authorized; this source audit is not screenshot evidence.
