# Issue #425 shell replay architecture audit

Scope: integrated Rust `run_shell`, external CLI/provider shell ingestion, EventStore/Snapshot persistence, append-only replay artifacts, range RPC, Session Replay/Chat rendering, deletion/recovery, and the test/build paths changed for #425.

## Outcome

The implementation now has one bounded-memory contract across the stack:

- the integrated executor reads with fixed 16 KiB buffers, passes chunks through a bounded channel, and writes complete output directly to a versioned `.slog` artifact;
- EventStore and each Snapshot retain only a 32 KiB preview, an immutable sequence/byte bookmark, status, and an exact `(sessionId, callId)` replay reference;
- tool results retain a bounded head/tail summary instead of the complete transcript;
- the browser stores replay payloads only in one process-wide 1 MiB LRU and keeps only cache keys/offsets in React state;
- both the Rust range reader and TypeScript renderer clamp data to the selected Snapshot bookmark;
- completed external CLI shell events are imported before EventStore compaction, so removing their inline payload cannot create an empty Shell card;
- replay cleanup is queued durably before Session deletion and retried only after both possible owner rows are absent.

No production path still calls the retired “update the last shell” RPC or guesses ownership from the most recent event. Snapshot playback remains event-index based; storage ranges are not exposed as a playback or pagination model.

## Acceptance criteria

- [x] No unbounded integrated-executor stdout/stderr `String`.
- [x] Fixed 16 KiB reads and bounded writer channel.
- [x] Complete incremental artifact plus 32 KiB Snapshot/EventStore preview.
- [x] Bounded approximately 30 KiB tool summary.
- [x] Exact `sessionId + callId` attribution at writer, event, RPC, and cleanup boundaries.
- [x] `await_output` reads a bounded replay tail; it does not read a complete `.slog`.
- [x] Snapshot sequence and byte bookmarks are enforced in Rust and TypeScript.
- [x] Playback does not wait for range RPC; initial preview is synchronous and prefetch settles after 100 ms.
- [x] Stale requests are generation-guarded; range payload cache is globally bounded to 1 MiB.
- [x] External CLI result survives parser to EventStore compaction.
- [x] Completion, cancellation, timeout, kill, writer failure, and recovery cannot report an incomplete replay as complete.
- [x] Session deletion failure leaves an exact durable cleanup job for retry.
- [x] Default-parallel executor, replay, and external-import test groups pass without HOME/SQLite races or nested-lock deadlock.
- [x] The complete Rust workspace passes serially with an isolated application HOME.
- [x] macOS fast application bundle builds successfully.
- [ ] Windows runtime execution awaits the new Windows CI job; Windows-specific commands compile in the workspace check but cannot be executed on this macOS host.

## Ten-layer audit

| Layer                        | Coverage                                                                                 | Verdict                              | Evidence / decision                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Compilation               | Rust workspace/all targets, TypeScript, formatting, lint, circular dependencies          | pass with repository-baseline caveat | `cargo check --workspace --all-targets`, complete serial `cargo test --workspace`, `pnpm typecheck`, `pnpm lint`, `pnpm check:circular`, `cargo fmt --all -- --check`, and the fast app build pass. Advisory workspace Clippy exits successfully; strict `-D warnings` remains blocked by pre-existing warnings in unrelated crates. |
| 2. Dead code and duplication | old replay writers, RPCs, UI buffers, schema ownership                                   | pass                                 | Removed the old terminal log implementation, duplicate `TerminalPanel`, 500 KiB shell accumulator path, `shell_replay_get_meta`, and the former last-shell update route. Replay DDL now has one canonical owner in `database::shell_replay_schema`.                                                                                  |
| 3. Naming                    | replay, bookmark, range, page, Snapshot                                                  | pass                                 | Public UI/API uses `readRange`, not “page”; page is confined to the disk index. `visibleThroughSequence` and `visibleBytes` state exactly what the watermark means.                                                                                                                                                                  |
| 4. Semantic overloading      | Session, Snapshot, replay status, storage page                                           | pass                                 | A Session owns commands; a Snapshot is one immutable timeline view; replay status describes artifact integrity; a storage page is only an index record. None is used as another concept's progress value.                                                                                                                            |
| 5. Default branches          | unknown/corrupt status, missing output, write failure, stale requests                    | pass                                 | Unknown manifest status and crash recovery fail closed to `incomplete`; an unbacked external event keeps a bounded preview and explicit error; stale async responses are discarded instead of applied to a new cursor.                                                                                                               |
| 6. Cross-domain leakage      | database, executor, EventStore, UI                                                       | pass                                 | Leaf `database` owns DDL; `agent_core` owns artifact semantics; Tauri exposes one bounded range command; React owns only presentation/cache. No frontend component knows artifact paths or SQLite pages.                                                                                                                             |
| 7. New-developer clarity     | types, comments, entry-point behavior                                                    | pass                                 | Writer, bookmark, request guard, cache budget, completion barrier, external import, and cleanup queue carry invariant comments. The critical constants are named and colocated with their implementation.                                                                                                                            |
| 8. Wire protocol             | live output event, Snapshot state, RPC schemas, real serialized limits                   | pass                                 | Events carry exact Session/Call, sequence, persisted bytes, stream, and chunk. Range requests include both bookmark dimensions and are capped at 256 KiB. The frontend re-filters every returned frame. Full output is absent from new EventStore events.                                                                            |
| 9. Init parity               | production startup, integrated writer tests, App ingestion tests, recovery, external CLI | pass                                 | Production creates tables through the canonical session schema; lower-layer tests call the same leaf initializer inside the canonical test sandbox; App tests register their normal schema hook. Startup recovers torn writers, then retries eligible cleanup jobs.                                                                  |
| 10. Resolver symmetry        | ownership and bookmark resolution                                                        | pass                                 | Integrated and external paths resolve replay identity from the same `(sessionId, callId)` pair. Sequence and byte watermarks travel together and are both min-clamped against the authoritative manifest and again in the client.                                                                                                    |

