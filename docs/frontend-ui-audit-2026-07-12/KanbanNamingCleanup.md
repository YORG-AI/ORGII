# Kanban naming cleanup — frontend UI audit

Scope: make Kanban and Work Items the only product-facing names for the consolidated planning surfaces, remove obsolete navigation entry points, and keep icons and localized copy aligned across the sidebar, ChatPanel, Start Page, Spotlight, and action system.

| Line                                            | Element                                 | Verdict          | Reason                                                                                                                                                                        | Suggested change |
| ----------------------------------------------- | --------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `StartPage/components/AppGrid/config.ts`        | Start Page Kanban entry                 | fix              | The entry previously targeted a retired route and used an unrelated radar icon. It now invokes the canonical Kanban action and uses the same Columns icon as the app sidebar. | None.            |
| `GlobalSpotlight/spotlightActionDefinitions.ts` | Spotlight Kanban action                 | fix              | The action now uses localized Kanban copy, Kanban-only search terms, the shared shortcut, and the matching Columns icon.                                                      | None.            |
| `NavigationSidebar/sidebarConnectorUtils.ts`    | Kanban and Work Items row IDs           | fix              | User-facing navigation IDs now describe the rows directly (`kanban`, `work-items:*`) instead of exposing the internal management host.                                        | None.            |
| `ChatPanel/ChatPanelTabBar.tsx`                 | Section-aware tab title and icon        | keep with reason | The shared ChatPanel tab continues to display the active destination—Kanban, Projects, GitHub Issues, or GitHub PRs—while retaining a single closable tab identity.           | None.            |
| `i18n/locales/*/{common,sessions}.json`         | Localized labels and accessibility text | fix              | Every locale now uses the existing Kanban namespace and localized entry label; obsolete route and product-alias keys were removed.                                            | None.            |

Verdict counts: **fix 4**, **keep with reason 1**, **abstract 0**.

Accessibility check: visible labels, title attributes, action responses, shortcut descriptions, and replay timeline ARIA text now use Kanban consistently. Existing keyboard and tab semantics are unchanged.

Systematic sweep note: searched source paths, filenames, identifiers, string literals, translation keys, test names, route paths, action IDs, shortcut IDs, and persistence shims for the retired vocabulary. Historical changelog documents remain unchanged.

Validation note: the documented `frontend-ui-audit` skill file was unavailable at both repository-listed paths, so this report follows the repository's current audit format and decision conventions.
