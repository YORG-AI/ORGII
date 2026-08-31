# Test Cases: SidebarGuideButton

## Happy path

| #   | Steps                                                   | Expected result                                                                                                                                                                            |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Complete first-run preferences.                         | Workstation opens and the **Get started with ORGII** panel opens once.                                                                                                                     |
| 2   | Choose **Start a session**.                             | The panel closes and the existing new-session flow opens.                                                                                                                                  |
| 3   | Choose **Connect or create an organization**.           | The panel closes, Add ORG opens with **Cloud + Create** selected, and the focused organization-name field receives a spotlight.                                                            |
| 4   | Choose **Invite a teammate** with a cloud organization. | The panel closes, the singleton organization tab opens on **Members**, and the create-invite row receives a spotlight; completion remains pending until an invite is successfully created. |
| 5   | Choose **View team usage** with a cloud organization.   | The panel closes, Runtime opens on the organization’s **Members** view, the compact tab control receives a spotlight, and the education milestone persists.                                |
| 6   | Choose the header ellipsis.                             | The panel closes and Quick setup reopens with current preferences.                                                                                                                         |

## Progress and edge cases

| Scenario                                   | Expected result                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| No milestones complete                     | Progress is 0/5 and the session row is labeled **Next step**.                                                                         |
| Some milestones complete out of order      | Count reflects every real fact; **Next step** stays on the first incomplete task.                                                     |
| All milestones complete                    | Progress is 5/5 with no forced next row.                                                                                              |
| Invite selected before organization exists | The create/connect organization flow opens instead.                                                                                   |
| Guided organization form                   | A one-shot runtime intent selects Cloud + Create and is consumed after focusing the organization-name input.                          |
| Signed out during guided organization      | Cloud + Create remains visible with the sign-in hint; Create stays disabled until authentication and a non-empty name.                |
| Organization creation fails                | The form stays open with its existing error/retry behavior, and the guide remains on the organization milestone.                      |
| Organization creation succeeds             | The authoritative cloud roster includes the new organization, then **Invite a teammate** becomes the next step.                       |
| Ordinary Add ORG navigation                | No guide preset leaks into the regular form; organization source remains unselected.                                                  |
| Invite selected by a non-manager           | Members opens, the member list is spotlighted, and localized copy explains that an admin or Owner must create the invite.             |
| Organization tab already open              | The tab is reused and a fresh Members-view request still moves focus to the invite controls.                                          |
| Invite controls mount after navigation     | Spotlight waits for the target for at most 12 seconds, scrolls once, and then releases its observer.                                  |
| Team usage selected before organization    | The create/connect organization flow opens; Runtime navigation and completion remain untouched.                                       |
| Runtime tab already open                   | The singleton tab is reused and a fresh one-shot intent selects the requested organization’s Members view.                            |
| Runtime target mounts after navigation     | Spotlight waits for the compact organization tab control, then scrolls once and releases its observer.                                |
| No member usage data yet                   | Members still opens and its existing empty/disabled state explains the missing prerequisite; the guide does not fabricate usage data. |
| App hidden while waiting                   | Target observation pauses and resumes on visibility without an idle background listener.                                              |
| Dismissed first run                        | The guide does not auto-open, but the persistent help trigger remains available.                                                      |
| Already shown handoff                      | Remounting Workstation does not auto-open the guide again.                                                                            |
| Handoff persistence failure                | The open panel remains usable and the pending state can retry on a later mount.                                                       |
| Long localized labels                      | Rows remain readable in the shared fixed-width dropdown.                                                                              |
| Outside click or Escape                    | Shared dropdown behavior closes the panel without running an action.                                                                  |

## Acceptance criteria

- [x] A persistent guide icon appears before Search in the sidebar top bar.
- [x] Completion uses canonical Session and cloud Organization facts plus three explicit education milestones.
- [x] The invite milestone is written only at the successful invite API boundary.
- [x] The first completed setup arms one auto-open handoff; skipped and legacy-completed users are not forced into it.
- [x] All five actions reuse existing product commands and close the panel first.
- [x] Shared dropdown, tooltip, button, progress, and icon primitives are used.
- [x] All navigation locale files expose the same guide-key shape.
- [x] Invite navigation and spotlight intent remain runtime-only; only a successful invite mutation completes the milestone.
- [x] Organization navigation intent is one-shot and runtime-only; only an organization confirmed by the authoritative cloud roster completes the milestone.
- [x] Team-usage navigation intent is one-shot and runtime-only; without a cloud organization it falls back to organization setup and does not complete.
- [x] The guide panel contains only product guidance.
