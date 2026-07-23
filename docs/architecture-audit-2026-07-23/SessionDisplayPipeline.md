# Architecture Audit — Session display pipeline

## Acceptance checklist

- [x] Cloud/local hover, cloud/local/imported Kanban, and cloud/local sidebar rows use one display resolver.
- [x] Kanban Board, List, Diary, header options, and active filtering consume the same projected task identity.
- [x] Kanban and Sidebar mount through the same cache-aware, process-wide roster coordinator.
- [x] A live Codex App row and its imported replay resolve the same label, icon, agent type, and source model.
- [x] Imported replay source metadata survives full imports, cursor no-ops, metadata-only updates, local session persistence, and guest-registry restore.
- [x] `Session.model` remains unset for imported replays so source presentation cannot become fork execution authority.
- [x] Legacy imports still resolve external-app branding from provenance alone.
- [x] Unknown/legacy wire agent aliases remain displayable but are not accepted as runnable `CliAgentType` values.
- [x] Duplicate Kanban identity resolvers are removed.
- [x] The issue class was swept across session Kanban and hover presentation paths.
- [x] Targeted tests and changed-file lint pass.
- [x] Repository-wide typecheck is clean on the PR branch.

## Term overloading

| Term                                      | Meaning                                                             | Owner                        |
| ----------------------------------------- | ------------------------------------------------------------------- | ---------------------------- |
| `Session.model`                           | Runnable model selected for a local session/fork                    | Session execution            |
| `SessionImportedFrom.sourceDisplay.model` | Read-only model name reported by the source session                 | Collaboration provenance     |
| `agentType`                               | Raw presentation value, including legacy wire aliases               | Display resolver             |
| `cliAgentType`                            | Validated local CLI type used by filters and runnable configuration | Session/runtime types        |
| `agentIconId`                             | Resolved UI icon/provider identifier                                | Display resolver             |
| `externalHistorySource`                   | Source-app provenance for imported history                          | External-history descriptors |

The critical separation is deliberate: source display data never populates runnable session configuration.

## Ten-layer audit

| Layer                      | Coverage                                                                                                                                                                                           | Verdict |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1. Compilation             | Changed-file ESLint, 114 targeted tests, and full `tsc --noEmit` pass on the isolated PR worktree.                                                                                                 | Pass    |
| 2. Dead code/deduplication | Removed `kanbanAgentBranding.ts`; deleted local/remote Kanban, hover, sidebar, List, and filter reinterpretation branches. Row helpers now only adapt the canonical result to component contracts. | Pass    |
| 3. Naming                  | Added `SessionSourceDisplayMetadata`, `sourceDisplay`, `SessionDisplayMetadata`, raw `agentType`, and validated `cliAgentType`. Names state purpose and trust level.                               | Pass    |
| 4. Semantic overloading    | Kept source model/agent identity under import provenance; did not reuse `Session.model` or executable account/key fields.                                                                          | Pass    |
| 5. Defaults                | External descriptor wins, then source display name/type, then honest `Agent`; icon falls through external source, provider, built-in ORGII, imported-native ORGII, then existing session fallback. | Pass    |
| 6. Cross-domain leakage    | Collaboration import stores source facts only. The UI resolver owns labels/icons. Fork/runtime code continues to read executable `Session` fields.                                                 | Pass    |
| 7. New-developer clarity   | Type comments and the import-site comment explain why two model fields exist and which one is executable.                                                                                          | Pass    |
| 8. Wire/serialization      | `RemoteTeammateSessionMetadata` wire shape is unchanged. New provenance fields are optional local metadata; guest zod persistence mirrors them and now also retains the adjacent avatar field.     | Pass    |
| 9. Entry-point parity      | Full import and every existing-replay no-op path refresh the same source metadata; member/guest import paths share `importRemoteSession`; Kanban/Sidebar mounts share `loadSessionRoster`.         | Pass    |
| 10. Resolver symmetry      | All session display consumers resolve label/icon/type/model once; all Kanban modes and filters then consume the same task projection.                                                              | Pass    |

