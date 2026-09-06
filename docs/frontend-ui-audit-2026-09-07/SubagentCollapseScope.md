# Subagent collapse scope UI audit

| Line                                                                   | Element         | Verdict          | Reason                                                                                                                         | Suggested change |
| ---------------------------------------------------------------------- | --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `src/engines/Simulator/components/GridCell/SubagentChatPane.tsx:219`   | Collapse button | keep with reason | Existing design-system Button retains its translated title and accessible label; its command now belongs to this child session | None             |
| `src/engines/ChatPanel/InputArea/components/TurnCollapsePinBar.tsx:66` | Turn control    | keep with reason | Context changes state ownership without changing chrome or keyboard behavior                                                   | None             |

Verdict totals: **0 fix**, **2 keep with reason**, **0 abstract**.

Architecture: reviewed state ownership, consumers, initialization parity, identity, and cleanup (layers 1–5 and 8–10); skipped wire protocol and backend layers because neither changes. Existing parent consumers receive the original default atoms.

| Area               | Verdict | Evidence                                                                    | Change or reason kept                                                                 | Verification                                          |
| ------------------ | ------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Background work    | keep    | No new timer or subscription                                                | Jotai owns mounted subscriptions                                                      | Mounted hook regression                               |
| Memory             | fix     | Session scope registry capped at 200; both override maps capped at 200 each | Only atoms and scalar overrides retained; least recently used dormant state may reset | Source review                                         |
| Scope/isolation    | fix     | Child context provider                                                      | Parent and siblings use different commands/maps                                       | Mounted real block hooks and turn override assertions |
| Rendering/hot path | keep    | Existing Jotai subscriptions                                                | Only scope changes                                                                    | Targeted test                                         |

Performance verdict: blocked for real-app CPU/RSS and repeated-open measurements: computer control was not authorized. Structural scope isolation is covered by automated tests; no numerical runtime savings claimed. No visual changes requiring screenshots.
