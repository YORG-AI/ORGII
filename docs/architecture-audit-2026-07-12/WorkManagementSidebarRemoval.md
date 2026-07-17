# Kanban sidebar removal — architecture audit

Scope: remove the nested Kanban primary-sidebar implementation after moving its destinations into the expandable app-sidebar item.

## Acceptance criteria

- [x] Kanban has no nested `WorkStationShell` or primary-sidebar configuration.
- [x] No production reference remains to the removed sidebar component, width/collapse atoms, responsive helper, or focused hook.
- [x] Kanban and Work Items destination selection has one source of truth: the existing internal Kanban section/project-view atoms.
- [x] Chat-pane titles and icons derive from that same active section and expose only destination names.
- [x] TypeScript compilation, targeted lint, and targeted navigation/Kanban tests pass.

## 10-layer audit

| Layer                                   | Coverage       | Verdict | Evidence / reason                                                                                                                                                                                                                         |
| --------------------------------------- | -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness              | Covered        | pass    | Full `tsc --noEmit` passes after deleting the component, hook, atoms, and re-exports. No Rust was touched.                                                                                                                                |
| 2. Dead code & structural deduplication | Covered        | fix     | Removed `WorkManagementSidebar`, responsive collapse helper/test, Ops-specific persisted width/collapse atoms, `useWorkManagementSidebarState`, and both re-export paths. A repository sweep confirms no remaining production references. |
| 3. Naming consistency                   | Covered        | fix     | User-facing chat-pane names now match the navigation destinations: Kanban, Projects, GitHub Issues, and GitHub PRs. Internal `work-management` IDs remain stable implementation identifiers.                                              |
| 4. Semantic overloading                 | Covered        | fix     | Removed the visible product aliases from the chat pane. `work-management` is only the internal singleton host/type name, while each visible destination has one product label.                                                            |
| 5. Default branch analysis              | Covered        | pass    | Destination and tab-title mappings explicitly cover Kanban, Projects, GitHub Issues, and GitHub PRs. An absent or unknown section safely resolves to Kanban.                                                                              |
| 6. Cross-domain concept leakage         | Covered        | pass    | Work Items navigation remains in the Workstation sidebar connector and Work Management module; shared Workstation panel state no longer carries route-only management state.                                                              |
| 7. New-developer confusion              | Covered        | fix     | Removed the misleading parallel `usePrimarySidebarState` / `useWorkManagementSidebarState` APIs. The expanded parent/child menu now expresses the visible hierarchy directly.                                                             |
| 8. Wire protocol & serialization        | Covered        | fix     | No network schema changed. The versioned ChatPanel storage key intentionally discards obsolete management-tab identities instead of migrating them.                                                                                       |
| 9. Init parity                          | Not applicable | skipped | No initialization entry point or runtime registration path changed.                                                                                                                                                                       |
| 10. Resolver symmetry                   | Not applicable | skipped | No multi-source resolver or fallback chain changed.                                                                                                                                                                                       |

## Term-overloading check

| Term           | Before                                                                 | After                                                                                                                                              | Verdict   |
| -------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Kanban sidebar | Could mean the global app-sidebar item or the nested resizable rail    | User-facing navigation is Kanban plus expandable Work Items; no nested sidebar remains                                                             | clarified |
| View           | Mixed destination navigation with Kanban/List/Diary presentation modes | Kanban is top-level; Work Items expands to the existing project/work-item list and related destinations; presentation modes are in the 40px header | clarified |
| Management tab | Previously displayed under multiple product aliases                    | The chat tab always displays its active destination: Kanban, Projects, GitHub Issues, or GitHub PRs                                                | clarified |

## Systematic sweep

Searched for `WorkManagementSidebar`, `workManagementResponsiveLayout`, `useWorkManagementSidebarState`, `workStationWorkManagementSidebar`, `work_management_sidebar_width`, and `work_management_sidebar_collapsed`. All production definitions, imports, re-exports, tests, and persistence reads/writes were removed. Historical documentation was left intact as an audit trail.
