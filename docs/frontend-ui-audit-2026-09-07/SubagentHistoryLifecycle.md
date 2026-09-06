# Subagent history lifecycle UI audit

| Line                                                                 | Element             | Verdict          | Reason                                                                | Suggested change                                                |
| -------------------------------------------------------------------- | ------------------- | ---------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/engines/Simulator/components/GridCell/SubagentChatPane.tsx:150` | Empty history state | fix              | Loading and failures previously looked like an idle child             | Applied: distinct loading status and design-system retry Button |
| `src/engines/Simulator/components/GridCell/SubagentChatPane.tsx:180` | History retry       | keep with reason | Keeps existing content during retry and exposes the owning load state | None                                                            |
| `src/engines/Simulator/components/GridCell/IndependentGridCell.tsx`  | Cell chrome         | keep with reason | Passes load state without changing layout or unrelated controls       | None                                                            |

Verdict totals: **1 fix**, **2 keep with reason**, **0 abstract**.

| Area               | Verdict | Evidence                                                            | Change or reason kept                                                            | Verification                         |
| ------------------ | ------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| Background work    | fix     | Effect owns subscription and request generation                     | Hidden views unsubscribe; explicit retry coalesces in-flight work                | Mounted hidden/retry test            |
| Memory             | fix     | Event map pruned to current roster; existing 360-event cap retained | Old completions stop before fetching a snapshot                                  | Mounted parent-switch test           |
| Scope/isolation    | fix     | Every continuation checks disposed owner                            | Previous parent cannot repopulate local state                                    | Deferred cache completion regression |
| Rendering/hot path | fix     | Load status identity changes only with status                       | Stable unchanged status props; streamed updates buffered during initial baseline | Source review and tests              |

Architecture review: ownership, async state machine, initialization parity, and cleanup; no wire or persistence changes. This change retains existing full-history loading semantics. Cursor-centered disk paging is a separate change.

Performance verdict: blocked for real-app CPU/RSS and visual verification because computer control is not authorized. Automated tests cover owning hook lifecycle and rendered loading/error/empty actions. No numerical performance claim.
