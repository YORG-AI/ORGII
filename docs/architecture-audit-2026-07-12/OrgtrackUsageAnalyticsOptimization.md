# Orgtrack Usage Analytics — Optimization Plan

**Date:** 2026-07-12
**Scope:** `orgtrack` usage/cost analytics — pricing accuracy (Tier 1) and
parse/cache correctness (Tier 2).
**Status:** Tier 1 (T1.1–T1.4) and Tier 2 (T2.1–T2.3) implemented in the working tree
(uncommitted); `cargo check`, `typecheck`, and `lint` clean. Follow-ups below are parked.

This plan targets two areas of the usage-analytics pipeline: turning token counts
into trustworthy dollar figures, and hardening the parse/cache layer so those figures
stay correct as source files change. It does **not** change the `.orgtrack` export,
impact-indexing, or commit-linking subsystems.

---

## Current state (baseline)

### Pricing

- The only costing logic lives in `src-tauri/src/agent_sessions/unified_stats/accounting.rs`.
  It uses four hardcoded per-Mtok rates (`DEFAULT_INPUT_COST_PER_MTOK = 3.0`,
  `DEFAULT_OUTPUT_COST_PER_MTOK = 15.0`, `DEFAULT_CACHE_WRITE = 3.75`,
  `DEFAULT_CACHE_READ = 0.30`).
- `resolve_model_pricing` reads a `model_pricing` SQLite table
  (`WHERE ?1 LIKE model_pattern ORDER BY length(model_pattern) DESC`), **but that table
  is never created or populated anywhere in the codebase** — so every lookup falls
  through to the four defaults regardless of model.
- Costing reads only the native `session_token_usage` table. Imported/external session
  tokens live in `imported_history_session_cache`, so those sessions almost always
  report `cost_usd = 0`.
- There is no real-vs-estimated cost distinction. `UsageSourceLabel::{Local, Pooling}`
  is derived from `KeySource` and is a **label only**, not a cost decision.
- Frontend: `$` cost is rendered **only** in the Sessions view (`session_usage_list`).
  Other Usage overview, the Cursor panel, and the CLI panel show tokens with no cost,
  even though `AggregateStats.total_cost_usd` exists on the backend.

### Parse / cache correctness

- Imported-history cache invalidation
  (`crates/orgtrack-core/src/sources/imported_history/metadata.rs`) compares
  `source_path + source_mtime_ms + source_size_bytes + source_fingerprint +
parser_version`. This is solid for Claude/Codex (title-aware fingerprints) but
  **Windsurf and OpenCode use a bare mtime string** as the fingerprint — a same-mtime
  content change can be missed.
- Cache signatures use millisecond mtime (`paths.rs::file_metadata_signature`), which
  is coarse enough to miss rapid in-place edits.
- SQLite-backed sources do not fold WAL/`-shm` sidecars into the change signature, so a
  new session written but not yet checkpointed may not invalidate the cache.
- The unified CLI scanner (`crates/orgtrack-core/src/sources/cli_session_db.rs`) uses
  hand-rolled substring JSON extraction (`extract_json_string_field` / `extract_json_i64`)
  rather than a real parser. Aider token counts are always `0` and message counts are a
  rough `lines / 4` estimate.

---

## Tier 1 — Pricing accuracy

**Goal:** every session that has tokens gets a trustworthy dollar figure, and the UI
can show recorded vs estimated cost.

### T1.1 — Bundled model-price catalog

- Add a generated catalog data file (JSON) of per-model input/output/cache-read/
  cache-write rates, plus a small loader.
- Populate the `model_pricing` table from the bundled catalog on schema init (or query
  the catalog directly and drop the dead table lookup).
- Normalize model ids before lookup (case-fold, treat `.`/`-` equivalently, strip
  date-pin and effort suffixes) so `claude-sonnet-4-5-20250101` and
  `claude.sonnet.4.5` resolve to one rate.
- Lookup order: exact id → normalized id → longest-prefix family fallback →
  mid-range default. Local/self-hosted providers price at `$0`.
- Owner: `accounting.rs`, a new `pricing_catalog` module, `crates/orgtrack-core` schema
  init, plus the catalog data file.

### T1.2 — Cost imported/external tokens

