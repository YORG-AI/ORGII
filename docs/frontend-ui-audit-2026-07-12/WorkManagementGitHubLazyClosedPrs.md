# Kanban GitHub lazy Closed PRs — frontend UI audit

Scope: Kanban PR Open/Closed controls, state feedback, page restoration, and PR status presentation.

| Line / element                                     | Element                             | Verdict          | Reason                                                                                                                                                                     | Suggested change                                    |
| -------------------------------------------------- | ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `GitHubWorkItemsSurface.tsx` PR summary tabs       | Open / Closed controls              | fix              | Adds the missing Closed destination while retaining the existing compact summary-tab pattern and translated labels.                                                        | Keep Closed lazy; do not prefetch it on Open entry. |
| `GitHubWorkItemsSurface.tsx` Closed activation     | Lazy request trigger                | keep with reason | Selecting Closed changes the canonical query state; the fetch resolver derives the required remote state from that same query rather than maintaining a second UI boolean. | None.                                               |
| `GitHubWorkItemsSurface.tsx` PR empty/loading body | Section feedback                    | keep with reason | The Open/Closed controls remain visible while the selected state loads or is empty, matching My Station’s ability to reach Closed even when Open has no rows.              | None.                                               |
| `GitHubWorkItemList.tsx` summary count             | Deferred count pill                 | keep with reason | A count pill is omitted until every selected repository has loaded that state, avoiding a misleading zero before the lazy Closed request completes.                        | None.                                               |
| `GitHubWorkItemsSurface.tsx` PR row icon           | Closed/merged status icon and color | abstract         | Reuses the shared PR status palette; open is green, merged uses primary, and closed uses danger, consistent with My Station.                                               | Keep status mapping sourced from `shared/pr`.       |
| `githubWorkItemsViewCache.ts`                      | Active page restoration             | keep with reason | Restores only the last page/query for Issues and PRs; it does not keep hidden DOM, virtualizers, or historical page stacks alive.                                          | None.                                               |
| `GitHubWorkItemsSurface.tsx` pagination footer     | Restored current page               | keep with reason | Existing 25-row pagination and icon-only tertiary controls are unchanged; the restored page is clamped only after cached/network data resolves.                            | None.                                               |

Verdict counts: **fix 1**, **keep with reason 5**, **abstract 1**.

Accessibility check: Open and Closed remain native buttons with visible text, count pills are supplementary, loading/error/empty content uses the shared Placeholder, and PR row actions retain their existing accessible names.

Visual verification note: automated checks cover lazy state resolution, cache expiry, active-page restoration, pagination, lint, and TypeScript. Final density and transitions should be smoke-tested in the Tauri Kanban PR surface.
