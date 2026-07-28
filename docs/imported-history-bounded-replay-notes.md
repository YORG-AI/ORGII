# Imported-history bounded replay — shared pattern notes (#443)

Status as of 2026-07-28. Companion to issue #443. This documents the pattern
Codex now implements end-to-end, so every other loader can follow it instead
of reinventing (or silently falling back to full hydration).

## The three-tier contract

Every imported source serves session content in three tiers. **RAM and IPC
are bounded at every tier regardless of source size.**

| Tier               | What                                                                                                           | Size budget        | When loaded                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------ |
| 1. Round skeleton  | One user-bubble chunk + one `unloadedTurn` placeholder chunk per round, plus `ProjectedTurnMetadata` per round | ~1 KB/round        | Always, on open                                              |
| 2. Hydrated rounds | Full chunks for one round                                                                                      | bounded by round   | Recent tail on open; older rounds on click / page-navigation |
| 3. Payload details | Full tool outputs / file bodies                                                                                | 256 KB range reads | Only on expand (future work — previews + locators)           |

### Why the skeleton must be complete

A 100+ round session that ships only the hydrated tail renders as "2–3
rounds" with **no signal that older rounds exist** (the exact complaint that
triggered this note). The frontend machinery for collapsed round cards and
on-demand hydration is already **source-generic** and driven purely by the
placeholder chunks — if the skeleton arrives, everything works:

- `useChatGroupsProjection.ts` lifts `result.unloadedTurn` into group meta
- `GroupHeaderRenderer.tsx` renders the collapsed card; click → hydrate
- `turnLoaderRegistry.ts` dispatches per-source turn loading
- `useTurnPageSelection.ts` auto-hydrates the current page

A new source only implements the **backend** side; zero new frontend code
per source (one remaining exception noted below).

## The append-only JSONL playbook (Codex — done; Claude Code — next)

1. **Reverse scan for all round boundaries** (`find_recent_codex_user_offsets`
   pattern): walk backwards in 256 KB blocks, cap carried suffix at 4 MB,
   collect byte offsets of round-starting lines up to a per-session turn
   limit (4096).
2. **Lazy turn ids encode the byte offset** (`codex-user-<offset>`): any turn
   is directly seekable later without an index lookup; the in-memory offset
   cache is an optimization, not a correctness requirement.
3. **Initial window = full skeleton + hydrated tail**: for every older
   round, seek to its offset, read just the round-header line(s), emit
   `user_message_chunk` + `build_unloaded_turn_placeholder_chunk`; then
   hydrate only the last N rounds fully.
4. **Turn window = seek + parse one round** (stop at next round boundary).
5. **Inert-line sniff** (`codex_line_is_transcript_inert` pattern): probe the
   line with borrowed `&str` + `RawValue` (serde_json `raw_value` feature)
   and skip transcript-inert types **before** building any `serde_json::Value`.
   Codex skips outer `compacted`/`session_meta` and payload
   `token_count`/`image_generation_end`. Measured on a real 335 MB rollout:
   65.7% of bytes were `compacted` lines. Keep the skip **transcript-path
   only** — the metadata/usage reader still needs `token_count`.
6. **Conservative on ambiguity**: probe failures fall through to the normal
   parse. Behavior must be byte-identical for everything not on the explicit
   skip list (see `codex_inert_lines_do_not_change_parsed_chunks`).

### Claude Code specifics (next port)

- Storage: `~/.claude/projects/<slug>/<session>.jsonl`, append-only, one JSON
  object per line with a top-level `type` field — same shape class as Codex.
- Round boundary: `type:"user"` lines, **but** Claude Code also writes tool
  results as `type:"user"` entries (tool_result content blocks). The reverse
  scanner must reuse the loader's existing real-human-prompt classification
  when detecting boundaries, not just the type field.
- Inert candidates for the sniff-skip: `custom-title`, `ai-title`, `mode`,
  `queue-operation`, and `system` lines the transcript path drops today —
  verify against the dispatch before listing them.
- Entry point today: `load_claude_code_history_for_session`
  (`sources/claude_code/history.rs`) — full load only, used for both preview
  and full transcript. Needs the initial-window/turn-window split and a
  descriptor flip to `supportsWindowedReplay: true`.

## Storage-family playbooks for the rest

- **Append-only JSONL** (codex ✅, claude_code, cursor_cli, opencode,
  mimo_code via opencode-compat, qoder_cli, omp): playbook above.
- **SQLite / record stores** (cursor_ide ✅ has its own window machinery,
  trae, warp, qoder, windsurf, zcode): no byte offsets — stable row
  keys/sequences + a DB fingerprint for invalidation; skeleton = one
  aggregate query over round-boundary rows; turn window = `WHERE` on the
  round's key range; delta = `WHERE key > last_seen`.
- **Whole-document JSON** (cline, workbuddy): re-index on change with a
  streaming reader; materialize only boundaries + previews, never the whole
  document as one `Value`.

All sources share the chunk builders in `imported_history/mod.rs`
(`user_message_chunk` / `assistant_message_chunk` / `thinking_chunk` /
`tool_call_chunk`) — canonical single-copy fields as of #443:
tool → `output`, assistant → `observation`, thinking → `thought`. Do NOT
reintroduce mirror fields; readers have fallbacks.

## Known remaining gaps (in priority order)

1. **Claude Code port** (biggest real-world files after Codex).
2. **Round-index wire + pagination generalization**: `CodexAppInitialWindow.turns`
   is still `#[serde(skip_serializing)]`, and
   `ChatHistory/index.tsx` + `useChatTurnPagination.ts` gate turn summaries
   on `isCursorIde` (and hardcode the `cursoride-user-` prefix). Generalize
   so the round selector shows "Round N of 179" for every windowed source.
3. **Persisted turn index**: the offset cache is in-memory (LRU 8 files);
   first open after app restart re-runs the reverse scan. Persist next to the
   imported-history session cache, invalidated by file signature.
4. **Payload previews + locators (Tier 3)**: bound `tool_call_chunk` output
   at the builder with a locator for range reads; requires a generic
   `read payload range` command. Until then hydrated rounds can still be
   heavy if a single round contains a huge output.
5. **Collapse the `es_process_chunks` round trip** (#443 core): normalize in
   Rust, ship only windows/deltas; convert Raw view / Fork / Cloud sync to
   range or streamed reads.
6. Dead code to remove once (1) lands: `CodexTranscriptCollectionMode::Initial`
   compaction path (`transcript.rs` `compact_completed_turn`) — only
   reachable for user-message-free rollouts now.

## Measured baselines (real fixtures, keep for regression comparison)

335 MB Codex rollout (179 rounds, 65.7% `compacted`, full-load path,
release build):

|                        | HEAD 2026-07-28 | after #443 dedup + sniff |
| ---------------------- | --------------- | ------------------------ |
| chunks                 | 17,152          | 17,152 (identical)       |
| serialized chunk bytes | 223.7 MB        | 92.5 MB (−59%)           |
| parse time             | 965 ms          | 875 ms                   |

Opt-in perf harness: `codex_parse_real_rollout_fixture_stats` in
`codex/app_tests.rs` — set `ORGII_CODEX_ROLLOUT_FIXTURE=/path/to/rollout.jsonl`,
run with `--ignored --nocapture --release`.
