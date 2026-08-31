# Test Cases: Agent Sessions

Comprehensive test specification for agent session lifecycle, health, filtering,
statistics, and display across all three session categories (CLI, SDE Agent, OS Agent).

All Rust unit tests live in:

- `src-tauri/src/agent_sessions/session_directory/tests/` (lifecycle, filter, display)
- `src-tauri/src/agent_sessions/session_directory/status.rs` (inline `#[cfg(test)]`)
- `src-tauri/src/agent_sessions/session_directory/display.rs` (inline `#[cfg(test)]`)
- `src-tauri/src/agent_sessions/session_directory/aggregation.rs` (inline `#[cfg(test)]`)
- `src-tauri/src/agent_sessions/cli/tests/` and `cli/session_runner/` (inline `#[cfg(test)]`)
- `src-tauri/src/agent_sessions/event_pipeline/tests/`

Run all tests:

```bash
cd src-tauri && cargo test --lib agent_sessions::
```

---

## Preconditions

- No running database connection required for unit tests (all use in-memory fixtures).
- `CURSOR_API_KEY` is **not** required for unit tests.
- For integration/e2e tests in `tests/e2e/`, a running Tauri backend is needed.
- All timestamps must be valid RFC-3339 strings (e.g. `"2024-01-01T00:00:00Z"`).

---

## 1. Session Lifecycle

### Happy Path

| #   | Steps                                  | Expected Result                                                       |
| --- | -------------------------------------- | --------------------------------------------------------------------- |
| 1   | Create session with status `"pending"` | `is_active = true`, `is_terminal() = false`                           |
| 2   | Transition session to `"running"`      | `is_active = true`, `is_resumable() = true`                           |
| 3   | Transition to `"waiting_for_user"`     | `is_active = true`, health = in-progress, never stale                 |
| 4   | Transition to `"completed"`            | `is_active = false`, `is_terminal() = true`, `is_resumable() = false` |

### Edge Cases

| #   | Scenario                                       | Steps                                        | Expected Result                                                       |
| --- | ---------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Unknown status string                          | Call `SessionStatus::parse("zombie")`        | Returns `None` — no panic                                             |
| 2   | Case-sensitive parse                           | Call `parse("Running")` / `parse("PENDING")` | Returns `None`                                                        |
| 3   | `idle` status                                  | Create session with `"idle"`                 | `is_active = true`, `is_terminal() = false`, `is_resumable() = false` |
| 4   | `Display` roundtrip                            | `parse(status.to_string())`                  | Returns original variant                                              |
| 5   | `is_completed_status("Completed")` (capital C) | Call helper                                  | Returns `false` (case-sensitive)                                      |

### Error / Degraded States

| #   | Scenario                  | Steps                                 | Expected Result            |
| --- | ------------------------- | ------------------------------------- | -------------------------- |
| 1   | Empty status string       | `SessionStatus::parse("")`            | Returns `None`             |
| 2   | Status categories overlap | Call all three helpers on same status | At most one returns `true` |

---

## 2. Session Health

### Happy Path

| #   | Steps                              | Expected Result                              |
| --- | ---------------------------------- | -------------------------------------------- |
| 1   | `waiting_for_user` — any timestamp | `is_in_progress = true`, `is_stale = false`  |
| 2   | `running` with PID, fresh          | `is_in_progress = true`, `is_stale = false`  |
| 3   | `pending` with PID, fresh          | `is_in_progress = true`, `is_stale = false`  |
| 4   | `completed` session                | `is_in_progress = false`, `is_stale = false` |

### Edge Cases

| #   | Scenario                               | Steps        | Expected Result                                              |
| --- | -------------------------------------- | ------------ | ------------------------------------------------------------ |
| 1   | `running`, no PID, updated 30s ago     | Check health | `is_in_progress = true` (within 5-min threshold)             |
| 2   | `running`, no PID, updated 10 min ago  | Check health | `is_stale = true`, `stale_reason = "running_no_pid_timeout"` |
| 3   | `pending`, no PID, updated 60s ago     | Check health | `is_in_progress = true` (within 2-min threshold)             |
| 4   | `pending`, no PID, updated 5 min ago   | Check health | `is_stale = true`, `stale_reason = "pending_timeout"`        |
| 5   | `waiting_for_user`, updated 10 min ago | Check health | `is_stale = false` — this status is immune to staleness      |

