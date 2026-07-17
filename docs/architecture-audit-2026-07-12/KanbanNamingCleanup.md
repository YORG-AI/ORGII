# Kanban naming cleanup — architecture audit

## Acceptance criteria

- [x] No retired management route or route metadata remains.
- [x] No compatibility migration remains for the former management tab identities.
- [x] Kanban actions, shortcuts, service methods, and ChatPanel entry points use one naming chain.
- [x] Work Items sidebar IDs describe their actual navigation role.
- [x] Route-only station mode, peek state, and focus state are deleted.
- [x] Source and documentation filenames contain no retired product vocabulary outside immutable changelog history.
- [x] TypeScript, focused lint/tests, locale parsing, and diff checks pass.

## 10-layer audit

| Layer                                   | Coverage | Verdict | Evidence / reason                                                                                                                                                             |
| --------------------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness              | Covered  | pass    | Full `tsc --noEmit` and targeted ESLint pass with zero errors. No Rust implementation was changed by this cleanup.                                                            |
| 2. Dead code & structural deduplication | Covered  | fix     | Removed the dedicated route, route loader, app-mode branch, route-only station variant, peek/focus atoms, unused Workstation tab type, and obsolete translation keys.         |
| 3. Naming consistency                   | Covered  | fix     | Actions, shortcuts, services, tests, UI labels, storage keys, modules, and sidebar IDs consistently use Kanban, Work Items, or the neutral internal Work Management host.     |
| 4. Semantic overloading                 | Covered  | fix     | Kanban is the board/action name; Work Items is the expandable navigation group; Work Management is only the internal multi-section host boundary.                             |
| 5. Default branch analysis              | Covered  | pass    | Unknown or absent management sections resolve to Kanban; unknown routes resolve through the normal Workstation code fallback and no longer activate a hidden management mode. |
| 6. Cross-domain concept leakage         | Covered  | fix     | Shared AppShell and station-mode code no longer carries route-specific management state. The Work Management host owns only multi-section content coordination.               |
| 7. New-developer clarity                | Covered  | fix     | `openKanbanTab`, `openKanbanChatPanelTabAtom`, `KANBAN_MENU_ITEM_ID`, and `WORK_ITEMS_*` expose intent without requiring knowledge of a retired product name.                 |
| 8. Wire protocol & serialization        | Covered  | fix     | No external wire protocol changed. The ChatPanel storage key is versioned to intentionally discard obsolete persisted tab identities instead of migrating them.               |
| 9. Init parity                          | Covered  | pass    | Shortcut, Spotlight, action system, Start Page, ChatPanel plus menu, and app sidebar all converge on the same Kanban service/atom path.                                       |
| 10. Resolver symmetry                   | Covered  | pass    | All four management sections use the same section-to-title, section-to-icon, tab activation, and sidebar-selection mappings.                                                  |

## Term-overloading check

| Term            | Product meaning                                        | Internal meaning                                                 | Verdict          |
| --------------- | ------------------------------------------------------ | ---------------------------------------------------------------- | ---------------- |
| Kanban          | Board destination and primary action                   | Default section of the management ChatPanel tab                  | aligned          |
| Work Items      | Expandable navigation group and project/work-item list | Semantic sidebar ID namespace                                    | aligned          |
| Work Management | Not displayed as product copy                          | Neutral host for Kanban, Projects, GitHub Issues, and GitHub PRs | keep with reason |

## Systematic sweep

The sweep covers casing variants, kebab/snake/camel identifiers, filenames, route strings, persisted type shims, action and shortcut IDs, translations, tests, comments, and audit documents. Historical changelog data is intentionally immutable and excluded from the live-reference criterion.
