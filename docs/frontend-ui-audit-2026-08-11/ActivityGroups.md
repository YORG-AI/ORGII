# Frontend UI Audit — Activity Groups

Scope: `EditActivityGroup`, `TerminalActivityGroup`, and their shared event projection. This is a behavior-preserving component refactor; no rendered styles, copy, layout, focus behavior, or interaction contract changed.

| Line                                                                  | Element                                                                                                              | Verdict          | Reason                                                                                                                                                                                                      | Suggested change                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/engines/ChatPanel/ChatItems/activityGroupProjection.tsx:17`      | Event-item projection, intermediate running-state normalization, lazy registry rendering, and tool-usage aggregation | abstract         | Edit and terminal groups previously duplicated the same presentation pipeline. One shared owner prevents loading-state and usage-badge behavior from drifting while leaving domain summaries separate.      | Reuse the shared projection from both activity-group components.  |
| `src/engines/ChatPanel/ChatItems/EditActivityGroup/index.tsx:111`     | Edit activity stack                                                                                                  | keep with reason | `StackedBlock`, tool icons, workstation diff tokens, and the shared usage badge already implement the design-system contracts. The edit/read and diff-stat summary is specific to edit activity.            | Keep the edit summary local and continue using shared primitives. |
| `src/engines/ChatPanel/ChatItems/TerminalActivityGroup/index.tsx:140` | Terminal activity stack                                                                                              | keep with reason | The stack uses the same shared primitives, while terminal/MCP/wait counts and durable Work Item result cards are terminal-domain behavior. Moving them into the generic projection would leak domain rules. | Keep terminal summary and Work Item projection local.             |
| `src/engines/ChatPanel/ChatItems/EditActivityGroup/index.tsx:119`     | Existing summary typography and spacing                                                                              | keep with reason | The existing classes compose established text and diff-stat tokens; this refactor introduces no arbitrary visual value or parallel component style.                                                         | No visual change.                                                 |

## Summary

- Fix: 0
- Keep with reason: 3
- Abstract: 1
- Sweep candidates: 0
- Accessibility: no semantic or interactive changes; `StackedBlock` retains the existing keyboard/collapse contract.