### Error / Degraded States

| #   | Scenario                               | Steps                | Expected Result                                   |
| --- | -------------------------------------- | -------------------- | ------------------------------------------------- |
| 1   | `compute_age_ms("")`                   | Pass empty string    | Returns `None`                                    |
| 2   | `compute_age_ms("not-a-date")`         | Pass invalid format  | Returns `None`                                    |
| 3   | `compute_age_ms` with future timestamp | Pass future RFC-3339 | Returns `Some(negative_ms)` — callers must handle |

---

## 3. Session Filter & Text Search

### Happy Path

| #   | Steps                                 | Expected Result                               |
| --- | ------------------------------------- | --------------------------------------------- | ---------------------------- |
| 1   | Text query matching session name      | `matches_text_query(session, "auth")`         | `true`                       |
| 2   | Text query case-insensitive           | Query `"AUTH"` matches name `"auth refactor"` | `true`                       |
| 3   | Text query matches `user_input` field | Session has `user_input = "Fix OAuth bug"`    | `true` for query `"oauth"`   |
| 4   | Text query matches `repo_name`        | `repo_name = "backend-api"`                   | `true` for query `"backend"` |
| 5   | Text query matches `display_label`    | `display_label = "Deploy service"`            | `true` for query `"deploy"`  |

### Edge Cases

| #   | Scenario                           | Steps                                   | Expected Result                      |
| --- | ---------------------------------- | --------------------------------------- | ------------------------------------ |
| 1   | No matching query                  | Query `"xyzzy_no_match"` on any session | `false`                              |
| 2   | CJK characters                     | Session name `"新会话"`, query `"新"`   | `true`                               |
| 3   | Pill-stripped display label        | `user_input = "Fix @auth.ts"`           | `display_label` has no `@` character |
| 4   | All-pill `user_input` → None label | `user_input = "@a @b @c"`               | `display_label = None`               |
| 5   | Pagination: offset > length        | 5 sessions, skip 10                     | Empty result                         |
| 6   | Pagination: limit 0                | Any sessions, take 0                    | Empty result                         |
| 7   | `active_only` filter               | Mix of active/completed sessions        | Only active sessions returned        |

### Error / Degraded States

| #   | Scenario              | Steps                             | Expected Result                                  |
| --- | --------------------- | --------------------------------- | ------------------------------------------------ |
| 1   | Empty text query      | `matches_text_query(session, "")` | `true` (caller must guard against empty queries) |
| 2   | Whitespace-only query | Functionally same as empty        | Caller must normalize before calling             |

---

## 4. Session Statistics

### Happy Path

| #   | Steps                  | Expected Result                   |
| --- | ---------------------- | --------------------------------- | -------------------------------------------- |
| 1   | Empty session list     | `compute_aggregate_stats([])`     | All counts = 0, cost = 0.0                   |
| 2   | All running sessions   | 5 running × 100 tokens            | `ongoing_count = 5`, `total_tokens = 500`    |
| 3   | All completed sessions | 8 completed × 1000 tokens         | `completed_count = 8`, `total_tokens = 8000` |
| 4   | Mixed sessions         | 3 active + 2 completed + 3 failed | Each bucket counted independently            |
| 5   | Multi-category         | 1 CLI + 1 Agent + 1 OS            | All included in totals                       |

### Edge Cases

| #   | Scenario                                                      | Steps                                | Expected Result                                   |
| --- | ------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| 1   | Zero-token sessions                                           | All sessions have `total_tokens = 0` | `total_cost_usd = 0.0`                            |
| 2   | Cost is proportional                                          | 1K tokens vs 10K tokens sessions     | Higher token count → higher cost                  |
| 3   | Cost is non-negative                                          | Any session set                      | `total_cost_usd >= 0.0`                           |
| 4   | `failed` / `cancelled` / `abandoned` all go to `failed_count` | Mix of terminal failures             | `failed_count` equals sum of all failure statuses |
| 5   | Single session edge case                                      | 1 running session                    | Correct bucket, no crash                          |

---

## 5. Display Label

### Happy Path

