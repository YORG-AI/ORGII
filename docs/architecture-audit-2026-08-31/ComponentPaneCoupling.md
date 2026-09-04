# Component and pane coupling audit

Date: 2026-08-31. Scope: frontend component size, live pane composition, interfaces, and dependency ownership. Audit only; no application code changed.

There are five concrete cleanup candidates. The strongest issues are redundant routing, duplicated adapters, and responsibilities that remain coupled after files have been split. This audit does not establish that any user-facing pane can be removed.

## Evidence and scope

- Inventoried 4,759 production `.ts` / `.tsx` modules under `src/`, excluding `.test.*` and `.d.ts`; 1,700 are TSX files.
- 57 TSX files exceed 600 physical lines, three exceed 800, and one exceeds 1,000. These are triage thresholds, not violations by themselves.
- Parsed imports and interfaces with the installed TypeScript compiler API; traced the suspicious components through production callers. Import counts below count local static value-bearing declarations/re-exports, not external packages or individual imported symbols.
- Swept all 1,700 TSX files for identical function bodies of at least 80 lines, normalizing whitespace. The only repeated group was the two Source Control adapters below. Their original bodies are also byte-identical.
- `pnpm run check:circular`: **passed**, no circular dependencies across 6,340 modules. Its configured graph includes type imports and excludes async imports. A separate production static-value graph also had no cycles. This does not prove the absence of semantic coupling or dependencies through shared stores.
- `pnpm run typecheck`: **passed**, exit 0.
- No runtime benchmarks, rendered E2E, GUI/computer control, backend checks, network payload inspection, or full test suite run. This is a structural audit; no CPU, memory, startup, or render-speed improvement is claimed.

## Ranked findings

Ranking reflects clarity and value of the boundary change, not an assertion of production incident severity.

| Rank | Component / pane                       | Evidence                                                                                                                     | Verdict                                                                        |
| ---- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1    | Integrations category table dispatcher | `CategoryTableContent.tsx`: 314 lines, **80 props**, seven live category-view callers                                        | Remove the redundant dispatcher and universal prop contract                    |
| 2    | Source Control pane adapters           | `SourceControlTabPanels.tsx`: 611 lines; two **123-line, byte-identical bodies**                                             | Consolidate the duplicate live adapter                                         |
| 3    | Workstation sidebar coordinator        | `WorkstationSidebarConnector/index.tsx`: **896 lines**, 47 local static value imports; decoration hook accepts **44 fields** | Split ownership by sidebar surface, not by arbitrary slices of the coordinator |
| 4    | Chat project pane                      | `ProjectPanelView.tsx`: **1,053 lines**, 16 `useState` calls, 8 `useEffect` calls                                            | Separate project editing and work-item orchestration; reuse domain operations  |
| 5    | Chat panel host                        | `ChatPanel/index.tsx`: **755 lines**, 43 local static value imports; empty-content interface has **32 props**                | Move creator workflow and access reconciliation out of the host                |

### 1. Integrations routes twice and carries every category's state

**Live path:** `IntegrationsDetailPanel.tsx:133` selects a category view; for example, `Mcp/McpCategoryView.tsx:58` calls `CategoryTableContent` with a hardcoded `category="mcp"`; `Tables/CategoryTableContent.tsx:174` switches categories again and finally renders `McpTable`.

All paths here are under `src/modules/MainApp/Integrations/`. `useIntegrationsCategoryTableProps.tsx:62` constructs one object combining accounts, databases, channels, MCP, skills, rules, routines, and CLI clients. The 80-field contract at `Tables/CategoryTableContent.tsx:32` requires unrelated domain fields even when the caller already knows which table it needs. Database selection falls back to a no-op at line 204 rather than being required by a database-specific contract. This is unnecessary interface coupling, even without a runtime import cycle.

**Complete JSX caller sweep:** `Connections/ConnectionsCategoryView.tsx:63`, `Databases/DatabasesCategoryView.tsx:68`, `KeyVault/AccountCategoryView.tsx:31`, `Mcp/McpCategoryView.tsx:58`, `Routines/RoutinesCategoryView.tsx:55`, `RulesMemoryEvolution/RulesMemoryEvolutionCategoryView.tsx:75`, and `Skills/SkillsCategoryView.tsx:69`. The shared contract also passes through `ExternalSkillsets/ExternalSkillsetsCategoryView.tsx:74` and `IntegrationsDetailPanel.tsx:85`.

**Proposed boundary:** retain each category view's wizard/detail/list decision, but render its concrete table directly with that table's props. Split the aggregate prop builder into category-owned adapters and delete the redundant table switch once all seven callers are migrated. Keep common table chrome in the existing design-system components. Do not replace this with another universal table component or context containing all 80 fields.

**Acceptance / risk:** account login, MCP add/edit/import, skills previews, routine actions, and database selection must still work through their respective category views. No schema, persistence, API, or product navigation change is needed. This is one sweep, not seven independent redesigns.

### 2. Two Source Control adapters implement exactly the same behavior

File: `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/tabs/SourceControlTabPanels.tsx`.