## Entry-point matrix

| Path                   | Input                                          | Persistence/normalization                        | Display consumer          |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------ | ------------------------- |
| Live teammate hover    | `RemoteTeammateSessionMetadata`                | Remote branch of shared resolver                 | `CloudSessionHoverCard`   |
| Live teammate Kanban   | `RemoteTeammateSessionMetadata`                | Remote branch of shared resolver                 | `cloudRemoteToKanbanTask` |
| Imported replay hover  | Local `Session` + `importedFrom.sourceDisplay` | Local branch of shared resolver                  | `SessionHoverCardContent` |
| Imported replay Kanban | Local `Session` + `importedFrom.sourceDisplay` | Local branch of shared resolver                  | `sessionToKanbanTask`     |
| Local sidebar row      | Local `Session`                                | Local branch of shared resolver                  | `resolveSessionRowIcon`   |
| Cloud sidebar row      | `RemoteTeammateSessionMetadata`                | Remote branch of shared resolver                 | `cloudSessionsSection`    |
| Kanban filters         | Projected `KanbanTask`                         | `resolveKanbanAgentFilter` during task creation  | Header + Board/List/Diary |
| Full replay import     | Remote metadata                                | Stores `sourceDisplay` after durable event write | Both local consumers      |
| Cursor/metadata no-op  | Remote metadata + existing replay              | Refreshes presentation without refetching events | Both local consumers      |
| Guest cold restore     | Guest registry zod payload                     | Restores `sourceDisplay` and owner avatar        | Both local consumers      |

## Resolver fallback matrix

| Field              | Live remote                                                              | Imported local replay                                                                | Ordinary local session                                         |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| External source    | `origin.source`, then session-id descriptor prefix                       | `importedFrom.externalHistorySource`, then source/session-id descriptor prefix       | Session-id descriptor prefix                                   |
| Agent label        | external descriptor → source display name → formatted raw type → `Agent` | same, reading `sourceDisplay` before replay placeholders                             | configured display name → formatted type → `Agent`             |
| Agent icon         | external descriptor → provider → built-in ORGII → existing fallback      | same, with imported-native ORGII fallback instead of the unregistered archive marker | provider → built-in ORGII → configured/session-prefix fallback |
| Raw agent type     | remote metadata                                                          | `sourceDisplay.cliAgentType` before local field                                      | local field                                                    |
| Validated CLI type | parsed from raw value                                                    | parsed from raw value                                                                | parsed from local value                                        |
| Model label        | remote metadata                                                          | `sourceDisplay.model` before local field                                             | local runnable model                                           |

## Systematic sweep

The reported class was “parallel session roster and identity projection.” The sweep covered both Kanban projections, Board/List/Diary rendering, header/filter derivation, both hover-card variants, local/cloud sidebar rows, collaboration import persistence, guest restore, external-history descriptors, and mount-time roster loading. Agent Team and benchmark precedence now lives in `resolveSessionDisplayMetadata`; `resolveSessionRowIcon` is only a renderer adapter.

## Performance guard

| Lifecycle              | Before                                                             | After                                                  | Verification                      |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------- |
| Kanban mount           | Forced a roster refresh even when Sidebar had just loaded it       | Cache-aware `loadSessionRoster()`                      | Coordinator and alias tests       |
| Sidebar mount          | Forced a roster refresh on each mount                              | Same cache-aware `loadSessionRoster()`                 | Source sweep + focused tests      |
| Concurrent mount       | Could escalate into a second forced pass depending on effect order | Identical requests join the process-wide single flight | `loaders.test.ts`                 |
| Hidden                 | Kanban clock and cloud roster already pause while hidden           | Unchanged                                              | Existing lifecycle tests          |
| Repeated tab switching | Forced mount reads bypassed the five-minute cache                  | Bounded by the shared cache window                     | Loader behavior + call-site audit |

Performance verdict: pass. No new timer, subscription, retained cache, full-history load, or parallel scan path was added.
