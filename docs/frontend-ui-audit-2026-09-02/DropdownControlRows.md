# Dropdown control rows UI audit

| Line                                    | Element                     | Verdict | Reason                                                                                                                                                                        | Suggested change                                                                                                    |
| --------------------------------------- | --------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/components/Dropdown/tokens.ts:391` | Shared dropdown control row | fix     | `menuControlItem` added a row-level hover fill around embedded pills, switches, and option controls across 13 call sites, duplicating the interactive control's own feedback. | Completed: remove the hover background from `menuControlItem`; keep hover feedback on `menuActionItem` action rows. |

Verdict totals: **1 fix**, **0 keep with reason**, **0 abstract**.
