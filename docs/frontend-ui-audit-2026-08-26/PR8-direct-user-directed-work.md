# PR8 frontend UI consistency audit — Member direct work

The configured `frontend-ui-audit` skill file is unavailable in both the
user-global and workspace locations. This is the required manual equivalent,
using the repository's Line / Element / Verdict / Reason / Suggested change
format across every changed PR8 `*.tsx` surface.

## Findings

| Line                                                                                     | Element                          | Verdict          | Reason                                                                                                                                                                                         | Suggested change                                                                         |
| ---------------------------------------------------------------------------------------- | -------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/engines/ChatPanel/InputArea/components/AgentOrgInterventionPinBar.tsx:55`           | Error/activity/Return status bar | keep with reason | Reuses `ChatStatusSegmentedBar` and `ChatStatusTwoLineContent`, the existing composer status system. Cleared receipts disappear instead of being rendered as current history.                  | Keep; verify error, yielding, active, Idle, Paused and Archived layouts in packaged App. |
| `src/engines/ChatPanel/InputArea/components/AgentOrgInterventionPinBar.tsx:130`          | Stop button                      | keep with reason | Uses the shared `Button` with the existing tertiary/round/mini control vocabulary. Text plus icon makes the destructive scope understandable.                                                  | Keep; Computer Use must prove it stops only the direct Turn.                             |
| `src/engines/ChatPanel/InputArea/components/AgentOrgInterventionPinBar.tsx:158`          | End/Return button                | keep with reason | Uses one shared secondary button and one receipt transition. The label distinguishes a true formal handoff from a standalone direct chain without inventing a second lifecycle.                | Keep; verify the exact label matrix and disabled state.                                  |
| `src/engines/ChatPanel/InputArea/components/AgentOrgInterventionPinBar.tsx:178`          | One-shot result Toast            | keep with reason | Reuses the existing `Message.success` owner and its standard placement. Exact applied outcome drives the copy; the current receipt/revision key prevents a duplicate in the mounted component. | Keep; explicit four-second duration and no durable-history replay.                       |
| `src/engines/ChatPanel/blocks/OrgTaskBadges.tsx:38`                                      | Writer capability badge          | abstract         | Three new surfaces duplicated the same color, casing and tiny-label treatment. A shared component prevents Member switcher, composer and Overview from drifting.                               | Implemented `AgentOrgWriterBadge`; all three callers now reuse it.                       |
| `src/engines/ChatPanel/ChatHistory/components/TurnPaginationControls.tsx:337`            | Empty Member switcher row        | keep with reason | Removing the old disabled state is a product requirement: the empty canonical Member page is the direct-work entry point. Existing dropdown item/focus tokens remain.                          | Keep; keyboard and narrow-width selection must be exercised in packaged App.             |
| `src/engines/ChatPanel/ChatView.tsx:571`                                                 | Starting/Failed composer disable | keep with reason | Only the Member direct composer is disabled; Group and ordinary SDE behavior remain separately gated. The status bar explains why.                                                             | Keep; verify Starting/Failed and Archived read-only states.                              |
| `src/engines/ChatPanel/InputArea/components/AgentOrgOverviewPanel.tsx:624`               | Member activity list             | keep with reason | Reuses existing panel typography, semantic tokens and bounded rows. It exposes activity without changing Team status or creating Group feed UI.                                                | Keep; verify light/dark, long names and narrow window.                                   |
| `src/engines/ChatPanel/ChatFloatingComposer.tsx:353`                                     | Composer integration             | keep with reason | Passes one typed view model into the existing pinned status slot; it does not add a second overlay, modal or send owner.                                                                       | Keep.                                                                                    |
| `src/modules/MainApp/Integrations/DevTools/playground/panels/PlaygroundChatPanel.tsx:50` | Playground fixture               | keep with reason | Fixture-only shape update keeps the component playground compilable and does not simulate production authority or user paths.                                                                  | Keep; never use it as acceptance evidence.                                               |

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
- Keep with reason: 9
- Abstract: 1, implemented
- Remaining cross-file sweep candidates: 0
- Runtime visual sign-off: passed in the gated packaged App. Computer Use
  covered dark and light themes, a narrow window, empty/current Member
  switching, direct activity, Paused direct, yield timeout, Idle, Archived
  read-only and the permanent-Delete confirmation dialog. Cleared receipts no
  longer leave a returned row on either Member status or Overview.
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
- A final idle Planner scenario used the rendered Member composer and a live
  Provider to inspect a real Texas Hold'em pot-odds failure, run the project
  tests and produce a concrete plan. The rendered End action showed one
  accurate four-second Idle result Toast; Session switching and App restart
  did not replay it.
- A final busy Implementer scenario used the rendered Member composer and a
  live Provider to update a real fixture README and run all tests while a
  formal Task was bound. The active bar correctly remained a formal
  intervention after its queue reached zero. The rendered Return action
  immediately showed one `The original Task resumed` Toast and then removed
  the activity; database evidence records one continuation only.
