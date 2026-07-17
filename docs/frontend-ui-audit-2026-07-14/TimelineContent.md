# Frontend UI Audit: TimelineContent

The configured `frontend-ui-audit` skill was unavailable in both the workspace
and user skill directories. This report follows the repository report columns
and existing sidebar conventions manually.

| Line | Element                                | Verdict          | Reason                                                                                                                                                                                                                      | Suggested change |
| ---: | -------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
|  196 | Participant row button                 | keep with reason | Native button semantics make each main/subagent row keyboard-focusable. Stable attributes expose root, child target, participant kind, actor, source, and precision to rendered tests without coupling tests to copy.       | None.            |
|  172 | Action summary                         | keep with reason | All six canonical resource actions are translated in every shipped locale. Stable read/write count attributes let rendered E2E assert the semantic facts without depending on localized text.                               | None.            |
|  204 | Nested participant spacing             | keep with reason | The participant is indented below its root session while reusing the adjacent sidebar row density and hover token. The border is a single design-system border color, not an arbitrary color.                               | None.            |
|  219 | Attribution and confidence line        | keep with reason | Localized text distinguishes main-session and subagent facts and states precision explicitly across all 13 shipped locales; truncation preserves the compact sidebar layout and the full value remains in the button title. | None.            |
|  262 | Root session group                     | keep with reason | The visual hierarchy mirrors the RPC hierarchy: one root session button followed by nested participants. The root remains independently navigable and uses the same session loader as participant rows.                     | None.            |
|  404 | Backfill state projection              | keep with reason | Active, partial, and failed historical coverage is visible; existing facts remain rendered while polling, so background work does not replace useful content with a spinner.                                                | None.            |
|  408 | Multi-source empty/loading/error logic | keep with reason | Active background indexing counts as renderable state, while Git, Agent Blame, and already indexed Session Blame results retain their independent partial-success behavior.                                                 | None.            |
|  451 | Session Blame section                  | keep with reason | Reuses the translated section label and existing sidebar section hierarchy. Session/subagent rows and progress use semantic test attributes and no new arbitrary Tailwind values.                                           | None.            |

Verdict counts: fix 0; keep with reason 8; abstract 0.
