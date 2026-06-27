# `agent_core` — Architecture Map for New Engineers

> Goal: a new engineer can ship a non-trivial change in their first day.
> If something here is wrong or missing, fix it in the same PR as your code change.

This file is a **map**, not a spec. Each section answers two questions:
"where is X?" and "what owns X?". Source-of-truth comments live next to the
code (module-level `//!` headers); this document just wires the layers together.

---

## 1. Mental model in 90 seconds

`agent_core` is the headless brain of an AI coding agent. It runs inside the
Tauri Rust process, has no UI of its own, and exposes everything to the frontend
via Tauri commands in `state/commands/`.

A single user-visible event ("send a message to the agent") flows through:

```
state::commands::session::agent_send_message       ← Tauri command entry
                                                     (in state/commands/session/mod.rs)
  → state::session_runtime::SessionRuntime         ← Process-wide registry
    → core::session::AgentSession                   ← Per-conversation state
      → core::session::turn::entry::process_message ← One LLM round-trip
        → core::turn_executor::execute_turn         ← Driver loop
          → core::providers::*                      ← LLM HTTP client
          → core::session::turn::processor          ← UnifiedMessageProcessor
            → core::tools::*                        ← Tool dispatch & execution
              → integrations / intelligence         ← External effects
```

Anything that **persists** goes through `foundation::persistence` (SQLite +
file storage). Anything that crosses an **async boundary** goes through
`foundation::bus` (broadcast channels for UI/automation listeners).

---

## 2. Layered structure

| Layer | Path            | What lives here                                                       |
| ----- | --------------- | --------------------------------------------------------------------- |
| 3     | `state/`        | Tauri-managed state, command handlers (the API surface visible to TS) |
| 2b    | `integrations/` | External I/O — chat channels, gateway, automation triggers            |
| 2a    | `intelligence/` | Memory, skills, MCP, plugins, hooks (pluggable agent capabilities)    |
| 1     | `core/`         | Agent logic — providers, sessions, tools, turn executor, definitions  |
| 0     | `foundation/`   | Infrastructure — DB, bus, security, file I/O, node control            |

**Strict downward-only dependency** is enforced for two pairs:

- `state` / `integrations` may import anything below them; nothing may import them.
- `foundation` may import nothing else inside `agent_core`; everything else may import it.

The `core` ↔ `intelligence` boundary is **bidirectional by design**:

- `core::session::turn` loads skills, hooks, memory, and MCP at turn time
  (`core::session::turn::entry` constructs `SkillsLoader` and `HookExecutor`).
- `intelligence::memory`, `intelligence::skills`, and `intelligence::hooks`
  read `SessionId`, `AgentExecMode`, and other core types to scope their work
  to the active session.

This is intentional — `intelligence` is a _capability layer_ injected into
the turn loop, not an outer orchestrator. Don't try to break the cycle by
adding a new "shared types" crate; instead, keep both directions narrow:

- `core → intelligence`: only call constructors and run-time entry points
  (`SkillsLoader::new`, `HookExecutor::load`, `MemoryManager::record`).
- `intelligence → core`: only depend on stable identity / enum types
  (`SessionId`, `AgentExecMode`, `MessageRole`), never on session internals.

If a new module isn't sure where to live: ask "**who imports me?**". If only
TS via Tauri, you belong in `state/`. If you broker external I/O for any agent,
`integrations/`. If you implement a pluggable capability used inside the turn
loop, `intelligence/`. If you're part of the core engine, `core/`. Never push
downward into `foundation/` to escape a missing dep — refactor instead.

---

## 3. The big four — what every new engineer must know

### 3.1 `core::session::AgentSession`

Owns one conversation. Holds the message history, model selection, scratchpad
directory, cancel flag, and a hook into the bus for streaming events.

Source: `core/session/mod.rs` and submodules:

