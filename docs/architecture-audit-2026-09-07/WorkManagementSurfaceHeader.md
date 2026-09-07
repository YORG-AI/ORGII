# WorkManagement surface header ownership

Acceptance criteria: Kanban uses a local 36px row; no WorkManagement surface controls enter Chat/WorkStation host chrome during initial load, delayed publication, or section switching; a collapsed host keeps its own heading/actions; unmount releases the host contribution.

Root cause: `WorkManagementPage` read the shared child header slot and forwarded its contents into the host. Whether the host hid that row depended on a lazy child's `hidden` publication. Before that publication, a null/stale slot could display a dataset selector or outgoing controls in the collapsed host header. This is transient presentation state, not persisted domain data; no historical data cleanup is needed.

Fix: the parent publishes only the host visibility contract, independent of child slots. Contributed Kanban/project controls render in `SplitListHeader` inside the page. Inbox, PRs, issues, and routines retain their own local headers. Their section selection immediately excludes outgoing Kanban contributions from the local adapter.

| Layer                  | Evidence / verdict                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Compilation        | `pnpm typecheck:fast` passed.                                                                                                       |
| 2 — Deduplication      | Reuses `SplitListHeader`; removes duplicated forwarding of content/trailing slots into two hosts.                                   |
| 3 — Naming             | Comments distinguish host chrome from page controls.                                                                                |
| 4 — Semantics          | Host header = tab heading/actions; surface header = dataset/filter/search/actions; `hidden` from a child means it owns a local row. |
| 5 — Defaults           | Null/pending slots never change the host's placement contract. Only Kanban and project subpages use the local slot adapter.         |
| 6 — Boundaries         | WorkManagement owns its layout; no domain branching was added to shared ChatPanel components.                                       |
| 7 — Readability        | The ownership decision is documented at the former forwarding boundary.                                                             |
| 8 — Wire               | Not applicable: no API, persistence, or serialization change.                                                                       |
| 9 — Initialization     | Tests cover Chat with expanded/folded tab chrome, WorkStation, delayed publication, and section switches.                           |
| 10 — Resolver symmetry | Both host publishers omit page contents and actions; only the folded Chat host needs a visible heading.                             |

Lifecycle/performance review:

| Area               | Verdict | Evidence                                                                       | Change or reason kept                                                    | Verification                                         |
| ------------------ | ------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| Background work    | keep    | No timers, listeners, requests, or workers added.                              | Existing data-loading lifecycles unchanged.                              | Source diff inspection.                              |
| Memory             | keep    | Existing single host-slot atoms and memoized contributions.                    | No new retained collections.                                             | Unmount clears the owned host contribution in tests. |
| Scope/isolation    | fix     | Child slot contents no longer propagate into host chrome.                      | A stale child publication cannot move controls into the top row.         | Delayed publication and four section-switch tests.   |
| Rendering/hot path | fix     | Host contributions depend only on host placement, not changing child controls. | Stable memoized publication avoids forwarding each filter/search update. | Tests observe every host publication.                |

Performance verdict: pass for the changed publication lifecycle; no CPU/RSS or native rendering improvement is claimed. Native GUI validation was not run under the user's computer-control preference.

Verification: `pnpm test src/modules/MainApp/WorkManagement/WorkManagementPage.test.ts src/features/TaskKanban/hooks/useTaskKanbanHeader.test.ts src/engines/ChatPanel/ChatPanelHeader.test.ts src/modules/MainApp/WorkManagement/GitHubWorkItemsView.test.ts src/modules/MainApp/WorkManagement/RoutineRunsSurface.test.ts` passed (5 files, 30 tests). `pnpm typecheck:fast`, targeted ESLint with `--max-warnings 0`, and `git diff --check` passed. No Rust changes require backend compilation.

`pnpm test src/modules/MainApp/TeamInbox/__tests__/TeamInboxView.layout.test.ts` also passed (22 tests), for 52 passing tests across 6 files.
