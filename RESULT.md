# RESULT.md — ORG-II ↔ Feishu Integration (6 Items + opus-4.6)

## Summary

All 6 features (E1–E6) plus opus-4.6 model support have been addressed.
5 items required code changes and were committed individually. 2 items (E5
and opus-4.6) required no code changes — evidence is documented below.

---

## Commits

| Item | Commit     | Scope                                                                      |
| ---- | ---------- | -------------------------------------------------------------------------- |
| E2   | `5306f99c` | `feat(e2): add short alias "wi" for manage_work_item tool`                 |
| E4   | `02d6d075` | `fix(e4): exponential backoff + pong timeout + fragment TTL for Feishu WS` |
| E1   | `b5209ea8` | `feat(e1): expose channel field and add Channels sidebar group`            |
| E3   | `f07dca08` | `feat(e3): bidirectional attachment receive from Feishu`                   |
| E6   | `eec807e1` | `feat(e6): GUI monitoring panel for ZenMux quota`                          |

---

## E1: Feishu session sidebar visibility

### What changed

**Backend (2 files):**

- `unified_stats/types.rs` — Added `channel: Option<String>` to `SessionAggregateRecord`
- `unified_stats/conversion.rs` — Map `channel` in all 3 conversion functions (cli→None, sde→None, os→session.channel)

**Frontend (6 files):**

- `rpc/schemas/sessionAggregate.ts` — Zod schema: `channel: z.string().optional()`
- `store/session/sessionAtom/types.ts` — `Session` interface: `channel?: string`
- `api/tauri/session/index.ts` — `toFrontendSession()` maps channel
- `menuSectionBuilders.ts` — byAgent mode: partitions channel sessions into "Channels" groups above agent groups
- `sessionAgentGroups.ts` — Added `CHANNEL_LABELS` map (feishu/telegram/discord/email)
- `i18n/locales/{en,zh}/sessions.json` — i18n keys for channel labels

### Verification

Full Tauri app builds. Sessions with `channel="feishu"` appear under a "Feishu / Lark" group in the byAgent sidebar.

---

## E2: Feishu Work Item tool alias

### What changed (1 file + 1 test file)

- `core/tools/registry.rs` — Added `resolve_tool_alias()` function mapping `"wi"` → `manage_work_item`; updated `get()` and `execute_with_policy()` to call it
- `core/tools/tests/registry_tests.rs` — 2 new tests: `alias_wi_resolves_to_manage_work_item`, `execute_alias_dispatches_to_canonical_tool`

### Why no capability change needed

OS Agent definition (`builtin/os.rs`) already includes `ManagementCapability`, so `manage_work_item` was already available to Feishu agents. The alias just provides a short name for LLM convenience.

### Verification

All 11 alias-related tests pass. Build succeeds.

---

## E3: Attachment bidirectional receive (download)

### What changed (3 files)

- `feishu/api.rs` — New functions: `download_image()`, `download_file()`, `resolve_feishu_media()`, `sha256_hex()` (delegates to `foundation::persistence::images::sha256_hex`)
- `feishu/ws.rs` — Accept `Arc<FeishuAuth>`, call `resolve_feishu_media()` after parse_feishu_event and before dispatch to bus
- `feishu/channel.rs` — Pass `auth` clone into WS loop

### Architecture

- Inbound images/files from Feishu are downloaded via REST API (`GET /im/v1/images/{key}`, `GET /im/v1/files/{key}`)
- Persisted to `~/.orgii/session-images/` with SHA-256 content-hash deduplication
- `InboundMessage.media` entries transformed from `feishu:image:{key}` → local file path before dispatch
- No new dependencies (reuses existing `sha2` via `foundation::persistence::images`)

### Verification

Build succeeds. All 31 feishu tests pass.

---

## E4: WS reconnection robustness

### What changed (1 file)

- `feishu/ws.rs` — Three improvements:

1. **Exponential backoff**: `compute_backoff(attempt, base_secs)` → `min(base * 2^attempt, 900s)`, replaces both fixed-sleep reconnect paths. Counter resets on successful connect.

2. **Pong timeout**: `last_pong: Arc<Mutex<Instant>>` updated on pong receipt. Ping task checks `elapsed() > pong_timeout` before sending; if exceeded, breaks connection to trigger reconnect.

3. **Fragment cache TTL**: `fragment_timestamps` HashMap tracks insertion time; entries older than 5 minutes are purged each loop iteration.

### Tests added

5 unit tests for `compute_backoff`: base case, exponential growth, cap at max, large base, zero base.

### Verification

All 5 backoff tests pass. Build succeeds.

---

## E5: Cross-channel learnings fusion — NO CODE CHANGE

### Evidence

1. `learnings` table has no `channel` or `session_type` column — only `agent_scope` (agent definition ID)
2. `load_active_learnings(conn, agent_scope)` queries `WHERE agent_scope = ?1 AND status NOT IN (...)` — no channel filtering
3. `search_similar()` / `rerank_candidates()` also have no channel filtering
4. Feishu sessions and local GUI sessions use the same agent definition (`builtin:os`), writing to `agent_scope = "agent:builtin:os"`
5. Retrieval is purely by agent_scope + embedding similarity, so learnings from Feishu are recalled in local sessions and vice versa

