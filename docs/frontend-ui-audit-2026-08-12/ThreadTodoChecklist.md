# ThreadTodoChecklist frontend UI audit

| Line | Element                | Verdict          | Reason                                                                                                                                                                | Suggested change                                                                                                                      |
| ---- | ---------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 90   | Empty-state add action | keep with reason | The full-width tertiary ghost row is the only content in the empty state and provides a larger discoverable target without adding a persistent visual layer.          | Keep the shared ghost button and transient hover fill.                                                                                |
| 142  | Delete action          | fix              | The circular danger action did not match the simplified neutral action language requested for inline thread utilities.                                                | Use a square tertiary ghost icon button while retaining the delete accessible label.                                                  |
| 167  | Inline composer        | fix              | A rounded filled wrapper and bordered input added another surface inside the existing thread section card, while the compact row lacked balanced vertical separation. | Remove the wrapper fill and radius, use the input's ghost field variant, and apply equal vertical inset directly in the section body. |
| 190  | Create action          | fix              | The labelled primary button was visually heavier than the compact inline todo workflow.                                                                               | Use a square tertiary ghost icon button with an accessible Add label.                                                                 |
| 200  | Cancel action          | fix              | The circular action shape diverged from the square utility controls used in the simplified composer.                                                                  | Use a square tertiary ghost icon button with an accessible Cancel label.                                                              |
| 61   | Section typography     | fix              | The section heading and ghost input retained stronger weights than the simplified inline controls.                                                                    | Use regular weight for both the section title and composer input.                                                                     |

## Summary

- Fix: 5
- Keep with reason: 1
- Abstract: 0
- Sweep candidates: none; the changes are local to the thread todo section.