| Submodule             | What lives there                                              |
| --------------------- | ------------------------------------------------------------- |
| `turn/`               | One round of `user → tools → assistant`; the heart of a turn  |
| `compaction/`         | Context window shrinking (LLM summarisation + Session-Memory) |
| `persistence/`        | SQLite CRUD for `agent_sessions` + message rows               |
| `prompt/`             | System prompt assembly (soul + context + learnings)           |
| `recovery.rs`         | Re-hydrate a session from disk on app start                   |
| `wingman/`            | Floating "wingman" companion window state                     |
| `plan_mode/`          | Plan-mode pending-plan file management                        |
| `types/`              | `SessionStatus`, `SessionCategory`, `AgentExecMode`, etc.     |
| `exec_modes.rs`       | `AgentExecMode` policy layers + system-prompt suffixes        |
| `file_registry.rs`    | Tracks which files the agent has read / modified              |
| `gateway_pipeline.rs` | Hand-off into messaging gateways                              |
| `launch.rs`           | One-shot session launchers used by Tauri create commands      |
| `overrides.rs`        | Per-session config overlays from the SessionCreator           |
| `story_init.rs`       | First-run project setup hook                                  |
| `scheduler.rs`        | Cron-style session-side trigger                               |
| `session_id.rs`       | ID generation + version-suffix helpers                        |
| `workspace.rs`        | Resolves the "active repo" path for tool calls                |

Lifecycle: created by `session::launch::*`, persisted to `agent_sessions`
table via `core::session::persistence::crud`, dropped when the user closes
the tab (background sessions outlive their tab via `state::session_runtime`).

### 3.2 `core::turn_executor`

The driver loop. Given a session and the next user message, it:

1. Streams an LLM response via `core::providers::*`.
2. Hands tool-use blocks to `core::session::turn::processor::UnifiedMessageProcessor`.
3. Re-streams, loops, until the model emits a stop_reason.

Source: `core/turn_executor/`, broken down as:

| File / dir                 | Role                                                           |
| -------------------------- | -------------------------------------------------------------- |
| `mod.rs`                   | `execute_turn` entry point + the loop body                     |
| `stream_normalizer.rs`     | Normalizes provider stream events for live UI updates          |
| `tool_execution/`          | Tool-call dispatch + parallel batch handling                   |
| `tool_result_storage.rs`   | Persists tool results into the session DB                      |
| `screenshot.rs`            | Vision-block injection (parent screenshots, OS Agent context)  |
| `usage_accumulator.rs`     | Token / cost accounting across the turn                        |
| `file_tracker.rs`          | Records files touched during the turn                          |
| `length_recovery.rs`       | Recover from `stop_reason = "length"` truncation               |
| `stream_error_recovery.rs` | Resume on transient stream errors (mid-event disconnects)      |
| `backoff.rs`               | Per-error retry timing                                         |
| `helpers/`                 | `message_accessor`, `message_writer`, `permission`, `truncate` |
| `types.rs`                 | `TurnConfig`, `TurnInput`, `TurnOutcome`                       |

The retry / fallback wrapper around the LLM call lives in
`core::providers::reliable::ReliableProvider`.

### 3.3 `core::tools`

The tool registry, the `Tool` trait, the `ResolvedToolPolicy` (allowlist /
denylist / approval gates), and concrete implementations under
`tools/impls/{coding,desktop,web,management,orchestration,...}`.

Adding a new tool: implement `Tool` in `tools/impls/<area>/<name>.rs`, register
it in the area's `mod.rs`, add a policy entry if it's not always-on. The single
source of truth for the trait is `tools/traits.rs`.

The "subagent" tool (`tools::impls::orchestration::agent`) is special — it
boots a child `AgentSession` from inside a parent's tool call. See its module
docs before changing it.

### 3.4 `core::providers`

LLM HTTP clients. Four drivers, plus a shared adapter layer:

- `anthropic_native/` — native Anthropic Messages API (preferred for Claude)
- `openai_compat/` — OpenAI Chat Completions format (DeepSeek, Groq, Gemini, OpenRouter, Azure, etc.)
- `openai_responses/` — OpenAI Responses API (required for GPT-5.4+ tool use)
- `chatgpt_codex/` — Codex OAuth ChatGPT-backend variant
- `responses_common/` — shared converters used by both OpenAI Responses and Codex

Selection happens in `providers::factory::create_provider_with_reliability`.
Provider identity is a typed constant: `providers::registry::provider_id::*`.
**Never compare `spec.name == "anthropic"`; always `== provider_id::ANTHROPIC`.**

