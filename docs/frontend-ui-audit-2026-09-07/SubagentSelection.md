# Subagent selection UI audit

| Line                                                       | Element                 | Verdict          | Reason                                                                                                | Suggested change |
| ---------------------------------------------------------- | ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- | ---------------- |
| `src/engines/Simulator/components/SubagentPipCard.tsx:139` | Selected child/page     | keep with reason | Stable session identity preserves the expanded child and page anchor across sibling insertion/removal | None             |
| `src/engines/Simulator/ActivitySimulator.tsx`              | Parent session boundary | keep with reason | React key resets local selection when the parent changes                                              | None             |

Verdict totals: **0 fix**, **2 keep with reason**, **0 abstract**.

React review: roster reconciliation changes only scalar selection and the ordered ID list. Full event arrays remain limited to visible cells. No timers or new caches. Mounted component regression exercises sibling insertion/reorder and parent identity reset. Layout and styles unchanged; screenshots would not demonstrate the state transition. Real-app CPU/RSS was not measured; computer control was not authorized.
