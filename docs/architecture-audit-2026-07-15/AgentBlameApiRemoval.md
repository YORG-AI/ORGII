# Agent Blame API removal architecture audit

**Scope:** End-to-end removal of the five RPCs formerly consumed only by `AgentBlamePanelView`: scan start, scan status, scan cancel, index read, and file-session lookup.

## Acceptance criteria

- [x] No frontend wrapper, RPC procedure, Zod input/output schema, Tauri registration, or Rust command remains for the five removed APIs.
- [x] No API-only Rust helper, projection type, test, cancel marker, or options relay remains.
- [x] Shared orgtrack export, sync, index generation, and file timeline behavior remains available to its live callers.
- [x] TypeScript typecheck and targeted ESLint pass.
- [x] Rust formatting, library compilation, and focused orgtrack tests pass.

## Removed call chains

| Frontend wrapper             | Tauri command                   | Rust/API-only implementation removed                                       |
| ---------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `startOrgtrackScan`          | `orgtrack_scan_start`           | Background scan launcher and public `OrgtrackScanOptions` relay            |
| `getOrgtrackScanStatus`      | `orgtrack_scan_status`          | Scan-progress reader endpoint                                              |
| `cancelOrgtrackScan`         | `orgtrack_scan_cancel`          | Cancel request helper, cancel-marker path, and cancellation guards         |
| `getOrgtrackIndex`           | `orgtrack_get_index`            | Standalone index reader endpoint                                           |
| `lookupOrgtrackFileSessions` | `orgtrack_lookup_file_sessions` | File-session aggregation projection, projection types, and projection test |

## Ten-layer audit

| Layer | Coverage                               | Verdict                                                                                                                                                                                                                                                                   |
| ----: | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Compilation correctness                | `tsc --noEmit`, targeted ESLint, `rustfmt --check`, and `cargo check --lib` pass. The focused orgtrack test filter passes 5/5 tests. Strict Clippy was attempted and is blocked by six pre-existing findings in untouched orgtrack-core files; none point to this change. |
|     2 | Dead code and structural deduplication | Traced each frontend entry point through RPC registration and Tauri dispatch. Removed the orphaned background launcher/status/cancel helpers, standalone index reader, file-session projection/types/test, cancel path, and the now-single-caller options relay.          |
|     3 | Naming consistency                     | Repository-wide sweeps return zero hits for all five frontend wrapper names and command strings. Remaining `orgtrack` index/timeline names belong to live export, sync, and editor-timeline flows.                                                                        |
|     4 | Semantic overloading                   | `scan` now refers only to synchronous export progress/checkpoint internals; it no longer also denotes a user-controlled background RPC lifecycle. `index` remains the generated repo-sync projection and sync response type.                                              |
|     5 | Default branches                       | Deleted the API defaults for `resume`, `rebuild`, and trajectory scan start. The remaining synchronous export path directly expresses its established resume behavior instead of routing fixed values through an options struct. No new catch-all branch was added.       |
|     6 | Cross-domain leakage                   | Agent Blame-specific API controls no longer leak into the shared lineage RPC surface or repo-sync public types. Shared orgtrack primitives required by other features were retained.                                                                                      |
|     7 | New-developer clarity                  | There is no longer a public scan-control API without a UI owner, and no `OrgtrackScanOptions` type suggesting configurable callers that do not exist.                                                                                                                     |
|     8 | Wire protocol                          | The five Tauri IPC command registrations and their Zod wire contracts were removed together. No HTTP, WebSocket, or external serialized payload changed.                                                                                                                  |
|     9 | Initialization parity                  | The removed commands were query/control endpoints, not app/session initialization entry points. The live `orgtrack_initialize` and `orgtrack_export` entry points still share `export_orgtrack`.                                                                          |
|    10 | Resolver symmetry                      | No multi-source resolver or fallback chain is involved in the removed call paths. The surviving export path has one direct tier input and one checkpoint source.                                                                                                          |

## Intentionally retained live surfaces

- `orgtrack_initialize` and `orgtrack_export` for synchronous metadata export.
- `orgtrack_sync_core_repo` and `OrgtrackIndex` for repo synchronization.
- `orgtrack_get_file_timeline` for editor timeline attribution.
- Internal scan progress/checkpoint structures used while producing exports.

No compatibility shim or deprecated alias was added for the removed commands.

## Existing verification debt

`cargo clippy --lib -- -D warnings` currently fails on six unrelated pre-existing findings in `canonical.rs`, `privacy/mod.rs`, and imported-history source parsers. They were left untouched to keep this removal scoped and avoid mixing an unrelated cleanup into the API deletion.
