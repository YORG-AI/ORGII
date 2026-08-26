# PR8 frontend UI consistency audit — Member direct work

The configured `frontend-ui-audit` skill file is unavailable in both the
user-global and workspace locations. This is the required manual equivalent,
using the repository's Line / Element / Verdict / Reason / Suggested change
format across every changed PR8 `*.tsx` surface.

## Findings

| Line                                                                                     | Element                          | Verdict          | Reason                                                                                                                                                                | Suggested change                                                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/engines/ChatPanel/InputArea/components/AgentOrgInterventionPinBar.tsx:55`           | Error/activity/Return status bar | keep with reason | Reuses `ChatStatusSegmentedBar` and `ChatStatusTwoLineContent`, the existing composer status system. It shows state without introducing a competing banner primitive. | Keep; verify error, yielding, active, returned, Idle, Paused and Archived layouts in packaged App. |
| `src/engines/ChatPanel/InputArea/components/AgentOrgInterventionPinBar.tsx:130`          | Stop button                      | keep with reason | Uses the shared `Button` with the existing tertiary/round/mini control vocabulary. Text plus icon makes the destructive scope understandable.                         | Keep; Computer Use must prove it stops only the direct Turn.                                       |
| `src/engines/ChatPanel/InputArea/components/AgentOrgInterventionPinBar.tsx:158`          | Return button                    | keep with reason | Uses the shared secondary button and disables while direct work remains, matching the durable Return precondition instead of relying on optimistic UI.                | Keep; verify all explicit outcome copy and disabled state.                                         |
| `src/engines/ChatPanel/blocks/OrgTaskBadges.tsx:38`                                      | Writer capability badge          | abstract         | Three new surfaces duplicated the same color, casing and tiny-label treatment. A shared component prevents Member switcher, composer and Overview from drifting.      | Implemented `AgentOrgWriterBadge`; all three callers now reuse it.                                 |
| `src/engines/ChatPanel/ChatHistory/components/TurnPaginationControls.tsx:337`            | Empty Member switcher row        | keep with reason | Removing the old disabled state is a product requirement: the empty canonical Member page is the direct-work entry point. Existing dropdown item/focus tokens remain. | Keep; keyboard and narrow-width selection must be exercised in packaged App.                       |
| `src/engines/ChatPanel/ChatView.tsx:571`                                                 | Starting/Failed composer disable | keep with reason | Only the Member direct composer is disabled; Group and ordinary SDE behavior remain separately gated. The status bar explains why.                                    | Keep; verify Starting/Failed and Archived read-only states.                                        |
| `src/engines/ChatPanel/InputArea/components/AgentOrgOverviewPanel.tsx:624`               | Member activity list             | keep with reason | Reuses existing panel typography, semantic tokens and bounded rows. It exposes activity without changing Team status or creating Group feed UI.                       | Keep; verify light/dark, long names and narrow window.                                             |
| `src/engines/ChatPanel/ChatFloatingComposer.tsx:353`                                     | Composer integration             | keep with reason | Passes one typed view model into the existing pinned status slot; it does not add a second overlay, modal or send owner.                                              | Keep.                                                                                              |
| `src/modules/MainApp/Integrations/DevTools/playground/panels/PlaygroundChatPanel.tsx:50` | Playground fixture               | keep with reason | Fixture-only shape update keeps the component playground compilable and does not simulate production authority or user paths.                                         | Keep; never use it as acceptance evidence.                                                         |

## Accessibility and design-system sweep

- All actions are native shared `Button` controls with visible labels and
  disabled/loading states; no click-only `div` was added.
- Member options remain native buttons with `role="menuitem"` and existing
  dropdown focus behavior.
- New colors use semantic ORGII tokens (`primary-6`, `text-*`, `bg-*`); no raw
  hex/RGB color was added.
- The small writer badge is supplementary; capability and authorization remain
  represented in typed wire state and backend enforcement.
- Data attributes are evidence hooks only; production behavior never reads
  them as authority.

## Summary

- Fix: 0 remaining
- Keep with reason: 8
- Abstract: 1, implemented
- Remaining cross-file sweep candidates: 0
- Runtime visual sign-off: passed in the gated packaged App. Computer Use
  covered dark and light themes, a narrow window, empty/current Member
  switching, direct completed/returned activity, Paused direct, yield timeout,
  Idle, Archived read-only and the permanent-Delete confirmation dialog.
- All visible acceptance actions used rendered buttons, text input, keyboard
  and native confirmation UI. No DOM JavaScript, direct Tauri invoke or debug
  helper substituted for send, Stop, Return, Pause, Resume or Archive. The
  first explicitly authorized Delete was completed and exposed residual
  EventStore metadata; a later authorized run exposed Session-owned OrgTrack
  history left behind by the mirror cleanup. Both source bugs are fixed and
  regression-tested. The fresh rebuilt-package revalidation then used the
  rendered Archive button, confirmation UI, permanent-Delete acknowledgement
  checkbox and final Delete button after explicit user authorization; the Team
  disappeared and exact database readback found no Session history residual.
- The final real-user scenario used the rendered Member composer and a live
  Provider to fix a checkout SDK URL-boundary bug, add meaningful tests and
  run them. After restart the rebuilt App showed “Waiting for you to resume
  formal work”; the rendered `Resume work` button then showed the exact
  `cleared_idle` copy, “Direct work ended; there is no formal Task to resume”.
