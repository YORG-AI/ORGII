# Chat pane quota usage — frontend UI audit

Scope: moving quota usage from Runtime to Manage, placing refresh in the section header, and making the quota block collapsible.

| Line                                    | Element                        | Verdict          | Reason                                                                                                                                                                                                 | Suggested change |
| --------------------------------------- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `ChatPanelStartPage.tsx:449-460`        | Manage / Runtime content split | keep with reason | Manage continues to own the launchpad dashboard, while Runtime now renders only the shared data-source panel. The existing lazy boundaries and tab-specific unmount behavior are preserved.            | None.            |
| `WorkspaceDashboardPanelView.tsx:45-47` | Manage quota insertion         | keep with reason | Quota usage is passed into the existing dashboard composition instead of creating a second scroll container or duplicating dashboard layout.                                                           | None.            |
| `LaunchpadDashboard.tsx:57-70,583-590`  | Dashboard header-content slot  | keep with reason | The optional slot places chat-pane-specific content inside the dashboard's established centered, responsive, shared scroll area without coupling the shared launchpad to quota data.                   | None.            |
| `StartPageQuotaGrid.tsx:250-310`        | Collapsible quota section      | keep with reason | Reuses the shared `CollapsibleSection` used by adjacent Manage sections, retaining the existing compact two-column quota cards and pagination behavior.                                                | None.            |
| `StartPageQuotaGrid.tsx:256-276`        | Header refresh action          | keep with reason | Reuses the shared `Button`, keeps the translated accessible label and refresh timestamp, remains usable while the section body is collapsed, and is disabled when there is no refreshable quota entry. | None.            |

Verdict counts: **fix 0**, **keep with reason 5**, **abstract 0**.

Accessibility check: collapse and refresh remain separate native buttons; the refresh action has a translated `aria-label`, disabled state, and tooltip. The shared collapsible-section chevron provides the same interaction pattern used throughout Manage.

Visual verification note: focused server-rendered markup coverage confirms that the collapsible title precedes the header refresh action and quota cards. A live Tauri pass remains the appropriate final check for narrow-pane density.