## Init parity matrix

| Entry point                          | Canonical schema                       | Exact replay identity              | Bounded payload                                                        | Final/recovery state                                                         |
| ------------------------------------ | -------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Integrated blocking/background shell | app schema dispatcher                  | `CallContext.session_id + call_id` | 16 KiB frames; 32 KiB preview; 30 KiB result                           | completion barrier finalizes or marks incomplete                             |
| Integrated PTY shell                 | app schema dispatcher                  | `ExecIdentity(sessionId, callId)`  | bounded broadcast/capture and same writer                              | capture/supervisor failures mark exact replay incomplete                     |
| External CLI/provider ingestion      | app schema dispatcher                  | normalized event Session + call ID | existing parser payload is streamed to 16 KiB frames before compaction | complete import or explicit bounded incomplete fallback                      |
| Agent-core unit tests                | `test_env::sandbox` + leaf initializer | unique test call IDs               | production constants                                                   | default-parallel groups verified                                             |
| App ingestion/EventStore test        | registered App test schema hook        | raw chunk call ID                  | 96 KiB fixture compacted after import                                  | complete replay asserted after EventStore append                             |
| Startup                              | initialized application database       | manifest Session + call ID         | scans one bounded frame at a time                                      | torn data truncated and marked incomplete; cleanup retried after owner check |

## Fallback and failure matrix

| Condition                            | Artifact                                         | EventStore/Snapshot                     | User-visible result                                   |
| ------------------------------------ | ------------------------------------------------ | --------------------------------------- | ----------------------------------------------------- |
| Normal running command               | append-only, flushed at 64 KiB or 50 ms          | running preview + bookmark              | immediate current tail                                |
| Normal completion                    | synced and indexed                               | final complete bookmark                 | full range becomes available                          |
| Cancel/kill/timeout/write failure    | synced as far as recoverable                     | `incomplete` with error                 | bounded preview plus explicit error; never “complete” |
| External CLI import failure          | original source transcript remains authoritative | bounded incomplete replay state         | non-empty Shell card with failure explanation         |
| Historical log without old bookmarks | final log may be imported                        | early Snapshots keep their own previews | no future-output leakage                              |
| Range RPC failure                    | durable data remains on disk                     | Snapshot preview remains                | “Replay unavailable”; playback remains responsive     |
| Session deletion file failure        | manifest and cleanup job retained                | Session deletion is not rolled back     | startup retries exact safe path                       |

## Systematic sweeps

- `es_update_last_shell_output`, `update_last_shell_output`, and “last shell output” production references: none remain.
- Complete `.slog` reads via `read_to_string`: none in the executor/replay path.
- Replay table DDL: one canonical definition.
- Production replay meta RPC: removed; the private Rust metadata type remains internal to range/recovery logic.
- 500,000-character constants that remain belong to assistant/thinking streams or the user-operated interactive terminal, not Agent Shell Session Replay.
- Every test in the external-import module that mutates HOME now acquires the canonical lock exactly once through `HomeEnvGuard`.
- Every legacy `ExecTool` test that starts an integrated shell now uses the canonical test sandbox.

## Verification record

- Frontend: 500 Vitest files / 5,352 tests passed; focused shell replay tests 26/26 passed; RPC schema tests 8/8 passed.
- Rust #425 surface: executor/replay group 51 passed, 2 intentionally ignored stress tests; external-import group 23/23 passed; parser-to-EventStore external replay test passed; schema and deletion/recovery tests passed.
- Complete Rust workspace: all enabled tests passed serially with an isolated temporary application HOME. The run also exposed and fixed stale CLI managed-config classification plus a Linear OAuth loopback test that was inheriting the host HTTP proxy; its five callback cases now pass with an explicit direct loopback client and graceful response shutdown.
- Stress: real 10 MiB subprocess passed; repeated 10 MiB RSS test passed with a 376,832-byte post-warmup peak delta, far below the 64 MiB acceptance ceiling.
- Rendered macOS E2E: 2/2 passed, including visible early/middle/final sentinel isolation, play/pause, 2x playback, and 16 ms scrub cadence.
- Build: `artifacts/ORG2-fast.app` produced successfully by `pnpm tauri:build:fast`.

The remaining platform limitation is execution, not a known failure: Windows-specific replay behavior cannot run on this macOS host and is covered by the new Windows CI job. Tests that bind localhost must be run with local-port permission; the complete isolated run did so and passed.