- Extend costing so `imported_history_session_cache` tokens are priced through the same
  catalog, not just `session_token_usage`. Imported sessions must stop reporting `$0`
  purely because their tokens live in a different table.

### T1.3 — Recorded vs estimated cost

- Carry two cost figures per aggregate session: **recorded** (real metered spend) and
  **estimated** (tokens × catalog list price). For subscription/own-key routes with no
  metered cost, recorded is `$0` and estimated is the list-price figure.
- Decide recorded-vs-estimated per route where the information exists (metered API key
  vs subscription/OAuth login), rather than a cosmetic local/pooling label.
- Expose both on `AggregateStats` / `UsageRecord` and the `orgtrack_*` command payloads.

### T1.4 — Surface cost in every usage view (frontend)

- Add a cost column and a `$` / tokens toggle to the Other Usage overview, Cursor panel,
  and CLI panel (`src/modules/MainApp/DevRecord/views/OtherUsageView/*`).
- For token-only sources, default the toggle to the estimate with an `ESTIMATED` marker,
  matching the existing Sessions-view cost formatting.
- Extend the frontend types (`src/api/tauri/orgtrackHistory/types.ts`) with the
  recorded/estimated cost fields.

---

## Tier 2 — Parse / cache correctness

**Goal:** cached rollups never go stale silently, and CLI parsing is robust.

### T2.1 — Stronger cache fingerprints

- Move cache signatures to nanosecond mtime granularity.
- Fold SQLite WAL/`-shm` sidecars into the change signature for db-backed sources so a
  not-yet-checkpointed write invalidates the cache.
- Replace the bare-mtime fingerprints for Windsurf and OpenCode with content-aware
  fingerprints (e.g. row counts / latest-updated markers), consistent with the
  Claude/Codex approach.
- Owner: `imported_history/metadata.rs`, `imported_history/cache.rs`, `paths.rs`,
  `sources/windsurf/history.rs`, `sources/opencode/history.rs`.

### T2.2 — Robust CLI parsing

- Replace the hand-rolled substring JSON extraction in `cli_session_db.rs` with real
  `serde_json` parsing per tool.
- Fix Aider token accounting (currently always `0`) and replace the `lines / 4` message
  estimate with an actual count where the format allows.

### T2.3 — Token-accounting quirk verification

- Verify per-source token accounting handles known edge cases without double-counting:
  resumed/forked session overlap, cumulative-counter deltas with context-compaction
  resets, and multi-record dedup. Document confirmed-correct vs fixed per source.

---

## Discovered follow-ups (parked)

Surfaced during T2.3 verification and the pricing work; not fixed under this pass:

- **FU1 (high) — Claude resume/fork double-count.** Claude sessions are cached with
  `parent_session_id: None` and no cross-file message-`uuid` dedup, so `--resume`/fork
  transcripts (which replay prior turns with the same usage into a new JSONL) are
  counted twice. Pricing makes this visible in dollars — highest-value next fix.
  Owner surface: `crates/orgtrack-core/src/sources/claude_code/history.rs`,
  `.../imported_history/cache.rs`.
- **FU2 — Codex compaction-reset undercount.** Last-wins on the cumulative
  `total_token_usage` drops pre-compaction tokens if Codex resets after a context
  compaction (undercount, not double-count).
- **FU3 — Cursor `state.vscdb` sidecar folding.** The nanosecond/WAL fingerprint helper
  (`sqlite_sidecar_signature`) exists and is adopted by OpenCode/Windsurf; Cursor's
  `cursor_ide/db.rs` reader has not yet adopted it.
- **FU4 — Per-session recorded cost in the detail command.** The single-session
  `session_usage_summary` path has no route context, so it reports `recorded = $0` /
  `estimated = list price`. Aggregate/heatmap/usage-list paths are route-aware.

## Out of scope

- `.orgtrack` on-disk export, reachability, git-blame, and sync-record generation.
- Impact indexing and commit linking.
- New source integrations (tracked separately).

---

## Verification

- Backend: `pnpm cargo:check` and the relevant `cargo:test:*` targets must pass.
- Frontend: `pnpm typecheck` and `pnpm lint` must pass; cost columns exercised against
  real session data in the running app.
- No source files under a user's tool directories are written — read-only guarantee is
  preserved.
