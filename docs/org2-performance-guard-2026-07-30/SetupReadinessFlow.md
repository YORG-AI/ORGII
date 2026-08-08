# ORG2 Performance Guard — Setup Readiness Flow

**Verdict:** pass

| Surface                 | Trigger                                | Bound                          | Idle/hidden behavior                            | Coalescing/lifecycle                                                                                         |
| ----------------------- | -------------------------------------- | ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Tool detection          | Explicit “Detect tools” click          | Three fixed providers          | No work                                         | Controller admits one foreground operation                                                                   |
| Codex history import    | Explicit “Import Codex history” click  | `codex_app` only               | No new scheduler                                | Reuses module-global rescan batching/single-flight                                                           |
| Repo scope detection    | Explicit “Detect repo scope” click     | Current workspace folder count | No work                                         | Reuses bounded 256-entry resolver LRU and per-path in-flight map                                             |
| Cloud create/join       | Explicit submit                        | One org mutation               | No polling                                      | Reuses auth refresh CAS and serialized roster convergence                                                    |
| Policy save             | Explicit submit                        | One org, current scope array   | No work                                         | UI single-flight; existing server RPCs are idempotent replacements                                           |
| Member/admin sync check | Explicit verify/save                   | One selected org               | Existing engine lifecycle applies               | Reuses serialized sync-pass drain                                                                            |
| Tutorial launch         | Explicit final completion              | One one-shot 250ms handoff     | Timer is not recurring and dies after dispatch  | No retained cache/subscription                                                                               |
| Setup test shortcut     | Native menu accelerator + DOM fallback | One exact chord/event          | All listeners are passive until the exact event | One Tauri, window, and document listener per mounted window; every listener is removed/unlistened on unmount |

No polling loop, interval, worker, unbounded cache, full-provider scan, or
hidden-window background task was added. The shortcut listeners do no I/O
unless the exact chord or native-menu event matches, share one in-flight gate,
and are all removed on unmount. An async native-listener registration that
finishes after unmount immediately unregisters itself. Unmount guards prevent
late foreground operation results from writing component-local error/loading
state. Durable domain writes remain safe after unmount.
