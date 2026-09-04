# ConversationModePill performance guard

| Area               | Verdict | Evidence                                                                                                                                            | Change or reason kept                                                               | Verification                                                                                                               |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Background work    | keep    | Tooltips own interaction delays and add scroll/resize listeners only while open. No polling, scans, network requests, or workers are added.         | Reuse Tooltip; do not add a second tooltip lifecycle in the conversation component. | Rendered tests observe zero idle timers/listeners and removal of active listeners/timers across three open/unmount cycles. |
| Memory             | keep    | Two option tooltips per mounted switch; the maximize atom subscription has been removed; no new module-level collections or retained session state. | Shared components and Jotai own disposal.                                           | Portals disappear and pending hide timers are cleared on unmount.                                                          |
| Scope/isolation    | keep    | The existing session-specific mode atom owns selection; the switch no longer reads maximize state.                                                  | No new persistence writer, cloud scope, or model/submit route.                      | Clicking Team chat changes only its session; maximize/restore preserves mode and button identity.                          |
| Rendering/hot path | keep    | The maximize subscription is removed; no transcript/streaming state is read. Tooltip-free consumers retain their previous render branch.            | Two bounded option elements; no manual subscription or resize observer.             | Component tests and existing small/default pill tests pass. No runtime CPU/RSS claim is made.                              |

Lifecycle scope:

| State                                        | Expected behavior                                                                                    | Evidence                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Mounted, idle                                | No tooltip timers or layout listeners                                                                | Asserted on three mounts                                                   |
| Hover/open                                   | Bounded delay; only the active tooltip installs layout listeners                                     | Real Tooltip exercised with fake timers; one scroll and one resize handler |
| Select                                       | Shared tooltip closes; session mode changes once                                                     | Both destinations tested                                                   |
| Maximize/restore                             | Keep both glyphs without replacing controls or changing mode                                         | Tested in both directions                                                  |
| Unmount with a pending hide                  | Clear timer, listeners, and portal                                                                   | Asserted over three cycles                                                 |
| Missing session/discussion target            | No switch or tooltip                                                                                 | Both guards tested                                                         |
| Hidden document, real desktop idle, shutdown | No new recurring activity is introduced; real-app CPU/RSS and focus-return behavior are not measured | Source inspection only; desktop control was not requested                  |
| Identity/network/provider transitions        | No changed I/O, provider history, transport, or identity owner                                       | Not applicable to this presentation change                                 |

Verification:

- `pnpm exec vitest run src/features/Org2Cloud/SessionConversation/ConversationModePill.test.ts src/components/SegmentedTextPill/SegmentedTextPill.test.ts src/components/Tooltip/index.test.ts src/components/KeyboardShortcut/index.test.ts` — 23 tests passed.
- Targeted ESLint and test-placement check passed (commands recorded in the UI audit).
- `pnpm run typecheck` — passed in the isolated PR checkout based on the latest `develop`.
- Real desktop visible/hidden CPU/RSS, theme appearance, and screenshot checks were not run because Computer Use was not requested.

Performance verdict: **blocked** for a full-app sign-off only by unmeasured
desktop states. Typecheck and the bounded DOM lifecycle checks pass; this is not
a claim of measured runtime performance improvement.
