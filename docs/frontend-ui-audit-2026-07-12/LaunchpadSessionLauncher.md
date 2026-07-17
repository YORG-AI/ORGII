# Launchpad Work / Manage / Trends — frontend UI audit

Scope: the consolidated Launchpad tabs, centered session launcher, tone-colored Work actions, and lazy Manage surface.

| Line                              | Element                         | Verdict          | Reason                                                                                                                                                                                           | Suggested change |
| --------------------------------- | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `ChatPanelStartPage.tsx:355-370`  | Work / Manage / Trends selector | keep with reason | Reuses the shared `TabPill`, keeps the selector pinned, and replaces Explore with a localized Manage label across every supported locale.                                                        | None.            |
| `ChatPanelStartPage.tsx:440-463`  | Conditional Manage mount        | keep with reason | The workspace management surface is behind `React.lazy` and a strict `manageTabActive` branch. Switching away removes the component tree, subscriptions, and local state rather than hiding it.  | None.            |
| `ChatPanelStartPage.tsx:448-460`  | Work and Trends middle region   | keep with reason | The original session creator remains centered and Trends retains its established constrained layout.                                                                                             | None.            |
| `ChatPanelStartPage.tsx:250-271`  | Original action-pill geometry   | keep with reason | Restores the original rounded-full `p-2` pill, circular icon well, compact label, and trailing hover chevron. Tones remain confined to the outer container and icons retain their neutral color. | None.            |
| `ChatPanelStartPage.tsx:465-483`  | Bottom Work actions             | keep with reason | Actions and hints stay in a dedicated bottom region and are not mounted on Manage or Trends.                                                                                                     | None.            |
| `ChatPanelTabBar.tsx:250-282`     | ChatPanel new-tab menu          | keep with reason | The standalone Dashboard entry is removed; Launchpad is the only entry for the consolidated Work / Manage / Trends surface.                                                                      | None.            |
| `WorkspaceDashboardPanelView.tsx` | Manage content adapter          | keep with reason | Reuses the existing `LaunchpadDashboard` design-system composition rather than duplicating workspace, key, agent, and container controls.                                                        | None.            |
| `menuSelection.ts`                | Folders Dashboard selection     | keep with reason | Sidebar highlighting now derives from the active Launchpad tab plus the Manage inner tab, keeping navigation feedback aligned with the consolidated UI.                                          | None.            |

Verdict counts: **fix 0**, **keep with reason 8**, **abstract 0**.

Accessibility check: action cards remain native buttons with existing focus rings; the shared tab selector retains its keyboard/focus semantics. Lazy unmounting does not leave hidden interactive content in the accessibility tree.

Visual verification note: automated markup coverage confirms the original pill geometry, tone-colored containers, neutral icons, and localized Manage tab. A rendered Tauri smoke pass remains the appropriate check for final density at narrow and short panel sizes.
