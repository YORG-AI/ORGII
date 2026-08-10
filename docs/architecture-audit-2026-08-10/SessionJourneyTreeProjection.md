# Session Journey Tree Projection

## 10-Layer Checklist

| Layer                | Result | Notes                                                                                                                                                                                                                 |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Compilation        | Keep   | Focused Vitest and `tsc --noEmit` pass.                                                                                                                                                                               |
| 2 Call chain         | Keep   | `sessionAggregateList` -> `loadSessionJourneys` -> `buildWorkspaceProjectTree` -> `ProjectTreePage` -> `createSessionJourneyTab` -> production renderer.                                                              |
| 3 Naming             | Keep   | `ProjectSessionJourneyLike` names a read-only tree projection, distinct from the full API snapshot.                                                                                                                   |
| 4 Terms              | Keep   | A task is a durable Journey task; a fork is a durable Journey branch; neither is inferred from a work item or transcript.                                                                                             |
| 5 Defaults           | Keep   | Failed snapshot fetches remain explicit unavailable state with retry; they never become an empty Journey or a synthetic anchor. A selected fork only carries `parent_anchor_message_id` when supplied by the backend. |
| 6 Leakage            | Keep   | The model imports no renderer or backend implementation; the Tauri client remains the sole desktop command boundary.                                                                                                  |
| 7 Developer clarity  | Keep   | Tree-node fields identify the durable `sessionId`, `taskId`, `forkId`, and optional exact anchor explicitly.                                                                                                          |
| 8 Wire protocol      | Keep   | The projection consumes existing typed `journey_snapshot` fields without a new command or serialization shape.                                                                                                        |
| 9 Init parity        | N/A    | This is a read-only existing-session projection; it creates no session/runtime.                                                                                                                                       |
| 10 Resolver symmetry | Keep   | Every displayed canonical session uses the same bounded snapshot lookup; success and failure both preserve per-session state without a divergent fallback.                                                            |

## Sweep

- Searched session-row `trailingElement` and status-dot renderers. The primary sidebar session builder was the sole production path that suppressed an in-progress dot.
- Searched Project Tree and Session Journey production renderers. Forks and task checkpoints route through keyed chat-tab data to the mounted transcript renderer with exact durable message IDs; task sequences are never used as a history fallback.
