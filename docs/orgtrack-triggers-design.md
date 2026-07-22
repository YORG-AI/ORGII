# orgtrack triggers — usage/behavior threshold rules

_Design — 2026-07-20_

## Goal

Let users define **triggers**: rules over usage/behavior metrics that **fire**
(emit a warning/error) when a threshold is crossed, e.g. "warn if any day's
spend exceeds $50", "error if a single session burns >20M tokens", "warn if a
source's cache-hit rate drops below 80%". Fired triggers are **compiled** into a
report, and the command exits non-zero when an `error` fires — so it drops
straight into CI, a cron, or a pre-commit check.

### Terminology (avoid a clash)

`orgtrack_core::hook_adapter` already means _capture hooks_ (session-provenance
payloads from CLI agents). This feature is **triggers** (the rules) with
optional exec **hooks** as the action side (phase 2) — kept distinct.

## Rule model (declarative, no-code)

`~/.orgtrack/triggers.toml` (also `--triggers <path>`, or `.orgtrack/triggers.toml`):

```toml
[[trigger]]
id       = "daily-cost-cap"
metric   = "cost_usd"     # cost_usd | tokens | input_tokens | output_tokens
                          # | cache_read_tokens | cache_write_tokens
                          # | session_count | cache_hit_rate
scope    = "day"          # total | day | source | project | session
op       = ">"            # > | >= | < | <=
value    = 50.0
severity = "warn"         # info | warn | error
message  = "Daily spend over $50"   # optional; {scope}, {actual}, {value} interpolated
```

- **metric** — aggregated over the scope from the per-session usage rows.
- **scope** — the grouping the metric is evaluated on:
  - `total` — one value across all in-scope sessions.
  - `day` — per calendar day (from each session's `last_active_ms`).
  - `source` — per tool (`claude_code`, `codex_app`, …).
  - `project` — per cross-machine project identity (git-remote slug; reuses
    `project.rs`).
  - `session` — per session (e.g. a runaway single conversation).
- A trigger fires **once per scope key that crosses** (e.g. per day, per source).
  `cache_hit_rate` is a ratio in 0–1; everything else is a sum/count.

## Evaluation — `orgtrack check`

```
orgtrack check [--db PATH] [--triggers PATH] [--source id]... [--strict] [--format table|json|md]
```

1. Scan (unless `--no-scan`) + project usage (same path as `usage`).
2. Pull every session's usage row (`usage_dashboard::usage_sessions`, all-sources)
   - a `session_id → repo_path` map (from `imported_history_session_cache`, for
     `project` scope).
3. Aggregate per scope, evaluate every trigger, collect **firings**
   `{ trigger_id, scope, scope_key, metric, actual, op, value, severity, message }`.
4. **Compile** the firings into a report (table / json / md).
5. **Exit code:** `2` if any `error` fired; `1` if `--strict` and any `warn`
   fired; else `0`. (CI fails the build; a cron mails the report.)

Example report:

```
SEVERITY  TRIGGER          SCOPE            ACTUAL     LIMIT    MESSAGE
error     session-cap      session=abcd…    24.1M tok  > 20M    Session over 20M tokens
warn      daily-cost-cap   day=2026-07-19   $63.20     > $50    Daily spend over $50
2 trigger(s) fired (1 error, 1 warn).   [exit 2]
```

## Phased plan

1. **Declarative triggers + `check`** _(this PR)_ — the TOML rule model, the
   aggregate-and-evaluate engine over `total`/`day`/`source`/`project`/`session`,
   the compiled report (table/json/md), and exit codes. Pure, testable, no code
   execution.
2. ✅ **Exec hooks (action side)** — a `kind = "hook"` exec plugin (trust-gated,
   like loaders/processors) that `orgtrack check` runs when a trigger fires,
   receiving the firings JSON on stdin so it can act (Slack webhook,
   `notify-send`, open a ticket). `[hook].on = ["error", ...]` limits which
   severities invoke it. Reuses the exec + content-hash-trust machinery; an
   untrusted/failing hook is a stderr note, never fatal. _Shipped_ — see
   `examples/plugins/hook/`.
3. **`usage` integration** — a `⚠ N triggers fired` footer on `orgtrack usage`,
   and a `scan --check` that evaluates after indexing.
4. **Stateful / delta triggers** — "fire only when it _newly_ crosses" by
   recording the last evaluated value per trigger in the `--db`, so a cron
   doesn't re-alert every run.

## Why this shape

- Reuses the existing usage pipeline (`usage_sessions`) and project identity —
  no new metrics plumbing.
- Declarative rules stay no-code and safe (no execution); the exec-hook action
  side inherits the plugin trust model, so nothing runs untrusted.
- Exit codes make it composable with `cron`/CI without any orgtrack-specific
  glue.
