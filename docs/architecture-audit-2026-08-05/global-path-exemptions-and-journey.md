# Global Path Exemptions And Journey Audit

## Scope

Audited the current worktree changes for creation-page workspace linkage,
global path exemptions, Gateway session presentation, Agent Org CLI launch,
and Journey graph construction.

| Layer                 | Verdict              | Evidence                                                                                                                                                                                                           |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Compilation        | Blocked externally   | The required Docker image is available, but its offline registry cache cannot resolve `rsproxy.cn`; networked Cargo was rejected because it could download crates. TypeScript typecheck passed.                    |
| 2. Dead code          | Keep                 | `global_path_exemptions` is wired into persistence initialization, Tauri commands, structured file authorization, prompts, and CLI launch construction.                                                            |
| 3. Naming             | Keep                 | `GlobalPathExemption` identifies a durable grant; `effective_additional_dirs` identifies the launch-only merged list.                                                                                              |
| 4. Semantic overload  | Fix required for B/D | `session` is currently used for Gateway binding, browse output, canonical Journey input, and runtime conversation. A dedicated browse snapshot model is required before four-level navigation can be added safely. |
| 5. Defaults           | Keep                 | Database failures for grants fail closed. Gateway terminal summary reports unavailable rather than inventing a recent turn.                                                                                        |
| 6. Domain boundaries  | Keep                 | Forbidden-path checks remain in `SecurityPolicy`; global grants are only additional candidate roots.                                                                                                               |
| 7. Developer clarity  | Keep                 | The terminal-marker helper documents why transcript scanning cannot establish complete-turn finality.                                                                                                              |
| 8. Wire protocol      | Not applicable       | The path exemption and terminal marker changes do not introduce an external payload.                                                                                                                               |
| 9. Init parity        | Keep for E           | `global_path_exemptions::init_schema` is called by unified persistence initialization and both file tools and CLI launch read the same durable list.                                                               |
| 10. Resolver symmetry | Keep for E           | Raw-path syntax and resolved-path forbidden checks run before and after path resolution for every structured filesystem tool.                                                                                      |

## Findings

| Location                                                                  | Element                        | Verdict | Reason                                                                                                                                                                              | Suggested change                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/crates/agent-core/src/state/commands/channel_handler/slash.rs` | Gateway recent session display | fixed   | The old output derived title and likely work-item association from transcript text. The revised output uses persisted session links and the lifecycle terminal marker only.         | Keep the terminal-marker-only rule for browse leaf previews.                                                                                   |
| `src-tauri/src/orgtrack/journey.rs`                                       | Project scope selection        | blocker | It selects canonical sessions by workspace-path containment and constructs `work_item_id: None`; it therefore cannot meet canonical Agent/Topic/Work Item association requirements. | Add canonical durable project/work-item/topic/agent fields at ingestion time, then build Journey solely from those fields.                     |
| `src-tauri/crates/agent-core/src/integrations/gateway/*`                  | Four-level browse              | blocker | Current commands list and switch sessions, but no durable Workspace -> Project -> Work Item -> Session browse snapshot/cursor exists.                                               | Introduce a dedicated durable browse snapshot and cursor keyed by gateway session key, with snapshot revision and explicit numeric navigation. |
| `src-tauri/crates/agent-core/src/core/session/launch/launch_org.rs`       | Agent Org CLI member launch    | keep    | CLI member materialization uses the same `run_session` command construction path, where global grants are merged into supported CLI `--add-dir` arguments.                          | Add a Docker-backed integration test once cached dependencies are available.                                                                   |

## Required Follow-up Boundary Tests

1. Gateway browse: restart between each navigation command and assert the same snapshot/cursor is restored; assert `/new` and `/reset` delete both binding and browse state.
2. Journey: create explicit canonical agent/topic/project/work-item/session/turn records and assert no edge is produced when any required association is absent.
3. Agent Org CLI: materialize a CLI member with a global grant and assert the generated supported CLI command contains the canonical grant exactly once.
4. Security ordering: assert raw forbidden, canonical forbidden, ACL, approval, and secret-broker guards remain higher priority than global grants.