- `SourceControlTabContent`, declared at line 135, calls `useSourceControlState`, reports loading/files, adapts selection, exposes `refresh`, and passes state/actions into `SourceControlContent`.
- `MainRepoSectionContent`, declared at line 284, does exactly the same work. The callback bodies at lines 155 and 304 are byte-identical: 123 lines each.
- Both are live: `tabs/SourceControlTab.tsx:209` uses the first; `SourceControlTabPanels.tsx:589` uses the second for the main repository in the worktree-aware host.

**Consequence:** every adapter fix has two places to update, without a distinct invariant explaining the second implementation. This is confirmed duplication, not dead code and not evidence that the two render simultaneously.

**Proposed boundary:** use a single connected repository pane in both hosts. Preserve the existing scope key, forwarded ref, loading overlay, and repository identity. The shared `content/SourceControlContent/types.ts:10` also has 65 props spanning working-tree, commit, stash, and remote actions; narrowing that interface is a separate follow-up, not required for the first cleanup.

**Adjacent sweep:** `content/WorktreeSourceControlSection/index.tsx:139` and `content/MultiRootSourceControlContent/index.tsx:319` also render the same view, but use different state sources. Do not erase worktree/multi-root differences just to reduce adapter count. The whole-TSX duplicate-body sweep found no other group at the selected threshold.

**Acceptance / risk:** verify standalone and worktree-hosted main repositories, scope switching, file selection, and imperative refresh. A change to component identity can affect remounts, so preserve explicit keys. This is the smallest cleanup candidate.

### 3. Sidebar file extraction has not created cohesive ownership

File: `src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/index.tsx`.

The coordinator forwards session/cloud data into menu construction at line 391, selection/navigation at line 459, session actions at line 503, and decoration at line 539. `sidebarConnector.menuDecoration.ts:49` accepts 44 fields. Its implementation owns cloud share/move dialogs at line 142, session context menus at line 146, row decoration at line 171, and project click routing at line 211. The project maps and navigation callbacks pass through a hook named “decoration” despite serving a different concern.

The local connector subtree contains 55 production TS/TSX files and 9,213 lines. That is context, not a deletion target: much of it implements necessary sidebar behavior.

**Proposed boundary:** sessions, channels, and work items should each own their menu model, row actions, selection, and pagination through a surface controller. Return a small shared presentation contract such as items, selection, click/context actions, and dialogs. Retain organization scope and cross-surface reveal requests in the parent. Move setup-guide actions into their own unit. Do not merely replace 44 arguments with one 44-field object.

**Acceptance / risk:** test local/cloud navigation, reveal requests, per-group pagination, draft promotion, linked sessions, and view switching. Preserve existing visibility gates and state lifetime; unmounting a controller on every view change is not an automatic improvement.

### 4. The project pane owns both document editing and a second work-item controller

File: `src/engines/ChatPanel/panels/ProjectPanelView.tsx`.

The same component handles sync adapter lookup (line 296), organization loading (321), project-body loading (333), work-item loading/refresh (370), debounced project saves (412), work-item deletion (449), selection/filter/Kanban projection (460), organization moves (562), header publication (805), work-item updates (842), and creation (866). The view imports deep components/hooks from `modules/ProjectManager/WorkItems` as well as owning its own API orchestration.

**Existing parallel owner:** `src/modules/ProjectManager/WorkItems/index.tsx:197` uses `hooks/useWorkItems.ts:30`. Its data layer calls the same `readWorkItemsViewData` endpoint at `hooks/useWorkItemsData.ts:160` and the same partial-update endpoint at line 275. The project pane separately converts update payloads, invokes the API, and reconciles its item array at lines 848–861. A third update/reconciliation path exists in `ProjectManagerLayout/components/useProjectWorkItemsTabContentInteractions.tsx:207`.

Some foundations are already correctly shared: `workItemsViewModel`, `toWorkItemPartialUpdate`, list rendering, and `useMultiSelect`. This is not three completely duplicated implementations. Their project/aggregate scope and creation UX differ and should remain explicit.

**Proposed boundary:** separate a project overview editor, organization/properties section, and project work-item surface. Extract the shared work-item query/update boundary from the existing data layer into a host-independent domain hook/service; leave navigation and view selection in each host. Do not drop the page-level `useWorkItems` wholesale into the chat pane: it also owns page navigation and additional lifecycle behavior.

**Acceptance / risk:** preserve cloud-aware ID allocation, permissions, project saves, list/Kanban behavior, per-project query identity, and aggregate-source restrictions. Query completion guards differ today: the existing data hook uses a generation counter, while the pane loader does not. This audit notes that divergence as evidence for shared ownership, not as a runtime-reproduced stale-data incident. No persisted-data cleanup is proposed.

### 5. The chat host still owns feature workflows after surface extraction

File: `src/engines/ChatPanel/index.tsx`.

The host performs organization access reconciliation at lines 198–243, updater/account navigation at lines 413–423, project/work-item creator setup at lines 425–498, and passes the resulting workflow into `ChatPanelEmptyContent` at line 528. That child requires 32 props (`ChatPanelEmptyContent.tsx:79`). This leaves the host coupled to project APIs, organization membership, session creation, agent definitions, and app updates in addition to tabs, size, chrome, and session presentation.

