# orgtrack CLI — publishable loading & analysis surface

_2026-07-19_

## What shipped

A standalone `orgtrack` binary (`src-tauri/crates/orgtrack-cli`, bin name
`orgtrack`) that loads AI coding-assistant sessions from every tool
`orgtrack_core` can read and reports token/cost analytics — with no dependency
on the Tauri desktop app. It is the "turn orgtrack loading/analysis into a
publishable CLI" deliverable.

It rests on a new, small, reusable piece in core:

- **`orgtrack_core::sources::registry`** — the single source of truth for
  "which providers exist and how to scan one." Every provider already ships a
  `list_*_history_sessions_paginated(&mut Connection, limit, offset)` loader
  (disk discovery + incremental cache upsert + one page of normalized rows);
  the registry is the table that maps a stable `source` id to its loader, plus
  `registered_sources()` / `scan_source()` / `is_registered()`. The read-side
  twin already existed: `imported_history::load_activity_chunks_for_session`
  routes a `session_id` to the right parser. Together they are the whole
  loading pipeline, independent of any host.

The CLI is only argument parsing, orchestration, and formatting over:

1. `registry::scan_source` — load a provider into a SQLite index.
2. `session_usage::backfill_session_usage` — project cached sessions into the
   usage table the analytics reader consumes.
3. `usage_dashboard::*` and `load_activity_chunks_for_session` — analyze &
   replay.

Commands: `sources`, `scan`, `list`/`ls`, `search`, `usage`/`stats`, `show`,
`resume`. See the crate README for the full surface. Verified end-to-end against
the local machine's real history (Claude Code + Codex: 289 listable sessions,
449 token-bearing sessions, ~$5.5k of estimated spend, 97.8% cache-hit rate).

### `resume` — continue an imported session in its own CLI

`orgtrack resume <session-id>` reopens an imported session in the CLI that
owns it, sharing the desktop app's "Continue in CLI" plumbing
(`orgtrack_core::sources::cli_resume`):

- `claudecodeapp-<uuid>` → `claude --resume <uuid>`, executed from the
  session's recorded workspace (Claude Code keys session storage on the
  project path, so the original cwd is required — verified empirically:
  resuming from another directory fails with "No conversation found").
- `codexapp-rollout-<ts>-<uuid>` → `codex resume <uuid>` (bare thread uuid
  extracted from the rollout stem; Codex looks sessions up globally).
- `cursorcliapp-<id>` → `cursor-agent --resume <id>`.
- `opencodeapp-ses_*` → `opencode --session <id>` (central db, global ids).
- `mimocodeapp-ses_*` → `mimo --session <id>` (OpenCode fork, same flag —
  verified against `mimo --help`).
- `clineapp-<epoch>_<rand>` → `cline --id <id>` (global sessions.db).
- `ompapp-<stem>` → `omp --session <transcript-path>` — oh-my-pi resolves
  bare ids against the _current project's_ session dir, so the plan
  addresses the session file by absolute path instead (works from anywhere).
- `copilotapp-<uuid>` → `copilot --resume <uuid>` (the form documented by
  the current CLI's `--help`).
- `kimihistoryapp-cli/<group>/<id>` or
  `kimihistoryapp-code/<workspace>/<id>/main` → `kimi --session <id>`,
  executed from the recorded workspace when one is available (Kimi buckets
  sessions per working directory).

Only that session's provider is scanned. By default the process execs the
CLI (the TUI takes over the terminal); `--print` emits the
`cd <workspace> && <command>` line instead.

Not resumable, and why: `cursor_ide` (composer ids share no space with
`cursor-agent`'s chat store — checked empirically, zero overlap), `windsurf`
/ `warp` / `trae` / `qoder` (app-bound stores, no CLI resume surface), and
`zcode` / `qoder_cli` / `workbuddy` (their CLIs likely resume — OpenCode
fork / documented `/resume` / Claude Code fork — but no binary was present
to verify the exact flag shape; extend `cli_resume` once one is).

### Importer notes: copilot (2026-07-29)

- **copilot** — GitHub Copilot CLI 1.x stores one
  `~/.copilot/session-state/<uuid>/` per session (`events.jsonl` event
  stream + `workspace.yaml` sidecar), with repository/branch and
  per-request token usage (cache + reasoning split) in the sibling
  `session-store.db`. The reader treats the db as best-effort enrichment.
  The metadata-only `data.db` (Projects/Workspaces surface) records
  nothing for `-p`/interactive runs — sessions live in session-state.

## Why a Rust binary (not the TS stub)

`packages/orgtrack` already had a `bin: orgtrack` stub whose message admitted
"native orgtrack-core bindings will be attached during publish prep." The real
loading/analysis is all in the `orgtrack_core` Rust crate, so the shortest path
to a working, publishable CLI is a Rust binary that links it directly. The npm
package can later become a thin downloader/exec wrapper around the released
binary (see the crate README "Publishing" section for the extraction path).

## Roadmap

1. ✅ **FTS5 full-text search over session bodies.** `orgtrack search --content`
   builds an `orgtrack_fts(name, body)` FTS5 index from
   `load_activity_chunks_for_session` output and returns ranked hits with
   highlighted `snippet()`s. Kept RAM/CPU-light: incremental (an
   `orgtrack_fts_state` fingerprint table re-parses only changed sessions —
   repeat searches are ~instant), per-session streaming, a bounded per-session
   body (256 KB), batched write transactions, and disk-backed queries. _Shipped
   in the CLI (`content_index.rs`); an in-app search box could reuse the same
   index._
2. **Markdown / neutral-schema export & portability.** We already normalize
   every provider to `ActivityChunk`; an `orgtrack export --format md` that
   writes a portable, human-readable transcript (plus a JSON neutral schema) is
   a small, high-value add and a natural repo-shareable artifact next to
   `.orgtrack/`. The stretch goal is regenerating a tool's _native_ on-disk
   format from the neutral schema so a session can resume in a different agent.
   This lands naturally on the plugin **formatter** tier (see
   `orgtrack-plugins-design.md`).
3. ✅ **Stable cross-machine project identity.** `project.rs` derives a project
   id = `sha256(normalized git remote)[..12]` with a git-root walk-up and a
   path fallback, by reading `.git/config` directly (no `git` subprocess),
   memoized per repo. Surfaced as `list --project <slug|id>` and
   `projectId`/`projectSlug` in `list --json`, so sessions line up across
   machines/clones regardless of local path. (`orgtrack_core::repo_sync` does
   not derive this today, so the CLI owns it.)
4. **Cursor reader hardening.** The known-hard areas if the Cursor loaders hit
   walls: reverse-mapping Cursor's `md5(cwd)` hashed dirs from other providers'
   known cwds, DAG-sorting Cursor blob records, and reassembling VS Code
   `state.vscdb` composer/bubble rows.

### Explicit non-goals

- Cloud sync / RAG — out of scope for a local CLI. The value is breadth (15
  providers) plus token/cost analytics; lead with those.