| #   | Steps                      | Expected Result                                          |
| --- | -------------------------- | -------------------------------------------------------- | ----------------------- |
| 1   | Custom name, no user_input | `generate_display_label("My Task", None)`                | `Some("My Task")`       |
| 2   | Default name + user_input  | `generate_display_label("New Session", Some("Fix bug"))` | `Some("Fix bug")`       |
| 3   | Long name truncated        | Name with 100 chars                                      | Truncated to 30 chars   |
| 4   | Pill refs stripped         | `user_input = "Fix @file.ts and @folder/ bug"`           | Label = `"Fix and bug"` |

### Edge Cases

| #   | Scenario                            | Steps                                            | Expected Result                 |
| --- | ----------------------------------- | ------------------------------------------------ | ------------------------------- |
| 1   | Default name + no input             | `generate_display_label("New Session", None)`    | `None`                          |
| 2   | Empty name + no input               | `generate_display_label("", None)`               | `None`                          |
| 3   | CJK name, 100 chars                 | `generate_display_label("中".repeat(100), None)` | `char_count <= 30`              |
| 4   | Emoji in input                      | Input with 50 emoji                              | `char_count <= 30`, valid UTF-8 |
| 5   | All-pill user_input                 | `@a @b @c`                                       | `None` (stripped to empty)      |
| 6   | Multiple spaces in input            | `"Fix  the   bug"`                               | `"Fix the bug"` (collapsed)     |
| 7   | Leading/trailing whitespace in name | `"  Padded  "`                                   | `"Padded"` (trimmed)            |

---

## 6. Session Manager (Event Store LRU Cache)

### Happy Path

| #   | Steps                    | Expected Result                                           |
| --- | ------------------------ | --------------------------------------------------------- |
| 1   | `set_active("s1")`       | `active_id() = Some("s1")`                                |
| 2   | Switch active to `"s2"`  | `s1` demoted to idle, `s2` is active                      |
| 3   | `pin("running-session")` | Session survives LRU eviction even with 30+ idle sessions |
| 4   | `unpin("s1")`            | Session returns to evictable pool                         |
| 5   | `evict("s1")`            | Not known, not pinned, active = None                      |

### Edge Cases

| #   | Scenario                     | Steps                                          | Expected Result |
| --- | ---------------------------- | ---------------------------------------------- | --------------- |
| 1   | `set_active` same ID twice   | Idempotent — no duplicate in idle set          |
| 2   | `register` same ID 3×        | `known_count() = 1`                            |
| 3   | `touch` unknown session      | Session is auto-registered                     |
| 4   | `clear()`                    | All state wiped — 0 known, 0 pinned, no active |
| 5   | LRU eviction respects pinned | 30 idle + 1 pinned → pinned always survives    |

---

## Accessibility

- [ ] Session status values are localized/translated in the frontend (not tested in Rust unit tests)
- [ ] Display labels are rendered as `aria-label` values in the session list
- [ ] Stale session badges have screen-reader-visible text ("stale" / "timed out")

---

## Acceptance Criteria

### Lifecycle

- [ ] All `SessionStatus` variants parse from their canonical string form
- [ ] `is_terminal()` and `is_resumable()` are mutually correct and consistent with the frontend `TERMINAL_STATUSES` set
- [ ] Status categories (active / failed / completed) are mutually exclusive

### Health

- [ ] `waiting_for_user` is never classified as stale regardless of timestamp
- [ ] Stale sessions have `is_in_progress = false` (not just `is_stale = true`)
- [ ] Stale detection uses correct thresholds: 2 min for pending, 5 min for running
- [ ] Invalid timestamps return `None` from `compute_age_ms`, not a panic

### Filter & Display

- [ ] Text search is case-insensitive across all four searchable fields
- [ ] `display_label` never contains `@` pill references
- [ ] Truncation is by Unicode scalar value count, not byte count (safe for CJK/emoji)
- [ ] Pagination `offset` beyond length returns empty — no index-out-of-bounds

### Statistics

- [ ] `ongoing_count + completed_count + failed_count <= total sessions` (some statuses go into no bucket)
- [ ] `total_cost_usd >= 0.0` for any session set
- [ ] `total_tokens` is the exact sum of all session `total_tokens` values

### Tests

- [ ] `cargo test --lib agent_sessions::` passes with no failures
- [ ] No `#[allow(dead_code)]` or `#[allow(unused)]` suppressions in new test files
- [ ] Test helpers (`make_session`, `ts_ago`) do not duplicate production logic
