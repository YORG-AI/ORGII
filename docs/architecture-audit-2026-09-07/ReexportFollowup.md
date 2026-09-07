# Re-export follow-up

## Scope

Continue the live-consumer migration after the unused-export sweep (#1333) and the earlier shim/root-store/schema work (#1326, #1328, #1332). This working tree was pulled from develop before the local edits and refreshed to `87b805227` after #1328 merged; its one overlapping import conflict was resolved. For publication, this branch was subsequently fast-forwarded to `e11b6f407`; two import conflicts were resolved preserving the latest develop implementations, and the new WorkstationTabContent consumer was migrated. This PR continues Chloe-JY’s earlier re-export cleanup work; commit, push and PR publication use Harry19081.

The pre-edit (`d1f4cbfe4`) TypeScript compiler-API inventory covered **6,609 TS/JS files** under `src`, `tests`, `scripts` and `config`: **432 files with module re-exports**, of which **264 contain only re-export statements**. Import, export, literal dynamic import/require, import-type and supported test-mock references were resolved using the repository tsconfig. Counts include test/tool files; they are not liveness or unnecessary-file counts.

A separate Rust sweep found **902 `pub use` statements** and **11 comment-plus-forwarding-only files**. Rust numbers are source-pattern inventory, not compiler-resolved liveness evidence.

## Implemented locally

The first local pass removed **19** forwarding files: 12 single-owner compatibility shims, two internal helper aggregation files, and the broad UI-hook barrel with its four intermediate barrels. Retarget 169 static import/export statements plus four test mocks to the owning modules. Keep hook/component/atom/parser implementations in place. Public feature/domain boundaries remain available where they still have a concrete role.

| Line                                                                                                             | Element                                 | Verdict | Reason                                                                              | Suggested change            |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------- | ----------------------------------------------------------------------------------- | --------------------------- |
| `src/engines/ChatPanel/ChatHistory/ActionRegistry.ts:13`                                                         | 2 resolved incoming edges before edits  | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |
| `src/engines/ChatPanel/ChatHistory/hooks/chatSearchDom.ts:2`                                                     | 3 resolved incoming edges before edits  | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |
| `src/engines/ChatPanel/blocks/ToolCallBlock/helpers.ts:10`                                                       | 7 resolved incoming edges before edits  | fix     | Internal helper aggregation; callers can select their actual extractor/parser owner | Removed; consumers migrated |
| `src/engines/SessionCore/rendering/props/propsDataExtractors.ts:9`                                               | 19 resolved incoming edges before edits | fix     | Internal helper aggregation; callers can select their actual extractor/parser owner | Removed; consumers migrated |
| `src/engines/SessionCore/sync/adapters/shared/eventBuilders.ts:1`                                                | 6 resolved incoming edges before edits  | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |
| `src/features/TaskKanban/types.ts:5`                                                                             | 6 resolved incoming edges before edits  | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |
| `src/hooks/ui/effects/index.ts:2`                                                                                | 1 resolved incoming edges before edits  | fix     | Broad hook aggregation or an intermediate barrel used by it                         | Removed; consumers migrated |
| `src/hooks/ui/index.ts:2`                                                                                        | 51 resolved incoming edges before edits | fix     | Broad hook aggregation or an intermediate barrel used by it                         | Removed; consumers migrated |
| `src/hooks/ui/layout/index.ts:2`                                                                                 | 1 resolved incoming edges before edits  | fix     | Broad hook aggregation or an intermediate barrel used by it                         | Removed; consumers migrated |
| `src/hooks/ui/sidebar/index.ts:2`                                                                                | 1 resolved incoming edges before edits  | fix     | Broad hook aggregation or an intermediate barrel used by it                         | Removed; consumers migrated |
| `src/hooks/ui/tabs/index.ts:3`                                                                                   | 2 resolved incoming edges before edits  | fix     | Broad hook aggregation or an intermediate barrel used by it                         | Removed; consumers migrated |
| `src/modules/MainApp/Settings/sections/ShortcutsSection/config.ts:1`                                             | 1 resolved incoming edges before edits  | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |
| `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/CodeViewerContent/views/skillFrontmatter.ts:1` | 3 resolved incoming edges before edits  | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |
| `src/modules/WorkStation/ProjectManager/SessionReplay/types.ts:6`                                                | 2 resolved incoming edges before edits  | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |
| `src/modules/WorkStation/shared/TabBar/types.ts:8`                                                               | 6 resolved incoming edges before edits  | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |
| `src/modules/WorkStation/shared/tokens.ts:8`                                                                     | 59 resolved incoming edges before edits | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |
| `src/scaffold/GlobalSpotlight/components/KeyboardShortcut.tsx:1`                                                 | 1 resolved incoming edges before edits  | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |
| `src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/orgFilter.ts:6`                                   | 3 resolved incoming edges before edits  | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |
| `src/util/language/languageMap.ts:5`                                                                             | 3 resolved incoming edges before edits  | fix     | Compatibility forwarding to existing owner                                          | Removed; consumers migrated |

`ActionRegistry` existed to keep the chat-projection worker on pure metadata. Its consumer now imports `events/contextConfig` directly, with that reason documented at the consumer. Existing worker graph tests retain the meaningful boundary assertions. The obsolete facade-identity test was removed instead of changing it into a self-comparison. The UI-hook test mocks were migrated alongside production imports. Extractor tests were renamed/split by owning module, and language-presentation/sidebar-org-filter tests moved beside their canonical owners. AST comparison preserves all 248 remaining affected `it`/`test` call bodies; only the one obsolete ActionRegistry facade-identity test was removed.

## Additional local cleanup

The follow-up removes **15 more TypeScript entries and six Rust compatibility shims**, bringing the local total to **34 TypeScript and six Rust production files**. Large state facades are explicitly postponed.

| Line                                                                                                                                                     | Element                        | Verdict | Reason                                                                               | Suggested change                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `src/hooks/{geo,i18n,streaming,async,files}/index.ts:1`                                                                                                  | Five single-owner hook barrels | fix     | Forward existing hooks without adding a domain contract                              | Removed; imports and mocks target hook modules                 |
| `src/hooks/{storage,config,code}/index.ts:1`                                                                                                             | Three small hook aggregations  | fix     | Callers can select their actual hook/helper owner                                    | Removed; imports target leaf modules                           |
| `src/scaffold/NavigationSidebar/connectors/{WorkstationSidebarConnector,useSessionMenuItems,useProjectsWorkItemMenuItems,SidebarRamMonitorButton}.tsx:1` | Four same-name wrappers        | fix     | Only forward the corresponding directory implementation                              | Removed; consumer paths explicitly select directory index      |
| `src/modules/MainApp/TeamInbox/index.ts:1`                                                                                                               | Unused entry                   | fix     | No resolved consumer; production lazy loading already targets ConnectedTeamInboxView | Removed; source-graph test root retargeted to actual component |
| `src/modules/MainApp/Integrations/Tables/index.ts:1`                                                                                                     | Unused entry                   | fix     | No resolved consumer or configured entry reference                                   | Removed; implementation retained                               |
| `src/modules/MobileRemote/index.tsx:1`                                                                                                                   | Unused entry                   | fix     | Mobile entry points import MobileRemoteRoot directly                                 | Removed; implementation retained                               |

## Retained boundaries and remaining candidates

| Area                                                            | Verdict  | Reason / remaining work                                                                                                                                                                                      |
| --------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ActionSystem actions barrel                                     | keep     | `collectAppZodActions` discovers registrations from its namespace; it is a registry input, not just import convenience                                                                                       |
| Icons facade                                                    | keep     | Deliberate application icon naming/adaptation boundary; removing it would bypass the established icon system                                                                                                 |
| DatabaseCore and feature component APIs                         | keep     | Cohesive module APIs, including explicit lazy-provider boundaries and public-surface tests                                                                                                                   |
| API/project type aggregates                                     | keep     | Domain API surfaces; pure type re-exports do not imply runtime loading overhead                                                                                                                              |
| Cloud sync client facade                                        | keep     | Cohesive client API split across operation modules; changing the public entry is not needed to remove compatibility shims                                                                                    |
| Chat-panel store facades (`chatPanelAtom`, `chatPanelTabsAtom`) | deferred | User explicitly postponed this migration; many consumers and multiple state owners; a migration should trace initialization/module evaluation and atom identity rather than mechanically deleting the facade |
| Remaining domain hook entry points                              | keep     | The eight convenience barrels are removed; remaining cohesive hook APIs are retained                                                                                                                         |
| Same-name `.tsx` → directory `index.tsx` forwarders             | fix      | All four identified sidebar wrappers removed after checking source readers, mocks and entries                                                                                                                |
| Zero-inbound module entries                                     | fix      | Three verified unused entries removed; no inference that every zero-inbound file is dead                                                                                                                     |

The complete pre-edit pure-facade inventory is included below so future work does not restart from one-off grep hits. Entries not in the implemented list are **not** all adjudicated unnecessary. This is a comprehensive inventory plus a bounded, verified migration, not a claim that every possible re-export should disappear.

## Rust forwarding-file disposition

| File                                                                        | Verdict | Reason / next verification                                                                                                              |
| --------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/infrastructure/jsonrpc.rs`                                   | fix     | No in-tree consumers; removed compatibility file and module declaration                                                                 |
| `src-tauri/src/orgtrack/paths.rs`                                           | fix     | Four exporter consumers and the importer now import `orgtrack_core::repo_sync::paths` directly                                          |
| `src-tauri/crates/session-persistence/src/connection.rs`                    | keep    | Explicitly exposes connection/writer helpers without requiring consumers to take a separate database dependency                         |
| `src-tauri/src/agent_sessions/event_pipeline/extractors/types.rs`           | fix     | Extractor implementation/tests import `core_types::extracted`; outer `ExtractedData` export preserved                                   |
| `src-tauri/src/agent_sessions/event_pipeline/streaming.rs`                  | fix     | Session runner binds the same singleton and flush function from `agent_core::foundation::streaming`                                     |
| `src-tauri/crates/integrations/src/commands.rs`                             | keep    | Tauri command registry boundary; changing it also requires checking command macro paths/registration                                    |
| `src-tauri/src/agent_sessions/cli/parsers/alias_map.rs`                     | fix     | Ingestion and extractor tests now use `core_types::cli_alias`                                                                           |
| `src-tauri/crates/agent-core/src/core/session/types/filter.rs`              | keep    | Public session API exposes the shared type while avoiding reverse dependencies; private module layout is not a reason to remove the API |
| `src-tauri/crates/agent-core/src/core/tools/builtin_tools/table/aliases.rs` | keep    | Deliberate enum disambiguation for category-table entries, not redundant forwarding                                                     |
| `src-tauri/crates/agent-core/src/core/tools/names.rs`                       | keep    | Public tools namespace exposing canonical shared names; many consumers rely on the domain API                                           |
| `src-tauri/crates/agent-core/src/core/providers/safe_truncate.rs`           | fix     | Five provider consumers now use existing `crate::utils::safe_truncate_utf8` export                                                      |

Six compatibility files were removed and in-tree callers migrated to canonical owners. The outer extractor `ExtractedData` export remains available. No dependencies, wire formats, singleton implementations or parser logic changed. These removals change source-level compatibility paths; out-of-tree consumers of those paths would need to migrate. Five intentional Rust boundaries remain.

## Verification and architecture coverage

Verification results are recorded at completion below. Module-reference verification treats deleted files as resolvable so unresolved old paths cannot silently disappear from the inventory. Production AST comparison excludes imports/re-exports and comments, verifying unchanged executable declarations/statements. This does not prove identical transitive module evaluation or runtime performance.

Architecture layers: compilation and structural/reference tracing (1–2); canonical naming and ownership (3–4); module boundaries and discoverability (6–7). No fallback branches, wire shapes, initialization functions or resolver algorithms are modified (5, 8–10); broad behavior audits of those systems are outside this import migration. TSX edits do not change JSX, styles or component bodies, so the frontend UI skill's type/architecture exclusion applies.

Lifecycle review: no timer, listener, subscription, cache, state-owner, worker or parser implementation changes. The same hooks and atom singletons remain the consumer bindings. No CPU, RSS or bundle-size improvement is claimed. Desktop/mobile execution, production bundling and GUI/E2E are not validated by this static review.

## Pure-facade inventory before local edits

| File                                                                                                              | Resolved incoming edges | Local disposition                           |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------: | ------------------------------------------- |
| `src/ActionSystem/actions/index.ts`                                                                               |                       2 | retained; see boundary/candidate discussion |
| `src/ActionSystem/index.ts`                                                                                       |                      35 | retained; see boundary/candidate discussion |
| `src/ActionSystem/schema/index.ts`                                                                                |                       1 | retained; see boundary/candidate discussion |
| `src/api/http/client/index.ts`                                                                                    |                       1 | retained; see boundary/candidate discussion |
| `src/api/http/integrations/index.ts`                                                                              |                      29 | retained; see boundary/candidate discussion |
| `src/api/http/project/client/index.ts`                                                                            |                       2 | retained; see boundary/candidate discussion |
| `src/api/http/project/types.ts`                                                                                   |                      31 | retained; see boundary/candidate discussion |
| `src/api/tauri/agent/index.ts`                                                                                    |                     100 | retained; see boundary/candidate discussion |
| `src/api/tauri/externalHistory/index.ts`                                                                          |                      56 | retained; see boundary/candidate discussion |
| `src/api/tauri/github/index.ts`                                                                                   |                     145 | retained; see boundary/candidate discussion |
| `src/api/tauri/perf/index.ts`                                                                                     |                       2 | retained; see boundary/candidate discussion |
| `src/api/tauri/rpc/index.ts`                                                                                      |                      89 | retained; see boundary/candidate discussion |
| `src/api/tauri/rpc/procedures/index.ts`                                                                           |                       1 | retained; see boundary/candidate discussion |
| `src/api/tauri/rpc/schemas/index.ts`                                                                              |                      21 | retained; see boundary/candidate discussion |
| `src/components/Chart/index.ts`                                                                                   |                       1 | retained; see boundary/candidate discussion |
| `src/components/Dropdown/exports.ts`                                                                              |                      18 | retained; see boundary/candidate discussion |
| `src/components/FileTreePreview/exports.ts`                                                                       |                       5 | retained; see boundary/candidate discussion |
| `src/components/GitDialogs/index.ts`                                                                              |                       7 | retained; see boundary/candidate discussion |
| `src/components/ListPanel/index.ts`                                                                               |                       5 | retained; see boundary/candidate discussion |
| `src/components/PermissionPrompt/index.ts`                                                                        |                       3 | retained; see boundary/candidate discussion |
| `src/components/SessionReferenceCard/index.ts`                                                                    |                       4 | retained; see boundary/candidate discussion |
| `src/components/TreeRow/index.ts`                                                                                 |                      44 | retained; see boundary/candidate discussion |
| `src/components/TurnNavigationToolbar/index.ts`                                                                   |                       2 | retained; see boundary/candidate discussion |
| `src/components/VirtualizedStickyTree/hooks/index.ts`                                                             |                       2 | retained; see boundary/candidate discussion |
| `src/components/Voice/index.ts`                                                                                   |                       4 | retained; see boundary/candidate discussion |
| `src/components/WindowChrome/index.ts`                                                                            |                      14 | retained; see boundary/candidate discussion |
| `src/config/keyboard/shortcuts/index.ts`                                                                          |                       3 | retained; see boundary/candidate discussion |
| `src/config/mainAppPaths.ts`                                                                                      |                      44 | retained; see boundary/candidate discussion |
| `src/contexts/git/index.ts`                                                                                       |                      13 | retained; see boundary/candidate discussion |
| `src/contexts/workstation/index.ts`                                                                               |                       3 | retained; see boundary/candidate discussion |
| `src/diagnostics/index.ts`                                                                                        |                       1 | retained; see boundary/candidate discussion |
| `src/engines/ChatPanel/ChatHistory/ActionRegistry.ts`                                                             |                       2 | removed in this batch                       |
| `src/engines/ChatPanel/ChatHistory/chatItemPipeline/index.ts`                                                     |                       6 | retained; see boundary/candidate discussion |
| `src/engines/ChatPanel/ChatHistory/hooks/chatSearchDom.ts`                                                        |                       3 | removed in this batch                       |
| `src/engines/ChatPanel/ChatHistory/hooks/index.ts`                                                                |                       2 | retained; see boundary/candidate discussion |
| `src/engines/ChatPanel/ChatHistory/renderers/index.ts`                                                            |                       5 | retained; see boundary/candidate discussion |
| `src/engines/ChatPanel/blocks/ToolCallBlock/cards/index.ts`                                                       |                       1 | retained; see boundary/candidate discussion |
| `src/engines/ChatPanel/blocks/ToolCallBlock/helpers.ts`                                                           |                       7 | removed in this batch                       |
| `src/engines/ChatPanel/blocks/ToolCallBlock/helpers/cardParsers/index.ts`                                         |                       5 | retained; see boundary/candidate discussion |
| `src/engines/ChatPanel/blocks/primitives/index.ts`                                                                |                      60 | retained; see boundary/candidate discussion |
| `src/engines/ChatPanel/header/index.ts`                                                                           |                      12 | retained; see boundary/candidate discussion |
| `src/engines/ChatPanel/hooks/useWorkspaceChat/index.ts`                                                           |                       3 | retained; see boundary/candidate discussion |
| `src/engines/ChatPanel/rendering/adapters/index.ts`                                                               |                       3 | retained; see boundary/candidate discussion |
| `src/engines/ChatPanel/rendering/index.ts`                                                                        |                       1 | retained; see boundary/candidate discussion |
| `src/engines/DatabaseCore/index.ts`                                                                               |                      14 | retained; see boundary/candidate discussion |
| `src/engines/DatabaseCore/providers/index.ts`                                                                     |                       2 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/core/atoms/index.ts`                                                                     |                      41 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/core/store/index.ts`                                                                     |                       4 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/hooks/replay/index.ts`                                                                   |                       1 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/hooks/session/index.ts`                                                                  |                      10 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/hooks/session/useSessionCreator/index.ts`                                                |                       3 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/payloads/index.ts`                                                                       |                       3 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/rendering/props/index.ts`                                                                |                      18 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/rendering/props/propsDataExtractors.ts`                                                  |                      19 | removed in this batch                       |
| `src/engines/SessionCore/rendering/registry/index.ts`                                                             |                      30 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/services/index.ts`                                                                       |                       2 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/sync/adapters/shared/eventBuilders.ts`                                                   |                       6 | removed in this batch                       |
| `src/engines/SessionCore/sync/adapters/shared/index.ts`                                                           |                       7 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/turns/index.ts`                                                                          |                       4 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/workspace/atoms/index.ts`                                                                |                       1 | retained; see boundary/candidate discussion |
| `src/engines/SessionCore/workspace/hooks/index.ts`                                                                |                       1 | retained; see boundary/candidate discussion |
| `src/engines/Simulator/components/Dock/index.ts`                                                                  |                       2 | retained; see boundary/candidate discussion |
| `src/engines/Simulator/components/GridCell/index.ts`                                                              |                       1 | retained; see boundary/candidate discussion |
| `src/engines/Simulator/exports.ts`                                                                                |                       1 | retained; see boundary/candidate discussion |
| `src/engines/Simulator/index.ts`                                                                                  |                       1 | retained; see boundary/candidate discussion |
| `src/features/CalendarView/hooks/index.ts`                                                                        |                       1 | retained; see boundary/candidate discussion |
| `src/features/CanvasShare/index.ts`                                                                               |                       3 | retained; see boundary/candidate discussion |
| `src/features/CodeMirror/Editor/hooks/index.ts`                                                                   |                       1 | retained; see boundary/candidate discussion |
| `src/features/CodeMirror/config/index.ts`                                                                         |                       9 | retained; see boundary/candidate discussion |
| `src/features/CodeMirror/index.ts`                                                                                |                       8 | retained; see boundary/candidate discussion |
| `src/features/CodeMirror/themes/index.ts`                                                                         |                       1 | retained; see boundary/candidate discussion |
| `src/features/GanttChart/hooks/index.ts`                                                                          |                       3 | retained; see boundary/candidate discussion |
| `src/features/HumanSession/index.ts`                                                                              |                       1 | retained; see boundary/candidate discussion |
| `src/features/KanbanBoard/components/index.ts`                                                                    |                       2 | retained; see boundary/candidate discussion |
| `src/features/Org2Cloud/org2CloudSyncClient.ts`                                                                   |                      32 | retained; see boundary/candidate discussion |
| `src/features/SessionCreator/components/index.ts`                                                                 |                       2 | retained; see boundary/candidate discussion |
| `src/features/SessionCreator/variants/index.ts`                                                                   |                       3 | retained; see boundary/candidate discussion |
| `src/features/SessionSetup/index.ts`                                                                              |                       5 | retained; see boundary/candidate discussion |
| `src/features/TaskKanban/types.ts`                                                                                |                       6 | removed in this batch                       |
| `src/features/TeamCollaboration/engine/collabSyncEngineHelpers.ts`                                                |                      16 | retained; see boundary/candidate discussion |
| `src/hooks/async/index.ts`                                                                                        |                       3 | removed in this batch                       |
| `src/hooks/auth/index.ts`                                                                                         |                       4 | retained; see boundary/candidate discussion |
| `src/hooks/code/index.ts`                                                                                         |                       2 | removed in this batch                       |
| `src/hooks/config/index.ts`                                                                                       |                       2 | removed in this batch                       |
| `src/hooks/dropdown/index.ts`                                                                                     |                      54 | retained; see boundary/candidate discussion |
| `src/hooks/fileReview/index.ts`                                                                                   |                       2 | retained; see boundary/candidate discussion |
| `src/hooks/files/index.ts`                                                                                        |                       2 | removed in this batch                       |
| `src/hooks/flowAwareness/index.ts`                                                                                |                       2 | retained; see boundary/candidate discussion |
| `src/hooks/geo/index.ts`                                                                                          |                       1 | removed in this batch                       |
| `src/hooks/git/index.ts`                                                                                          |                       8 | retained; see boundary/candidate discussion |
| `src/hooks/git/useRepoSelection/index.ts`                                                                         |                      20 | retained; see boundary/candidate discussion |
| `src/hooks/housekeeper/index.ts`                                                                                  |                       6 | retained; see boundary/candidate discussion |
| `src/hooks/i18n/index.ts`                                                                                         |                       1 | removed in this batch                       |
| `src/hooks/input/index.ts`                                                                                        |                       3 | retained; see boundary/candidate discussion |
| `src/hooks/keyVault/index.ts`                                                                                     |                      53 | retained; see boundary/candidate discussion |
| `src/hooks/keyboard/index.ts`                                                                                     |                      17 | retained; see boundary/candidate discussion |
| `src/hooks/logger/index.ts`                                                                                       |                     494 | retained; see boundary/candidate discussion |
| `src/hooks/models/index.ts`                                                                                       |                      11 | retained; see boundary/candidate discussion |
| `src/hooks/navigation/index.ts`                                                                                   |                      12 | retained; see boundary/candidate discussion |
| `src/hooks/navigation/useGlobalShortcuts/index.ts`                                                                |                       2 | retained; see boundary/candidate discussion |
| `src/hooks/perf/index.ts`                                                                                         |                      20 | retained; see boundary/candidate discussion |
| `src/hooks/platform/useInlineWebview/index.ts`                                                                    |                       2 | retained; see boundary/candidate discussion |
| `src/hooks/policies/index.ts`                                                                                     |                      21 | retained; see boundary/candidate discussion |
| `src/hooks/project/index.ts`                                                                                      |                      28 | retained; see boundary/candidate discussion |
| `src/hooks/search/index.ts`                                                                                       |                      13 | retained; see boundary/candidate discussion |
| `src/hooks/settings/index.ts`                                                                                     |                       7 | retained; see boundary/candidate discussion |
| `src/hooks/storage/index.ts`                                                                                      |                       1 | removed in this batch                       |
| `src/hooks/streaming/index.ts`                                                                                    |                       1 | removed in this batch                       |
| `src/hooks/ui/effects/index.ts`                                                                                   |                       1 | removed in this batch                       |
| `src/hooks/ui/index.ts`                                                                                           |                      51 | removed in this batch                       |
| `src/hooks/ui/layout/index.ts`                                                                                    |                       1 | removed in this batch                       |
| `src/hooks/ui/sidebar/index.ts`                                                                                   |                       1 | removed in this batch                       |
| `src/hooks/ui/tabs/index.ts`                                                                                      |                       2 | removed in this batch                       |
| `src/hooks/voice/index.ts`                                                                                        |                       5 | retained; see boundary/candidate discussion |
| `src/icons.ts`                                                                                                    |                     894 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/Integrations/Connections/Channels/components/index.ts`                                       |                       1 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/Integrations/Connections/Channels/configs/index.ts`                                          |                       2 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/Integrations/Connections/Channels/index.ts`                                                  |                       4 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/Integrations/DevTools/playground/hooks/index.ts`                                             |                       4 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/Integrations/DevTools/playground/panels/index.ts`                                            |                       7 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/Integrations/DevTools/playground/previews/index.ts`                                          |                       1 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/Integrations/DevTools/playground/shared/index.ts`                                            |                       5 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/Integrations/DevTools/playground/single-event/index.ts`                                      |                       1 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/Integrations/Tables/index.ts`                                                                |                       0 | removed in this batch                       |
| `src/modules/MainApp/Settings/sections/ShortcutsSection/config.ts`                                                |                       1 | removed in this batch                       |
| `src/modules/MainApp/Settings/subpages/BackgroundPage/components/index.ts`                                        |                       1 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/Settings/subpages/BackgroundPage/hooks/index.ts`                                             |                       1 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/TeamInbox/components/index.ts`                                                               |                       4 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/TeamInbox/domain/index.ts`                                                                   |                      42 | retained; see boundary/candidate discussion |
| `src/modules/MainApp/TeamInbox/index.ts`                                                                          |                       0 | removed in this batch                       |
| `src/modules/MobileRemote/app/index.ts`                                                                           |                      12 | retained; see boundary/candidate discussion |
| `src/modules/MobileRemote/index.tsx`                                                                              |                       0 | removed in this batch                       |
| `src/modules/MobileRemote/platform/browser/index.ts`                                                              |                       9 | retained; see boundary/candidate discussion |
| `src/modules/MobileRemote/platform/index.ts`                                                                      |                      12 | retained; see boundary/candidate discussion |
| `src/modules/MobileRemote/platform/tauri/index.ts`                                                                |                       1 | retained; see boundary/candidate discussion |
| `src/modules/ProjectManager/Projects/components/RepoSettings/sections/index.ts`                                   |                       1 | retained; see boundary/candidate discussion |
| `src/modules/ProjectManager/Projects/components/index.ts`                                                         |                       3 | retained; see boundary/candidate discussion |
| `src/modules/ProjectManager/WorkItems/components/WorkItemsSettings/subpages/index.ts`                             |                       3 | retained; see boundary/candidate discussion |
| `src/modules/ProjectManager/WorkItems/components/index.ts`                                                        |                       7 | retained; see boundary/candidate discussion |
| `src/modules/ProjectManager/WorkItems/hooks/useProjectData/index.ts`                                              |                       1 | retained; see boundary/candidate discussion |
| `src/modules/ProjectManager/config/manage/index.ts`                                                               |                      18 | retained; see boundary/candidate discussion |
| `src/modules/ProjectManager/shared/components/index.ts`                                                           |                       3 | retained; see boundary/candidate discussion |
| `src/modules/ProjectManager/shared/index.ts`                                                                      |                      25 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/AppShell/TabBarPlusMenu/index.ts`                                                        |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/Browser/ImportCookies/index.ts`                                                          |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/Browser/Panels/BrowserPrimarySidebar/tabs/DesignTab/sections/index.ts`                   |                       2 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/Browser/hooks/index.ts`                                                                  |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/Browser/shared/index.ts`                                                                 |                       4 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/CodeViewerContent/hooks/index.ts`               |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/CodeViewerContent/views/index.ts`               |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/CodeViewerContent/views/skillFrontmatter.ts`    |                       3 | removed in this batch                       |
| `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/FilePreviewContent/index.ts`                    |                       2 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/hooks/index.ts`                                         |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/SearchContent/components/index.ts`        |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/SearchContent/useSearchContent/index.ts`  |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/SourceControlContent/components/index.ts` |                       2 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/SourceControlContent/hooks/index.ts`      |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/hooks/index.ts`                                   |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/CodeEditor/Panels/shared/index.ts`                                                       |                       5 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/CodeEditor/SessionReplay/converters/index.ts`                                            |                       2 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/ProjectManager/SessionReplay/types.ts`                                                   |                       2 | removed in this batch                       |
| `src/modules/WorkStation/shared/PrimarySidebarLayout/index.ts`                                                    |                       8 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/PropertyEditor/index.ts`                                                          |                       2 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/SessionReplay/index.ts`                                                           |                       2 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/SidebarModules/SourceControl/index.ts`                                            |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/SidebarModules/Terminal/index.ts`                                                 |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/SidebarModules/index.ts`                                                          |                       6 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/StatusBar/index.ts`                                                               |                       3 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/TabBar/components/index.ts`                                                       |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/TabBar/hooks/index.ts`                                                            |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/TabBar/types.ts`                                                                  |                       6 | removed in this batch                       |
| `src/modules/WorkStation/shared/TableSurface/index.ts`                                                            |                       3 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/index.ts`                                                                         |                      76 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/simulatorRegistry/index.ts`                                                       |                       1 | retained; see boundary/candidate discussion |
| `src/modules/WorkStation/shared/tokens.ts`                                                                        |                      59 | removed in this batch                       |
| `src/modules/shared/hooks/index.ts`                                                                               |                       3 | retained; see boundary/candidate discussion |
| `src/modules/shared/launchpad/components/RepoDetail/index.ts`                                                     |                       1 | retained; see boundary/candidate discussion |
| `src/modules/shared/launchpad/components/index.ts`                                                                |                       2 | retained; see boundary/candidate discussion |
| `src/modules/shared/launchpad/hooks/index.ts`                                                                     |                       2 | retained; see boundary/candidate discussion |
| `src/modules/shared/layouts/SectionLayout/index.ts`                                                               |                     161 | retained; see boundary/candidate discussion |
| `src/modules/shared/layouts/blocks/index.ts`                                                                      |                     154 | retained; see boundary/candidate discussion |
| `src/modules/shared/layouts/index.ts`                                                                             |                       4 | retained; see boundary/candidate discussion |
| `src/router/guards/index.ts`                                                                                      |                       1 | retained; see boundary/candidate discussion |
| `src/scaffold/ContextMenu/exports.ts`                                                                             |                       6 | retained; see boundary/candidate discussion |
| `src/scaffold/ContextMenu/variants/TextSelectionDropdown/exports.ts`                                              |                       1 | retained; see boundary/candidate discussion |
| `src/scaffold/ContextMenu/variants/index.ts`                                                                      |                       1 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/components/KeyboardShortcut.tsx`                                                    |                       1 | removed in this batch                       |
| `src/scaffold/GlobalSpotlight/components/index.ts`                                                                |                      14 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/forms/index.ts`                                                                     |                       1 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/forms/shared/index.ts`                                                              |                       8 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/hooks/core/index.ts`                                                                |                       3 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/hooks/data/index.ts`                                                                |                       1 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/hooks/features/index.ts`                                                            |                       1 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/hooks/features/spotlightActionDefinitions.ts`                                       |                       8 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/hooks/forms/index.ts`                                                               |                       3 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/hooks/index.ts`                                                                     |                       9 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/palettes/adapters/index.ts`                                                         |                       2 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/palettes/core/index.ts`                                                             |                      17 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/palettes/index.ts`                                                                  |                       8 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/shared/index.ts`                                                                    |                      21 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/shell/index.ts`                                                                     |                      20 | retained; see boundary/candidate discussion |
| `src/scaffold/GlobalSpotlight/views/index.ts`                                                                     |                       2 | retained; see boundary/candidate discussion |
| `src/scaffold/NavigationSidebar/blocks/index.ts`                                                                  |                       4 | retained; see boundary/candidate discussion |
| `src/scaffold/NavigationSidebar/components/NavigationMenu/index.tsx`                                              |                       4 | retained; see boundary/candidate discussion |
| `src/scaffold/NavigationSidebar/connectors/SidebarRamMonitorButton.tsx`                                           |                       1 | removed in this batch                       |
| `src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector.tsx`                                       |                       1 | removed in this batch                       |
| `src/scaffold/NavigationSidebar/connectors/index.ts`                                                              |                       3 | retained; see boundary/candidate discussion |
| `src/scaffold/NavigationSidebar/connectors/useProjectsWorkItemMenuItems.tsx`                                      |                       4 | removed in this batch                       |
| `src/scaffold/NavigationSidebar/connectors/useSessionMenuItems.tsx`                                               |                       1 | removed in this batch                       |
| `src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/orgFilter.ts`                                      |                       3 | removed in this batch                       |
| `src/scaffold/NavigationSidebar/contexts/index.ts`                                                                |                       1 | retained; see boundary/candidate discussion |
| `src/scaffold/NavigationSidebar/index.ts`                                                                         |                       1 | retained; see boundary/candidate discussion |
| `src/scaffold/NavigationSidebar/variants/index.ts`                                                                |                       1 | retained; see boundary/candidate discussion |
| `src/scaffold/Resize/components/index.ts`                                                                         |                       1 | retained; see boundary/candidate discussion |
| `src/scaffold/Resize/hooks/index.ts`                                                                              |                       1 | retained; see boundary/candidate discussion |
| `src/scaffold/Resize/index.ts`                                                                                    |                      15 | retained; see boundary/candidate discussion |
| `src/scaffold/WizardSystem/primitives/index.ts`                                                                   |                      24 | retained; see boundary/candidate discussion |
| `src/scaffold/WizardSystem/variants/KeyVault/index.ts`                                                            |                       4 | retained; see boundary/candidate discussion |
| `src/services/app/index.ts`                                                                                       |                       3 | retained; see boundary/candidate discussion |
| `src/services/context/collectors/index.ts`                                                                        |                       5 | retained; see boundary/candidate discussion |
| `src/services/file/index.ts`                                                                                      |                       7 | retained; see boundary/candidate discussion |
| `src/services/git/index.ts`                                                                                       |                       7 | retained; see boundary/candidate discussion |
| `src/services/navigation/index.ts`                                                                                |                       1 | retained; see boundary/candidate discussion |
| `src/services/panel/index.ts`                                                                                     |                       4 | retained; see boundary/candidate discussion |
| `src/services/search/index.ts`                                                                                    |                       1 | retained; see boundary/candidate discussion |
| `src/services/terminal/index.ts`                                                                                  |                      11 | retained; see boundary/candidate discussion |
| `src/services/workStation/index.ts`                                                                               |                       1 | retained; see boundary/candidate discussion |
| `src/services/workspace/index.ts`                                                                                 |                       1 | retained; see boundary/candidate discussion |
| `src/store/chatPanel/chatPanelTabOpen/index.ts`                                                                   |                       1 | retained; see boundary/candidate discussion |
| `src/store/chatPanel/chatPanelTabOpenAtoms.ts`                                                                    |                      10 | retained; see boundary/candidate discussion |
| `src/store/chatPanel/chatPanelTabsAtom.ts`                                                                        |                     110 | retained; see boundary/candidate discussion |
| `src/store/config/index.ts`                                                                                       |                       1 | retained; see boundary/candidate discussion |
| `src/store/git/index.ts`                                                                                          |                      20 | retained; see boundary/candidate discussion |
| `src/store/index.ts`                                                                                              |                      16 | removed by merged #1328; pulled locally     |
| `src/store/platform/index.ts`                                                                                     |                       1 | retained; see boundary/candidate discussion |
| `src/store/project/index.ts`                                                                                      |                       3 | retained; see boundary/candidate discussion |
| `src/store/repo/index.ts`                                                                                         |                      73 | retained; see boundary/candidate discussion |
| `src/store/session/index.ts`                                                                                      |                     211 | retained; see boundary/candidate discussion |
| `src/store/session/sessionAtom/index.ts`                                                                          |                      46 | retained; see boundary/candidate discussion |
| `src/store/settings/index.ts`                                                                                     |                      15 | retained; see boundary/candidate discussion |
| `src/store/sync/index.ts`                                                                                         |                       4 | retained; see boundary/candidate discussion |
| `src/store/ui/chatPanelAtom.ts`                                                                                   |                     157 | retained; see boundary/candidate discussion |
| `src/store/ui/index.ts`                                                                                           |                       2 | retained; see boundary/candidate discussion |
| `src/store/ui/workStationAtom.ts`                                                                                 |                      55 | retained; see boundary/candidate discussion |
| `src/store/ui/workStationLayout/index.ts`                                                                         |                       2 | retained; see boundary/candidate discussion |
| `src/store/ui/workspace/index.ts`                                                                                 |                       2 | retained; see boundary/candidate discussion |
| `src/store/user/index.ts`                                                                                         |                       3 | retained; see boundary/candidate discussion |
| `src/store/workspace/index.ts`                                                                                    |                      39 | retained; see boundary/candidate discussion |
| `src/store/workstation/browser/tokens/index.ts`                                                                   |                       1 | retained; see boundary/candidate discussion |
| `src/store/workstation/codeEditor/editor/index.ts`                                                                |                       3 | retained; see boundary/candidate discussion |
| `src/store/workstation/codeEditor/index.ts`                                                                       |                       9 | retained; see boundary/candidate discussion |
| `src/store/workstation/codeEditor/outputIntegration/index.ts`                                                     |                       6 | retained; see boundary/candidate discussion |
| `src/store/workstation/database/index.ts`                                                                         |                       3 | retained; see boundary/candidate discussion |
| `src/store/workstation/index.ts`                                                                                  |                      38 | retained; see boundary/candidate discussion |
| `src/store/workstation/projectManager/index.ts`                                                                   |                      15 | retained; see boundary/candidate discussion |
| `src/store/workstation/tabRegistry/index.ts`                                                                      |                       7 | retained; see boundary/candidate discussion |
| `src/store/workstation/tabs/factories/index.ts`                                                                   |                       7 | retained; see boundary/candidate discussion |
| `src/store/workstation/tabs/index.ts`                                                                             |                     139 | retained; see boundary/candidate discussion |
| `src/types/extensions/index.ts`                                                                                   |                      41 | retained; see boundary/candidate discussion |
| `src/types/terminal/index.ts`                                                                                     |                       4 | retained; see boundary/candidate discussion |
| `src/util/core/error/componentIssueTracker/index.ts`                                                              |                       9 | retained; see boundary/candidate discussion |
| `src/util/language/index.ts`                                                                                      |                       1 | retained; see boundary/candidate discussion |
| `src/util/language/languageMap.ts`                                                                                |                       3 | removed in this batch                       |
| `tests/e2e/support/core/session/agentQueuedFollowupScenarios.mjs`                                                 |                       2 | retained; see boundary/candidate discussion |

## Completed validation

- Pre-publication-integration `pnpm test` — **1,539 files / 11,512 tests passed** after all TypeScript migrations, test relocations and source-graph root updates (399.06 seconds).
- Final `pnpm typecheck:fast` — passed after all TypeScript changes.
- Earlier targeted command below — 27 files / 341 tests passed, including the moved tests, four retargeted hook mocks, UI hooks, worker graph and startup/feature boundaries.
- `cargo check --manifest-path src-tauri/Cargo.toml -p agent_core -p org2 --tests` — passed after fixing the relative orgtrack importer and grouped extractor-test imports caught by compilation. The missing packaged sidecar was supplied by an ignored symlink to the existing local build; no build configuration was changed.
- Full Rust test suite, app runtime/GUI, E2E and release bundling were not run; the import-only scope received app/test compilation and focused Rust owner tests.
- `cargo test --manifest-path src-tauri/Cargo.toml -p agent_core --lib safe_truncate` — **18 passed**, zero failures.
- Rustfmt — applied to all 26 changed existing Rust files.
- ESLint (`--fix --max-warnings 0`) and Prettier — passed on all 179 changed/new source and test files.
- TypeScript module-resolution sweep — 34 removed production modules, zero stale imports/re-exports/literal loader/type/mock references.
- Production AST comparison against pulled develop — all 166 modified production files have unchanged non-import/export statements.
- Test-call AST multiset comparison — 249 original cases, 248 retained identical cases, only the obsolete facade-identity case removed, zero new/replaced cases.
- `pnpm check:circular` — final post-pull/post-UI-hook check passed; no cycles across 6,551 modules.
- `pnpm check:test-placement` — passed across 509 directories.
- `git diff --check` — passed; no unresolved merge conflicts.
- PR #1328 was conflict-resolved, updated and merged separately, then pulled here. Follow-up publication uses Harry19081, with attribution to Chloe-JY’s earlier cleanup.

```sh
pnpm test src/hooks/ui \
  src/modules/MainApp/AgentOrgs/config/osAgent/useAgentConfigBase.test.ts \
  src/modules/MainApp/AgentOrgs/config/sdeAgent/useSdeAgentConfig.dependencies.test.ts \
  src/modules/shared/dataSource/TeamRuntimePanel.test.ts \
  src/modules/shared/dataSource/BuilderProfilePanel.test.ts \
  src/engines/SessionCore/rendering/props/__tests__ \
  src/engines/SessionCore/rendering/registry/__tests__/contextConfigBoundary.test.ts \
  src/engines/ChatPanel/ChatHistory/projection/__tests__/workerStaticGraph.test.ts \
  src/engines/ChatPanel/ChatHistory/hooks/__tests__/chatSearchProjection.test.ts \
  src/config/languageMap.presentation.test.ts \
  src/features/Organizations/sessionOrgScope.sidebar.test.ts \
  src/app/root/__tests__/startupGraph.test.ts \
  src/app/root/__tests__/featureBoundaries.test.ts
```

## Publication integration checks

- Base refreshed to `e11b6f407`; production AST comparison against that base found no executable changes across 167 modified production TypeScript files, and no references to the 34 removed TypeScript modules.
- `pnpm test src/modules/WorkStation src/scaffold/NavigationSidebar src/engines/ChatPanel/ChatHistory/hooks src/app/root/__tests__` — 214 files / 1,328 tests passed after integration.
- `pnpm typecheck:fast` and `cargo check --manifest-path src-tauri/Cargo.toml -p agent_core -p org2 --tests` — passed after integration.
- `pnpm check:circular` — zero cycles across 6,568 modules after integration.
- ESLint and Prettier passed on the three resolved/new consumer files. `git diff --check` passed.
- The complete frontend suite and focused Rust tests recorded above preceded the latest develop integration; affected checks were rerun as listed here.
