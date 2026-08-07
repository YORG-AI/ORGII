# Kanban GitHub list unification — architecture audit

## Acceptance criteria

- [x] Issues and PRs use one list frame, row shell, summary component, and pager.
- [x] Issue-only and PR-only metadata remain explicit at their call sites.
- [x] Sidebar presets use the existing shared tree-row primitive.
- [x] The Issues filter uses the same normal-section height allocation as Views.
- [x] PRs do not create an empty second-level sidebar section.
- [x] Open/create/refresh actions use one shared component in the search toolbar.
- [x] The redundant search-row result count is removed.
- [x] Pagination policy is a pure tested module.
- [x] No parallel sidebar filter state is introduced; search text remains canonical.
- [x] Issue and PR detail views hide the sidebar without mutating the saved collapse preference.
- [x] TypeScript, targeted lint, tests, formatting, and whitespace checks pass.

## Ten-layer audit

| Layer                                     | Coverage                                                                                                                                                                                                                                                                                                                          | Verdict                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1. Compilation correctness                | Full frontend TypeScript check plus targeted ESLint.                                                                                                                                                                                                                                                                              | Pass.                                                                            |
| 2. Dead code and structural deduplication | Traced the rendered path from `GitHubWorkItemsSurface` to both issue and PR rows. Removed the local hand-styled filter list, segmented-pill path, duplicate toolbar action markup, empty PR sidebar host, and auto-height global-section path; wired every new shared component into its applicable scopes.                       | Pass; no aspirational abstraction remains.                                       |
| 3. Naming consistency                     | Shared exports consistently use the `GitHubWorkItem*` prefix. Pagination helpers keep the same domain prefix.                                                                                                                                                                                                                     | Pass.                                                                            |
| 4. Semantic overloading                   | `work item` means a GitHub issue/PR only inside this local Kanban module; ORG2 project work items remain separate. `filter` in the sidebar is represented as a preset that writes the canonical GitHub search query.                                                                                                              | Keep local naming; do not promote these types into the project-work-item domain. |
| 5. Default branch analysis                | Preset selection uses explicit assigned/authored/closed/all branches. Unknown keys do not mutate the query, and callers can only supply declared options.                                                                                                                                                                         | Pass for the closed option set.                                                  |
| 6. Cross-domain concept leakage           | Shared components accept render slots and labels; they do not import issue or PR API models. `TreeRowBase` remains unaware of GitHub query semantics.                                                                                                                                                                             | Pass.                                                                            |
| 7. New-developer confusion                | `GitHubWorkItemRow`, `GitHubWorkItemSummary`, `GitHubWorkItemPagination`, `GitHubWorkItemSidebarFilters`, and `GitHubWorkItemToolbarActions` identify layout ownership directly. Domain metadata stays in `ManagedIssueRow` and `ManagedPrRow`; `onDetailViewChange` explicitly names the only surface-to-shell state projection. | Pass.                                                                            |
| 8. Wire protocol and serialization        | No wire payload, API request shape, or serialization changed. Existing GitHub responses are only rendered and client-filtered.                                                                                                                                                                                                    | Intentionally not applicable.                                                    |
| 9. Init parity                            | No new entry point or initialization flow. Issue and PR surfaces continue through the same component entry point and scope prop.                                                                                                                                                                                                  | Intentionally not applicable.                                                    |
| 10. Resolver symmetry                     | No multi-source resolver changed. Repository and query resolution remain shared before scope-specific rendering.                                                                                                                                                                                                                  | Intentionally not applicable.                                                    |

## Term overloading table

| Term      | Meaning here                                           | Adjacent meaning                                            | Decision                                                      |
| --------- | ------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Work item | A list-renderable GitHub issue or PR.                  | An ORG2 project work item.                                  | Keep the `GitHubWorkItem` prefix on every shared symbol.      |
| State     | GitHub open/closed query state.                        | UI loading/detail state and ORG2 work-item lifecycle state. | Keep `GITHUB_QUERY_STATE` scoped to this module.              |
| Filter    | A named sidebar preset that rewrites the search query. | Repository selector and free-text qualifiers.               | Keep one canonical serialized query; do not add filter atoms. |

## Default branch matrix

| Preset         | State  | Assignee | Author  |
| -------------- | ------ | -------- | ------- |
| Assigned to me | open   | `@me`    | cleared |
| Created by me  | open   | cleared  | `@me`   |
| Closed         | closed | cleared  | cleared |
| All states     | all    | cleared  | cleared |

## Structural sweep

- Searched the Kanban GitHub surface for `TabPill`, the old quick-filter arrays, and the local `FilterOptionList`; no obsolete path remains.
- Both issue and PR rows render through `GitHubWorkItemRow`.
- Both scopes render through `GitHubWorkItemListFrame` and `GitHubWorkItemPagination`.
- Sidebar filter rendering uses `TreeRowBase`, matching the existing Views list rather than duplicating its Tailwind styling.
- Issues alone publish second-level sidebar content, containing only shared tree rows with no custom inset wrapper and using the same `flexGrow: 1` section allocation as Views.
- Both Issues and PRs render search-toolbar actions through `GitHubWorkItemToolbarActions`.
- No search-row result-count label remains.
- Detail openness has one source in `GitHubWorkItemsSurface`; the parent shell only derives sidebar collapse and toggle disabled state from it.