The model → context-window table and the model-name normalizer (`sonnet-4.5`
→ `claude-sonnet-4.5`) also live in `providers::registry`.

---

## 4. Cross-cutting subsystems

### 4.1 Memory (`intelligence::memory`)

Five sub-systems, each independently consultable:

- `learnings/` — long-lived facts the agent has decided are worth remembering
- `reflection/` — pre/post-turn synthesis pipeline that produces learnings
- `embeddings/` — vector search over learnings (provider key resolution lives here)
- `consolidation/` — periodic compaction of stale learnings
- `workspace_memory/` — workspace-scoped notes + per-story context retrieval
- `commands.rs` — the Tauri-command surface used by the Learnings Browser UI
  and the debug/E2E HTTP shim

If you're adding memory features, start in `learnings/types.rs` and
`reflection/mod.rs`.

### 4.2 Skills (`intelligence::skills`)

Markdown-with-frontmatter capabilities the agent can opt into. The market
catalog and local installation flow are in `skills/market.rs`; built-in
skills (compiled into the binary) are in `skills/builtin_data/`.

### 4.3 MCP (`intelligence::mcp`)

Model Context Protocol bridge. `manager/` owns connections; `client/`
is the per-server runtime; `bridge::register_mcp_tools` adapts MCP tools
into `core::tools`. Tool-name collisions with built-ins are gated at
registration time (see `init::mcp_wiring::register_mcp_tools_from_app`).

### 4.4 Channels & Gateway (`integrations::channels`, `integrations::gateway`)

External chat surfaces — Telegram, Discord, Slack, WeCom, WeChat. Each
channel has its own subdir; the gateway routes messages between them and
the agent. The merge-batch logic lives in
`integrations::gateway::message_merge`.

### 4.5 Automation (`integrations::automation`)

Rule-based triggers: scheduled time, file change, etc. Look at
`automation::triggers::timer::ScheduledTimeSpec` for the canonical
parameter-struct pattern used to keep `spawn_*` calls readable.

### 4.6 Persistence (`foundation::persistence`)

SQLite (via `rusqlite`) plus a file-system store for blobs. The
`db_helpers/` directory contains pure SQL builders; `crud/` directories under
each domain (e.g. `core::session::persistence::crud`) compose them.

**Schema lives in `foundation::persistence::session_snapshots::ensure_tables`.**
Migrations are intentionally lightweight — there is no `migrations/` directory
and no version table. A new column is added by appending an
`ALTER TABLE ... ADD COLUMN ...` line via the local `try_migrate` helper,
which tolerates `"duplicate column name"` so re-runs are idempotent. A
column drop uses `try_drop_column` (SQLite 3.35+, vendored). Read
`session_snapshots.rs` end-to-end before adding a table — the file is the
single source of truth for the on-disk schema.

### 4.7 Bus (`foundation::bus`)

`tokio::sync::broadcast` channels typed per event family. Only place where
the UI and the engine cross-talk asynchronously. If you're tempted to add a
`Mutex<Vec<Listener>>`, use the bus instead.

### 4.8 Security (`foundation::security`)

Tool-policy resolver, sandbox sentinels, secret redaction. Touch this only
if you've read `foundation::security::policy::mod.rs` start to finish.

---

## 5. Naming conventions you'll see

These conventions are enforced by code review. Use this table to predict
where a name belongs.

| Suffix       | Meaning                                     | Example                                      |
| ------------ | ------------------------------------------- | -------------------------------------------- |
| `Manager`    | Owns a registry of items + lifecycle        | `McpManager`, `ChannelManager`               |
| `Handler`    | Stateless dispatcher of events              | `BroadcastingHandler`, `UnifiedEventHandler` |
| `Spec`       | Static metadata struct (no state)           | `ProviderSpec`, `ScheduledTimeSpec`          |
| `Config`     | User-tunable parameters                     | `ProviderConfig`, `ReliabilityConfig`        |
| `Params`     | Constructor / call-site argument bundle     | `ProcessorParams`                            |
| `Resolution` | Result of resolving inputs to outputs       | `ScheduleResolution`                         |
| `Resolved*`  | Concrete value derived from config + lookup | `ResolvedProviderKey`, `ResolvedToolPolicy`  |
| `Pending*`   | One row in an in-memory wait-queue          | `PendingQuestion`, `PendingPermission`       |
| `Record`     | DB-row DTO (serde compat = wire format)     | `UnifiedSessionRecord`, `LearningRecord`     |