**Proposed boundary:** let a connected creation surface own its creator state and actions; expose a small outcome/chrome contract to the host. Give tab access reconciliation a clearly named owner with a deliberate lifetime. Keep width, tab chrome, active-session presentation, and keep-alive policy in the host. Merely moving the current body into another hook with the same inputs would not reduce coupling.

**Acceptance / risk:** preserve creator drafts across tab switches and ensure access revocation still closes stale tabs even while their content is hidden. This is broader and riskier than the first four candidates; do it after the narrower changes.

## Large or connected pieces to preserve

| Location                                                                                  | Verdict              | Reason / boundary                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engines/ChatPanel/TabContent/registry.ts:33` and `UnifiedChatPanelTabContent.tsx:44` | Keep                 | An exhaustive surface registry and focused dispatcher already exist. Extend this boundary instead of inventing another registry. Unknown tab types have an explicit placeholder.                                                                                                                                                                     |
| `src/engines/ChatPanel/ChatPanelContent.tsx:49`                                           | Keep                 | The mounted-but-hidden transcript deliberately preserves its virtualized measurement state. Alternate views mount only when selected. File/component reduction must not silently change this policy.                                                                                                                                                 |
| `src/modules/shared/layouts/FocusedChatWorkstationRail/WorkstationTrailTerminal.tsx:109`  | Keep                 | The rail deliberately reuses the terminal engine/store and waits for suppression in the workstation before mounting the claimed PTY. That cross-pane ownership handshake is necessary.                                                                                                                                                               |
| `src/modules/shared/layouts/FocusedChatWorkstationRail/index.tsx:138`                     | Lower-priority watch | 846 lines, 39 local static value imports. Git status, navigation, tabs, terminal ownership, compact menu, and layout coexist. A Git/environment section is a plausible extraction, but composition of these controls is the rail's purpose. Do not label the rail redundant or split the terminal ownership protocol without lifecycle verification. |

## Architecture methodology coverage

Completion criteria for this audit: measured inventory; live caller traces for findings; global sweeps of the identified classes; concrete boundaries and preservation risks; check results and explicit exclusions. No implementation is claimed complete.

| Layer                       | Coverage / result                                                                                                                                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Compilation             | TypeScript check passed. Rust compilation intentionally excluded: no backend code examined or changed.                                                                                                                                                                                                |
| 2 — Dead code / duplication | Traced all seven table dispatcher callers and both identical Source Control adapters. No pane declared dead from reference counts. Large TSX body sweep completed.                                                                                                                                    |
| 3 — Naming                  | `SourceControlTabContent` and `MainRepoSectionContent` imply distinct implementations but have identical bodies. `menuDecoration` also routes project clicks.                                                                                                                                         |
| 4 — Semantic overloading    | “Category” means the outer integration route and an inner table selector; “SourceControlContentProps” names both connected-pane inputs and the 65-field presentation interface; “ChatPanel” includes many non-chat surfaces. Scope names to their actual responsibility during the relevant refactor. |
| 5 — Defaults                | Reviewed the integration table switch/no-op database fallback, explicit unknown-tab placeholder, and stash-vs-working-tree branch. Narrow category contracts instead of relying on irrelevant optional fields.                                                                                        |
| 6 — Cross-domain leakage    | Confirmed universal integration props, sidebar project/session mixing, chat-host creator/access work, and deep project-module imports from the project pane.                                                                                                                                          |
| 7 — New-developer clarity   | Findings focus on duplicate routing and ownership hidden behind file extraction, rather than imposing a line-count target.                                                                                                                                                                            |
| 8 — Wire protocol           | Intentionally excluded real payload inspection: this is a frontend structure audit, no API/schema change or network issue is asserted.                                                                                                                                                                |
| 9 — Entry-point parity      | Compared standalone and worktree-hosted main-repository adapters: identical initialization bodies. Inspected worktree/multi-root adapters separately; full session initialization is outside scope.                                                                                                   |
| 10 — Resolver symmetry      | Inspected local-vs-session Git environment selection in the rail (`index.tsx:157–215`); the distinction is deliberate. Full persisted-field resolver audit is outside scope.                                                                                                                          |

The UI consistency companion is `docs/frontend-ui-audit-2026-08-31/GLOBAL.md`. No runtime performance audit is claimed; a later implementation touching these subscriptions, requests, timers, or retained panes must apply `org2-performance-guard` and verify their lifecycle.

## Suggested delivery order

1. Consolidate the identical Source Control adapter: one small, independently verifiable cleanup.
2. Remove the redundant integration table dispatcher and narrow all seven callers in one focused sweep.
3. Refactor the project pane around shared domain operations and cohesive subviews.
4. Reassign sidebar state/actions to cohesive surface controllers.
5. Extract chat creation/access responsibilities while preserving tab lifetime policy.

Keep these independent changes separate; none requires removing a product pane, changing stored formats, or introducing a new global context.
