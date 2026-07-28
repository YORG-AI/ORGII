# Imported-history bounded replay — shared pattern notes (#443)

Status as of 2026-07-28. Companion to issue #443. This documents the pattern
Codex now implements end-to-end, so every other loader can follow it instead
of reinventing (or silently falling back to full hydration). The phase-2/3
codex implementation first staged on `fix/443-bounded-replay-phase1` is being
re-landed on `fix/443-round-index-replay` on top of current develop; this
file rides with it. The forward plan is `## Phase 3` at the bottom.

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
4. **Payload previews + locators (Tier 3)**: folded into Phase 3 below
   (P3.2/P3.3).
5. **Collapse the `es_process_chunks` round trip** (#443 core): folded into
   Phase 3 below (P3.1/P3.4/P3.7).
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

## Phase 3 — hydration follows UI attention (frontend + wire)

Phases 1–2 bounded what the **backend** materializes. Phase 3 bounds what the
**frontend** holds and what the **wire** carries, by making both isomorphic to
the UI's own collapse hierarchy: session → round → item → payload.

The key observation: today's unit of frontend hydration is a whole round
body, but an *expanded* round still renders every item as a **collapsed
card** — title, status, duration, a few preview lines. The full `result`
payloads behind those cards are parsed into JS object graphs even though no
renderer reads them until an item is explicitly expanded. Raw text is cheap
(the Raw view holds a 200 MB transcript as one string without incident);
what explodes is turning bytes into resident per-event objects, indexes, and
DOM. So: stop hydrating details the UI hasn't asked for.

### Resident tiers (target state)

| Tier              | UI state serving it                  | Data                                                                     | Budget                    |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------ | ------------------------- |
| T1 round skeleton | collapsed round card                 | `ProjectedTurnMetadata` + user preview + last-agent preview (exists)     | ~1 KB/round, always       |
| T2 item headers   | expanded round, items collapsed      | per-event header: type, function, title, status, counts, bounded preview, `payloadLocator` | ~200 B/item, open rounds  |
| T3 item payloads  | explicitly expanded item             | full `result` for that one event                                         | pull-only, LRU 16×256 KB  |
| Live tail         | streaming round                      | full inline events (naturally bounded by recency)                        | exempt from T2/T3 split   |

JS residency for the 335 MB / 179-round fixture becomes: ~200 KB skeletons
+ sub-MB headers (≤ `MAX_LOADED_HISTORICAL_TURN_BODIES` rounds) + ≤4 MB
payload LRU + viewport DOM — single-digit MB, decoupled from file size,
round count, and single-round weight (three axes, three bounds:
index / subscription / LRU).

### Work items

- **P3.1 Kill the `es_process_chunks` round trip.** Imported chunks never
  enter JS: parse → normalize → store, all in Rust; the frontend receives
  only windows. Deletes the first full-session JS copy and two
  serialize/parse crossings. Backend-led; frontend deletes the
  `processChunksRust` hop in the imported adapters / turn loaders.
- **P3.2 Header/locator split on the wire.** `prepare_loaded_events`
  (own-DB) and the imported chunk builders emit item headers with a
  `payloadLocator` (byte offset+len for JSONL sources, row key for DB
  sources) instead of inline `result` bodies. Expanding a round loads
  headers-only — the existing `MAX_LOADED_HISTORICAL_TURN_BODIES` bound now
  bounds headers, ~10× lighter than bodies. First increment can ship
  without range reads: strip in Rust, refetch the whole event on expand.
- **P3.3 Pull-only payload channel.** `es_load_event_payload(session_id,
  event_id)` + per-source range read behind the locator. Frontend
  `useEventPayload(eventId)`: pending dedup (same pattern as
  `loadedTurnRegistry`), LRU + release-on-collapse, shimmer while in
  flight. Renderers keep reading only header fields in collapsed state;
  markdown/code-highlight runs only on expanded payloads, with a byte cap.
- **P3.4 Subscription/delta push.** `compute_derived` currently re-ships
  every store event on every notify. Replace with: turn index always pushed
  (tiny); `{added, updated, removed}` deltas pushed only for subscribed
  turns = viewport pages ± prefetch + explicit expands + live tail.
  Collapse/page-navigation = subscription change. Kills the
  full-reserialize-per-tick transient peaks.
- **P3.5 Replay drives hydration through the round index.** Derive a
  round time index (O(rounds), from turn metadata — no new wire) and on
  scrub map cursor time → containing round; hydrate headers for cursor ±1
  (debounced mid-drag, immediate on `endScrub`), fetch only the focused
  event's payload via P3.3. Prune protected set = scrub neighborhood ∪
  current chat page. Dragging across 179 rounds costs round headers + one
  payload, not 179 bodies.
- **P3.6 Immutable-round memoization.** A hydrated historical round never
  changes: memoize its chat-item pipeline / group projection output per
  round; streaming ticks recompute only the live tail. Derived work becomes
  O(tail), not O(store).
- **P3.7 Aux surfaces leave the object path.** Raw view: Rust serves text
  (range reads) directly — no chunk array, no JS `JSON.stringify`; copy on
  large transcripts becomes export-to-file. Fork / cloud sync /
  continuation stream Rust-side and never depend on frontend residency.

### Non-goals

- **Fine-grained list virtualization** (react-window style). Round
  pagination already bounds simultaneously-rendered items at the "round"
  granularity; per-row virtualization adds variable-height measurement,
  comment-anchor and scroll-restoration risk for marginal return once
  T2/T3 land.
- **Lazy-loading the skeleton itself.** O(rounds) metadata is the
  navigation floor for pagination, the round selector, and the replay
  timeline; at ~1 KB/round it is never the problem.

### Intended-behavior invariants (acceptance checklist)

- Collapsed round cards render identically (duration, event count, last
  agent message — all T1 data).
- Expanded rounds render every item's collapsed card identically (all T2
  data); the only observable change is one bounded fetch + shimmer when an
  item is explicitly expanded.
- Copy / export / session search never depend on what the frontend has
  resident (Rust-side, on demand).
- Auto-expand flows (e.g. failed-tool reveal) still work — they trigger a
  payload fetch, semantics unchanged.
- Replay scrubbed to any point in a 179-round session shows that round's
  activity after at most one header-window load + one payload fetch.

### Sequencing

P3.1 → P3.2 → P3.4 are structural and backend-led, in that order (P3.2
defines the header shape P3.4's deltas carry). P3.3 / P3.5 / P3.6 are
frontend and parallelize once P3.2's header shape lands. P3.7 is
independent and can ship any time. After each step, re-measure on the real
rollout fixture (parse harness above + a JS-heap snapshot before/after
open, scrub-across-session, and expand-heaviest-item).
