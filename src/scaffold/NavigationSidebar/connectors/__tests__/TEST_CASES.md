# Test Cases: SidebarGuideButton

## Preconditions

- The Workstation sidebar is visible.
- The application has completed first-run preferences.
- Existing session, organization, work-management, and tutorial commands are registered.

## Happy Path

| #   | Steps                                                      | Expected Result                                                                                            |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Click the guide icon beside Search in the sidebar top bar. | A compact, anchored **Continue setup** panel opens with real progress, task rows, and the active identity. |
| 2   | Choose **Start a session**.                                | The menu closes and the existing new-session flow opens once.                                              |
| 3   | Reopen the guide and choose **Set up a team**.             | The menu closes and the existing create/join organization surface opens once.                              |
| 4   | Reopen the guide and choose **Manage work**.               | The menu closes and the existing Kanban/work-management tab opens once.                                    |
| 5   | Reopen the guide and choose **Open tutorials**.            | The menu closes and the existing tutorial picker opens once.                                               |
| 6   | Reopen the guide and choose the header ellipsis.           | The panel closes and the existing language/appearance quick setup opens once.                              |

## Edge Cases

| #   | Scenario                   | Steps                                                             | Expected Result                                                                            |
| --- | -------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Rapid repeated interaction | Double-click the guide trigger, then click it once more.          | The menu resolves to a single open/closed state; no duplicate portal or action is created. |
| 2   | Outside click              | Open the guide and click another app surface.                     | The guide closes without triggering an action.                                             |
| 3   | Route change               | Open the guide, select an action, then return to the sidebar.     | The guide is closed and can be opened again normally.                                      |
| 4   | Narrow sidebar             | Collapse and expand the sidebar, then open the guide.             | The trigger remains aligned with Search and the panel stays inside the viewport.           |
| 5   | Long localized labels      | Switch to a locale with longer labels and open the guide.         | Rows remain readable and the panel does not overlap or resize the sidebar chrome.          |
| 6   | No milestones completed    | Use a fresh profile with no sessions, organizations, or projects. | Progress shows 0/3 and the first session row is highlighted as the next action.            |
| 7   | All milestones completed   | Use a profile with sessions, an organization, and a project.      | Progress shows 3/3; all tracked rows show completion and no row is forced as next.         |

## Error / Degraded States

| #   | Scenario                    | Steps                                                              | Expected Result                                                                            |
| --- | --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | Destination has no data yet | Open **Set up a team** or **Manage work** on a fresh account.      | The existing destination handles its own empty state; the guide menu still closes cleanly. |
| 2   | Tutorial host unavailable   | Trigger **Open tutorials** while the tutorial host is not mounted. | No duplicate or stuck guide panel remains; the event remains side-effect-safe.             |

## Accessibility

- [x] Keyboard-navigable (Tab, Enter, Space, Escape)
- [x] Screen reader label present
- [x] Menu focus ownership and outside-click dismissal use the shared dropdown engine
- [x] Trigger exposes `aria-haspopup` and `aria-expanded`

## Acceptance Criteria

- [x] A persistent guide icon appears in the sidebar top bar before Search.
- [x] Clicking the icon opens a lightweight floating guide rather than full-screen setup.
- [x] The panel follows the compact reference structure: title/actions, progress, task list, and identity footer.
- [x] Progress derives only from canonical Session, Organization, and Project state.
- [x] All four actions reuse existing product commands and close the guide first.
- [x] The header shortcut opens the existing language/appearance quick setup.
- [x] Shared `IconButton`, tooltip, dropdown components, and UI tokens are used.
- [x] All navigation locale files contain the guide labels.
- [x] No guide progress or completion state is duplicated or fabricated.