**Conclusion:** The system was already designed this way. No code change needed.

---

## E6: GUI monitoring panel

### What changed

**Backend (4 files):**

- `status_bar.rs` — New: `ZenmuxQuotaStatus` struct (Serialize), `get_zenmux_quota()` public async fn, `get_session_token_summary()` public fn
- `session/mod.rs` — Promoted `status_bar` from `pub(crate)` to `pub`
- `unified_stats/commands.rs` — New Tauri commands: `quota_get_zenmux_status`, `session_get_context_status` (with `SessionContextStatus` struct)
- `handler_list.inc` — Registered both new commands

**Frontend (7 files):**

- `rpc/schemas/quota.ts` — Zod schemas for quota responses
- `rpc/procedures/quota.ts` — RPC procedure definitions
- `rpc/schemas/index.ts`, `rpc/procedures/index.ts`, `rpc/router.ts` — Barrel registrations
- `SidebarQuotaMonitorButton.tsx` — Sidebar button + dropdown panel with 5h/7d progress bars
- `SettingsSidebar.tsx` — Mounts quota button alongside RAM monitor
- `i18n/locales/{en,zh}/sessions.json` — i18n keys

### Verification

Full `cargo build -p org2` succeeds. TypeScript type check passes (23 pre-existing errors, 0 new). ESLint passes.

---

## opus-4.6 model support — NO CODE CHANGE

### Evidence

1. `model_capabilities.rs`: `FamilyRule { pattern: "claude-opus-4", ... }` — substring match covers 4.6/4.7/4.8
2. `nativeHarnessAccountModels.ts`: `CLAUDE_CODE_OAUTH_MODELS` includes `"claude-opus-4-6"`
3. `modelWikiCatalog.json`: `"anthropic/claude-opus-4.6"` entry exists with full metadata
4. `info.ts`: `MODEL_INFO_ENTRIES` pattern `"claude-opus-4"` covers all 4.x variants
5. `section_builders.rs`: knowledge cutoff already mapped for `claude-opus-4-6`
6. E2E tests and pricing scripts already reference `claude-opus-4.6`

**Conclusion:** Already fully supported via pattern matching. No code change needed.

---

## Build Verification

| Check                                    | Result                                            |
| ---------------------------------------- | ------------------------------------------------- |
| `cargo build -p agent_core`              | ✅ Compiles (warnings from unrelated crates only) |
| `cargo build -p org2`                    | ✅ Full app compiles                              |
| `cargo test -p agent_core -- feishu`     | ✅ 31/31 pass                                     |
| `cargo test -p agent_core -- alias`      | ✅ 11/11 pass                                     |
| `cargo test -p agent_core -- status_bar` | ✅ 1/1 pass                                       |
| `npx tsc --noEmit`                       | ✅ 23 pre-existing errors, 0 new                  |
| ESLint (lint-staged)                     | ✅ All staged files pass                          |

### Pre-existing test failures (not introduced by this work)

- 12 tests in agent_core fail due to SQLite schema mismatches (`org_id` column) and model context hint tests — these are pre-existing.

---

## Files Changed (by item)

### E1 (8 files)

- `src-tauri/src/agent_sessions/unified_stats/types.rs`
- `src-tauri/src/agent_sessions/unified_stats/conversion.rs`
- `src/api/tauri/rpc/schemas/sessionAggregate.ts`
- `src/store/session/sessionAtom/types.ts`
- `src/api/tauri/session/index.ts`
- `src/scaffold/NavigationSidebar/.../menuSectionBuilders.ts`
- `src/config/sessionAgentGroups.ts`
- `src/i18n/locales/{en,zh}/sessions.json`

### E2 (2 files)

- `src-tauri/crates/agent-core/src/core/tools/registry.rs`
- `src-tauri/crates/agent-core/src/core/tools/tests/registry_tests.rs`

### E3 (3 files)

- `src-tauri/crates/agent-core/src/integrations/channels/feishu/api.rs`
- `src-tauri/crates/agent-core/src/integrations/channels/feishu/ws.rs`
- `src-tauri/crates/agent-core/src/integrations/channels/feishu/channel.rs`

### E4 (1 file)

- `src-tauri/crates/agent-core/src/integrations/channels/feishu/ws.rs`

### E6 (13 files)

- `src-tauri/crates/agent-core/src/core/session/status_bar.rs`
- `src-tauri/crates/agent-core/src/core/session/mod.rs`
- `src-tauri/src/agent_sessions/unified_stats/commands.rs`
- `src-tauri/src/commands/handler_list.inc`
- `src/api/tauri/rpc/schemas/quota.ts` (new)
- `src/api/tauri/rpc/procedures/quota.ts` (new)
- `src/api/tauri/rpc/schemas/index.ts`
- `src/api/tauri/rpc/procedures/index.ts`
- `src/api/tauri/rpc/router.ts`
- `src/scaffold/NavigationSidebar/connectors/SidebarQuotaMonitorButton.tsx` (new)
- `src/scaffold/NavigationSidebar/variants/SettingsSidebar.tsx`
- `src/i18n/locales/{en,zh}/sessions.json`
