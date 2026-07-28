# GitHub work-item tab identity — architecture audit

## Acceptance criteria

- GitHub Issues and GitHub PRs own distinct, deterministic Chat Panel tab IDs.
- Re-selecting either sidebar entry activates its existing tab instead of mutating or duplicating another tab.
- Every Work Management section follows the same focus-or-create path.
- Closing one management tab preserves shared management state while another remains; closing the final one disposes it.
- Persisted normalization retains at most one tab per management section rather than collapsing all sections together.
- Open/Closed header state has explicit handling for supported keys, including merged PRs projecting to Closed.
- All production, service, and E2E entry points use the canonically named Work Management opener.
- Focused tests, targeted ESLint, and the full TypeScript check pass.

## Ten-layer audit

| Layer                                 | Coverage                                     | Verdict | Evidence / reason                                                                                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Compilation correctness            | TypeScript, targeted ESLint, focused Vitest  | pass    | `npm run typecheck` and targeted ESLint pass. The focused tab/header suite completes 31/31 assertions with the repository's default Vitest timeout.                                                                                                    |
| 2. Dead code / structural duplication | Tab factory, opener, and list summary        | pass    | Sidebar clicks trace through one opener and one factory. The obsolete `GitHubWorkItemSummary` component and `summary` frame slot were removed; zero source references remain.                                                                          |
| 3. Naming consistency                 | Work Management open action and ID constant  | pass    | The misleading `openKanbanChatPanelTabAtom` name was replaced by `openWorkManagementChatPanelTabAtom` across UI, service, test, and E2E entry points. The fixed ID constant became a section-key prefix.                                               |
| 4. Semantic overloading               | Tab type versus section identity             | pass    | `work-management` remains the renderer category; `managementSection` is the stable entity key within that category. “Focus” means activating the matching section tab, not rewriting the active tab payload.                                           |
| 5. Default branches                   | Omitted section and header state selection   | pass    | An omitted opener section intentionally resolves to Kanban. The Open/Closed callback now rejects unknown keys explicitly instead of silently defaulting a future value to Open; merged PRs are explicitly projected to Closed.                         |
| 6. Cross-domain leakage               | Chat Panel store and Work Management UI      | pass    | The generic Chat Panel store owns tab identity/lifecycle only; GitHub query/filter logic stays in `modules/MainApp/WorkManagement`. No GitHub API payload enters the generic tab model.                                                                |
| 7. New-developer clarity              | Factory, opener, lifecycle comments          | pass    | Factory comments state “one tab per sidebar section,” the opener name describes its full domain, and `managementSection` is documented as the section owned by the tab.                                                                                |
| 8. Wire protocol / serialization      | Local Chat Panel persistence                 | pass    | No network protocol changes. The local serialized tab shape is unchanged; normalization now deduplicates by `managementSection`, preserves the active representative, and still supplies Kanban for legacy missing sections.                           |
| 9. Init parity                        | Sidebar, controller, service, and E2E seeder | pass    | All entry points call `openWorkManagementChatPanelTabAtom`; sidebar entries provide their typed section/title, while controller/service/E2E paths intentionally use the Kanban default. Each path runs the same append-or-activate presentation chain. |
| 10. Resolver symmetry                 | Section-to-ID, focus, title, and hydration   | pass    | Each section uses the same keyed ID factory, equality match, title refresh, activation action, and per-section hydration dedupe. No section has a special replacement path.                                                                            |

## Entry-point parity matrix

| Entry point                   | Section input      | Identity resolution                  | Existing tab behavior | New tab behavior                 |
| ----------------------------- | ------------------ | ------------------------------------ | --------------------- | -------------------------------- |
| Sidebar → GitHub Issues       | `github-issues`    | `chat-work-management:github-issues` | Activate Issues tab   | Append and activate Issues tab   |
| Sidebar → GitHub PRs          | `github-prs`       | `chat-work-management:github-prs`    | Activate PRs tab      | Append and activate PRs tab      |
| Sidebar → Projects            | `projects`         | `chat-work-management:projects`      | Activate Projects tab | Append and activate Projects tab |
| Kanban controller/service/E2E | omitted → `kanban` | `chat-work-management:kanban`        | Activate Kanban tab   | Append and activate Kanban tab   |

## Lifecycle invariant

`disposeWorkManagementStateAtom` runs only when the closing tab is a Work Management tab and the remaining tab list contains no other Work Management tab. This prevents closing an inactive Issues/PR tab from clearing header, creator, selection, or replay state still owned by the surviving management surface.

## Scoped-out layers

No Rust, database schema, GitHub command payload, authentication, fetch/cache policy, issue/PR mutation semantics, or Workstation main-pane tab type changed.
