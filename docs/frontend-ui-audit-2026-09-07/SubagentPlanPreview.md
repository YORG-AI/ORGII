# Subagent plan preview UI audit

| Line                                                                             | Element                | Verdict          | Reason                                                                                        | Suggested change                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------- | ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/engines/Simulator/components/GridCell/IndependentGridCell.tsx:198`          | Cell expand control    | fix              | Mouse-only visibility prevented keyboard discovery                                            | Applied: persistent design-system Button with accessible name                                     |
| `src/engines/Simulator/components/GridCell/SubagentPinnedPreviewPopover.tsx:128` | Plan trigger and panel | fix              | Hover-only tooltip blocked scrolling and had no keyboard entry                                | Applied: progress Button, shared dropdown engine, focusable scroll area, Escape with focus return |
| `src/engines/Simulator/components/GridCell/SubagentPinnedPreviewPopover.tsx:169` | Portal panel           | keep with reason | Existing dropdown engine owns placement, viewport fit, outside click, and open-only listeners | None                                                                                              |
| `src/engines/Simulator/components/GridCell/SubagentPinnedPreviewPopover.tsx:92`  | Todo subscription      | keep with reason | Derived atom selects only this session's stable todo array; list mounts only while opened     | None                                                                                              |

Verdict totals: **2 fix**, **2 keep with reason**, **0 abstract**.

| Area               | Verdict | Evidence                                                   | Change or reason kept                                 | Verification                   |
| ------------------ | ------- | ---------------------------------------------------------- | ----------------------------------------------------- | ------------------------------ |
| Background work    | keep    | Shared dropdown engine                                     | Listeners end at close/unmount                        | Mounted interaction regression |
| Memory             | fix     | Hidden plan has no list DOM; finished plan unmounts engine | On-demand list and no extra cache                     | 50-row mount/unmount test      |
| Scope/isolation    | fix     | Session-selected todo atom                                 | Unrelated todo updates retain selected array identity | Source review                  |
| Rendering/hot path | fix     | Removed mouse-hover state and callbacks from cell header   | Always-discoverable actions                           | Typecheck and targeted test    |

Performance verdict: blocked for real-app CPU/RSS and visual viewport checks because computer control is not authorized. Automated DOM assertions cover list lifetime, keyboard dismissal, focus return, and scrolling semantics. No measured runtime savings claimed.