Forbidden cross-module collisions: `PendingEntry`, `ResolvedCredential`,
`Helper`, `Util`, `Utils`. If you need one of these, **prefix with the
domain** or merge with an existing typed cousin.

---

## 6. Wire-format constants — never use raw strings

These are the most-typed magic strings. **Always reference the constant.**

| Domain                       | Constants module                                                                      | Example                          |
| ---------------------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| LLM provider IDs             | `core::providers::registry::provider_id`                                              | `provider_id::ANTHROPIC`         |
| macOS permission kinds       | `core::tools::impls::desktop::worker::proto::permission_kind`                         | `permission_kind::ACCESSIBILITY` |
| Tool names (inter-tool refs) | `core::tools::tool_names`                                                             | `tool_names::AGENT`              |
| Built-in agent IDs           | `core::definitions::builtin` (per-agent file: `os.rs`, `sde.rs`, `subagents.rs`, ...) | `EXPLORE_AGENT_ID`               |
| Session type / status        | `core::session::types::enums::{SessionStatus, SessionCategory}`                       | `SessionStatus::Idle`            |

If your code has `if x == "anthropic"`, you owe a follow-up commit.

---

## 7. Adding a new feature — the checklist

Before you push:

- [ ] Layer placement: pick the lowest layer that has all your dependencies.
- [ ] No new `Manager` / `Handler` if an existing typed one already covers it.
- [ ] No new `Pending*` struct named `PendingEntry` — prefix with domain.
- [ ] No new comparison against a literal string for provider, tool name, or status.
- [ ] If a function takes ≥7 arguments, bundle into a `Spec` / `Params` struct.
- [ ] If a return type fits twice on screen, alias it with a `type` declaration.
- [ ] Schema change → append an `ALTER TABLE` via `try_migrate` in `session_snapshots::ensure_tables`.
- [ ] DB read → audit that `init.rs` writes the same field.
- [ ] New public `pub fn` → call it from somewhere, or downgrade visibility.
- [ ] `cargo clippy --lib` is clean (build script warnings outside `agent_core` are tolerated).

---

## 8. Where to put which test

- Pure-function logic → `#[cfg(test)] mod tests` at the end of the file.
- Cross-module integration → `agent_core/tests/<area>_tests.rs`.
- Tauri-command happy paths → `api/agent/test/*` (gated on `debug_assertions`).
- E2E flows that touch the running agent → `tests/` at the repo root, driven
  by `playwright`.

`#[allow(dead_code)]` is acceptable in two cases only: (a) `#[cfg_attr(not(test), allow(dead_code))]`
on a method exercised only by tests; (b) feature-gated alternative
implementations selected by `#[cfg]`. Anything else is a deletion candidate.

---

## 9. The shortest possible "where do I look" cheat sheet

| Question                                                 | Open this first                                              |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| How does a user message reach the LLM?                   | `core::session::turn::entry`                                 |
| Where do tools dispatch?                                 | `core::session::turn::processor::mod`                        |
| How are LLM keys looked up?                              | `core::providers::factory::create_provider_with_reliability` |
| Where is the agent's identity / system prompt assembled? | `core::session::prompt::builder`                             |
| How do subagents work?                                   | `core::tools::impls::orchestration::agent::mod`              |
| How does the agent persist between app restarts?         | `core::session::persistence::crud`                           |
| How is the SQLite schema laid out?                       | `foundation::persistence::session_snapshots::ensure_tables`  |
| How are messages broadcast to the UI?                    | `foundation::bus`                                            |
| How is a session bootstrapped (provider + tools + soul)? | `init::session_factory` + `init::agent_definition_loader`    |
| Where are MCP tools wired into the registry?             | `init::mcp_wiring::register_mcp_tools_from_app`              |

When in doubt, **read the `//!` header of the directory's `mod.rs` first.**
Every meaningful module has one. If yours doesn't, write it — it's how the
next engineer onboards faster than you did.
