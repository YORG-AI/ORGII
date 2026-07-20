//! Unified todo tool — session-scoped task tracking.
//!
//! Consolidates the former `todowrite` and `todoread` into a single
//! `manage_todo` tool with an `action` parameter. Persisted to SQLite in the
//! `agent_todos` table and broadcasts `agent:todos_updated` to the frontend
//! (Tauri IPC Channel) on writes.
//!
//! Design notes:
//! - `activeForm` field for present-continuous spinner labels
//! - `update` action for incremental changes (avoids full-list rewrites)
//! - Tool-result "please proceed" nudge so the LLM keeps driving the list

use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::persistence::db_helpers::todos as todo_persistence;
use crate::persistence::db_helpers::todos::{TodoRecord, TodoUpdate};
use crate::tools::names as tool_names;
use crate::tools::traits::{required_string, Tool, ToolError, ToolUIMetadata};

/// Shared session ID holder so the todo tool knows which session it belongs to.
/// Set via `set_session_key` before each turn.
#[derive(Default)]
pub struct TodoSessionContext {
    pub session_id: Mutex<Option<String>>,
}

impl TodoSessionContext {
    pub fn new() -> Self {
        Self::default()
    }
}

pub struct TodoTool {
    context: Arc<TodoSessionContext>,
}

impl TodoTool {
    pub fn new(context: Arc<TodoSessionContext>) -> Self {
        Self { context }
    }
}

/// Reminder appended to every successful write/update result. Kept as
/// a constant so both actions emit an identical string (eases LLM
/// cache re-use across turns).
const TODO_PROGRESS_NUDGE: &str = "Ensure that you continue to use the todo \
list to track your progress. Please proceed with the current tasks if \
applicable.";

/// Stale-todo `<system-reminder>` shared by the mid-turn injector
/// (`turn_executor`) and the turn-start dynamic section
/// (`processor/prompt.rs`). Mirrors the reference harness framing: gentle
/// ("ignore if not applicable") plus an explicit never-mention clause so the
/// nudge cannot leak into user-visible prose, with the current list snapshot
/// so the model can act without an extra read call.
pub fn stale_todo_reminder(todos: &[crate::persistence::db_helpers::todos::TodoRecord]) -> String {
    let mut reminder = String::from(
        "<system-reminder>The manage_todo tool hasn't been used recently. If you are \
         working on tasks that would benefit from tracking, update task statuses \
         (in_progress when starting a task, completed as soon as it is done). Only \
         do this if relevant to the current work. This is just a gentle reminder - \
         ignore if not applicable. NEVER mention this reminder to the user.",
    );
    if todos.is_empty() {
        reminder.push_str(" The todo list is currently empty.");
    } else {
        reminder.push_str("\nCurrent todo list:\n");
        for (idx, todo) in todos.iter().enumerate() {
            reminder.push_str(&format!("{}. [{}] {}\n", idx, todo.status, todo.content));
        }
    }
    reminder.push_str("</system-reminder>");
    reminder
}

const APPROVED_PLAN_LABEL: &str = "approved plan";
const IMPLEMENT_APPROVED_PLAN_LABEL: &str = "Implement approved plan";

fn is_internal_plan_artifact_token(token: &str) -> bool {
    if token.chars().any(char::is_whitespace) {
        return false;
    }
    let trimmed = token.trim_matches(|ch: char| {
        matches!(
            ch,
            '`' | '\'' | '"' | '(' | ')' | ',' | '.' | ';' | ':' | '!' | '?'
        )
    });
    let file_name = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    file_name.ends_with(".plan.md") && file_name.len() > ".plan.md".len()
}

fn sanitize_todo_text(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if is_internal_plan_artifact_token(trimmed) {
        return IMPLEMENT_APPROVED_PLAN_LABEL.to_string();
    }

    let sanitized = trimmed
        .split_whitespace()
        .map(|token| {
            if is_internal_plan_artifact_token(token) {
                let prefix: String = token
                    .chars()
                    .take_while(|ch| matches!(ch, '`' | '\'' | '"' | '('))
                    .collect();
                let suffix_chars: Vec<char> = token
                    .chars()
                    .rev()
                    .take_while(|ch| {
                        matches!(
                            ch,
                            '`' | '\'' | '"' | ')' | ',' | '.' | ';' | ':' | '!' | '?'
                        )
                    })
                    .collect();
                let suffix: String = suffix_chars.into_iter().rev().collect();
                format!("{}{}{}", prefix, APPROVED_PLAN_LABEL, suffix)
            } else {
                token.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    if sanitized == APPROVED_PLAN_LABEL {
        IMPLEMENT_APPROVED_PLAN_LABEL.to_string()
    } else {
        sanitized
    }
}

fn sanitize_required_todo_content(value: &str, idx: usize) -> Result<String, ToolError> {
    let content = sanitize_todo_text(value);
    if content.is_empty() {
        return Err(ToolError::InvalidParams(format!(
            "Todo {} has empty 'content'",
            idx
        )));
    }
    Ok(content)
}

fn sanitize_optional_todo_content(value: &str) -> Option<String> {
    let content = sanitize_todo_text(value);
    if content.is_empty() {
        None
    } else {
        Some(content)
    }
}

#[async_trait]
impl Tool for TodoTool {
    fn name(&self) -> &str {
        tool_names::MANAGE_TODO
    }

    fn description(&self) -> &str {
        // Single description because we keep one unified tool with an
        // `action` parameter rather than four separate tools.
        //
        // The order matters: "When to Use" comes first so the model reads
        // the triggers before the schema. The activeForm paragraph sits
        // right before the Actions block so in_progress rendering rules
        // are adjacent to the status enum.
        "Session-scoped task tracking: create, update, read, and query ready \
tasks for the current coding session. Use proactively and often to track \
progress and remaining work.\n\n\
## When to Use This Tool\n\
Use this tool proactively in these scenarios:\n\
- Complex multi-step tasks — when a task requires 3 or more distinct steps\n\
- Non-trivial tasks that require careful planning or multiple operations\n\
- Plan mode — after a plan is approved, create a task list to drive execution\n\
- User explicitly asks for a todo list or checklist\n\
- User provides multiple tasks (numbered or comma-separated)\n\
- After receiving new instructions — capture user requirements as todos immediately\n\
- When you start working on a task — mark it in_progress BEFORE beginning work\n\
- After completing a task — mark it completed and add any follow-up tasks discovered along the way\n\n\
## When NOT to Use This Tool\n\
Skip this tool when:\n\
- There is only a single, straightforward task\n\
- The task is trivial and tracking it provides no organizational benefit\n\
- The task can be completed in fewer than 3 trivial steps\n\
- The request is purely conversational or informational\n\n\
## Task Fields\n\
- **content** — imperative-form title (e.g. \"Run tests\", \"Fix auth bug in login flow\"). Do not use internal plan artifact paths or `.plan.md` filenames as task titles; say \"Implement approved plan\" or name the actual user-facing action instead.\n\
- **activeForm** *(optional)* — present-continuous form shown in the UI spinner while the task is in_progress (e.g. \"Running tests\"). If omitted, the UI falls back to content. Do not use internal plan artifact paths or `.plan.md` filenames here.\n\
- **status** — one of: pending, in_progress, completed, cancelled\n\
- **priority** — high | medium | low (default medium)\n\
- **blockedBy** *(optional)* — array of 0-based indices of tasks that must be completed before this one can start. Use to model sequential dependencies (e.g. task 2 blocked by task 0 and task 1). A task is \"ready\" when all its blockers are completed.\n\n\
## Task Management Rules\n\
- Exactly ONE task must be in_progress at a time (not zero, not two)\n\
- Mark tasks completed IMMEDIATELY after finishing — don't batch completions\n\
- When updating only status or priority, omit `content`; never pass an empty title\n\
- ONLY mark completed when you have FULLY accomplished the task. If tests fail, implementation is partial, or errors remain, keep it in_progress and create a follow-up task describing the blocker.\n\
- Remove tasks that are no longer relevant (status=cancelled or a full rewrite)\n\
- Use `blockedBy` when tasks have clear sequential dependencies so you always pick up the next unblocked task\n\n\
## Actions\n\
- **write** — replace the entire todo list for this session. Use to bootstrap the list or do a full rewrite. Parameters: `todos` (array).\n\
- **update** — patch a single todo in place by `index` (0-based). Use for every in_progress ↔ completed flip so you don't resend the whole list. Parameters: `index` (integer), plus any of `content`, `activeForm`, `status`, `priority`, `blockedBy`.\n\
- **read** — fetch the current todo list. Parameters: none.\n\
- **list_ready** — fetch only tasks that are pending AND have all their blockers completed (or have no blockers). Use to find the next task to work on when using dependency graphs. Parameters: none."
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "\"write\" to replace the list, \"update\" to patch one row by index, \"read\" to fetch all, \"list_ready\" to fetch only pending tasks with no outstanding blockers",
                    "enum": ["write", "update", "read", "list_ready"]
                },
                "todos": {
                    "type": "array",
                    "description": "Required for write. Full replacement list.",
                    "items": {
                        "type": "object",
                        "required": ["content", "status"],
                        "properties": {
                            "content": {
                                "type": "string",
                                "minLength": 1,
                                "description": "Imperative-form title (e.g. \"Run tests\")"
                            },
                            "activeForm": {
                                "type": "string",
                                "description": "Present-continuous form for the in_progress spinner (e.g. \"Running tests\"). Optional but recommended."
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed", "cancelled"]
                            },
                            "priority": {
                                "type": "string",
                                "enum": ["high", "medium", "low"]
                            },
                            "blockedBy": {
                                "type": "array",
                                "items": { "type": "integer", "minimum": 0 },
                                "description": "0-based indices of tasks that must be completed before this one. Omit or pass [] for no dependencies."
                            }
                        }
                    }
                },
                "index": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Required for update. 0-based position of the todo to patch."
                },
                "content": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Optional for update. New imperative-form title. Omit to keep the existing title; never pass an empty string."
                },
                "activeForm": {
                    "type": "string",
                    "description": "Optional for update. New present-continuous form; pass an empty string to clear."
                },
                "status": {
                    "type": "string",
                    "enum": ["pending", "in_progress", "completed", "cancelled"],
                    "description": "Optional for update. New status."
                },
                "priority": {
                    "type": "string",
                    "enum": ["high", "medium", "low"],
                    "description": "Optional for update. New priority."
                },
                "blockedBy": {
                    "type": "array",
                    "items": { "type": "integer", "minimum": 0 },
                    "description": "Optional for update. Replace the dependency list. Pass [] to clear all blockers."
                }
            },
            "required": ["action"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let action = required_string(&params, "action")?;
        let session_id = self.session_id(ctx).await?;

        match action.as_str() {
            "write" => self.exec_write(&session_id, &params).await,
            "update" => self.exec_update(&session_id, &params).await,
            "read" => self.exec_read(&session_id).await,
            "list_ready" => self.exec_list_ready(&session_id).await,
            other => Err(ToolError::InvalidParams(format!(
                "Unknown todo action: \"{}\". Use \"write\", \"update\", \"read\", or \"list_ready\".",
                other
            ))),
        }
    }

    async fn set_session_key(&self, session_key: &str) {
        *self.context.session_id.lock().await = Some(session_key.to_string());
    }

    /// Dual-track response: expose the exact todo snapshot as structured
    /// data so renderers never have to re-parse the LLM-facing text.
    /// `render_result` always embeds the snapshot as a pretty-printed JSON
    /// array between the header line and the nudge; parse it back out here.
    fn ui_metadata(&self, _params: &Value, result: &str) -> Option<ToolUIMetadata> {
        let todos = parse_embedded_todo_array(result)?;
        Some(ToolUIMetadata {
            display_type: "todo_list".to_string(),
            data: serde_json::json!({ "todos": todos }),
            summary: result.lines().next().map(str::to_string),
        })
    }
}

/// Extract the pretty-printed JSON array that `render_result` /
/// `exec_list_ready` embed in the tool's text output. Returns `None` for
/// outputs without a snapshot (e.g. "No todos for this session.").
fn parse_embedded_todo_array(result: &str) -> Option<Vec<Value>> {
    let start = result.find('[')?;
    let end = result.rfind(']')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Vec<Value>>(&result[start..=end]).ok()
}

impl TodoTool {
    /// Resolve attribution from the per-call context first. Production dispatch
    /// always populates it, so concurrent child sessions cannot overwrite the
    /// parent through the legacy registry-wide `set_session_key` slot.
    async fn session_id(
        &self,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        if !ctx.session_id.is_empty() {
            return Ok(ctx.session_id.clone());
        }

        self.context
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| ToolError::ExecutionFailed("No session context set".into()))
    }

    async fn exec_write(&self, session_id: &str, params: &Value) -> Result<String, ToolError> {
        let todos_raw = params
            .get("todos")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ToolError::InvalidParams("Missing or invalid 'todos' array".into()))?;

        let mut records: Vec<TodoRecord> = Vec::with_capacity(todos_raw.len());
        for (idx, todo) in todos_raw.iter().enumerate() {
            let content = sanitize_required_todo_content(
                todo.get("content")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        ToolError::InvalidParams(format!("Todo {} missing 'content'", idx))
                    })?,
                idx,
            )?;
            let active_form = todo
                .get("activeForm")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(sanitize_todo_text);
            let status = todo
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("pending")
                .to_string();
            let priority = todo
                .get("priority")
                .and_then(|v| v.as_str())
                .unwrap_or("medium")
                .to_string();
            let blocked_by = todo
                .get("blockedBy")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_u64().map(|n| n as usize))
                        .collect()
                })
                .unwrap_or_default();
            records.push(TodoRecord {
                content,
                active_form,
                status,
                priority,
                blocked_by,
            });
        }

        let sid = session_id.to_string();
        let records_clone = records.clone();
        tokio::task::spawn_blocking(move || todo_persistence::save_todos(&sid, &records_clone))
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("Join error: {}", err)))?
            .map_err(|err| ToolError::ExecutionFailed(format!("DB error: {}", err)))?;

        broadcast_todos(&session_id, &records);

        Ok(render_result(&records, TodoAction::Wrote))
    }

    async fn exec_update(&self, session_id: &str, params: &Value) -> Result<String, ToolError> {
        let index = params
            .get("index")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| ToolError::InvalidParams("'update' requires integer 'index'".into()))?
            as usize;

        let patch = TodoUpdate {
            content: params
                .get("content")
                .and_then(|v| v.as_str())
                .and_then(sanitize_optional_todo_content),
            // Empty string clears `activeForm` (stored as None); a missing
            // key leaves it untouched. The outer Option distinguishes the
            // two, the inner Option is the stored value.
            active_form: params.get("activeForm").map(|v| {
                v.as_str().and_then(|s| {
                    if s.is_empty() {
                        None
                    } else {
                        Some(sanitize_todo_text(s))
                    }
                })
            }),
            status: params
                .get("status")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            priority: params
                .get("priority")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            blocked_by: params
                .get("blockedBy")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_u64().map(|n| n as usize))
                        .collect()
                }),
        };

        let sid = session_id.to_string();
        let patch_clone = patch.clone();
        let existed = tokio::task::spawn_blocking(move || {
            todo_persistence::update_todo(&sid, index, &patch_clone)
        })
        .await
        .map_err(|err| ToolError::ExecutionFailed(format!("Join error: {}", err)))?
        .map_err(|err| ToolError::ExecutionFailed(format!("DB error: {}", err)))?;

        if !existed {
            return Err(ToolError::InvalidParams(format!(
                "No todo at index {} for this session",
                index
            )));
        }

        // Refetch the full list so the broadcast + nudge reflect the new
        // state without racing a separate read. Cheap: session todo lists
        // are small (rarely over ~20 rows).
        let sid2 = session_id.to_string();
        let records = tokio::task::spawn_blocking(move || todo_persistence::get_todos(&sid2))
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("Join error: {}", err)))?
            .map_err(|err| ToolError::ExecutionFailed(format!("DB error: {}", err)))?;

        broadcast_todos(&session_id, &records);

        Ok(render_result(&records, TodoAction::Updated(index)))
    }

    async fn exec_read(&self, session_id: &str) -> Result<String, ToolError> {
        let sid = session_id.to_string();
        let records = tokio::task::spawn_blocking(move || todo_persistence::get_todos(&sid))
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("Join error: {}", err)))?
            .map_err(|err| ToolError::ExecutionFailed(format!("DB error: {}", err)))?;

        if records.is_empty() {
            return Ok("No todos for this session.".to_string());
        }

        Ok(render_result(&records, TodoAction::Read))
    }

    async fn exec_list_ready(&self, session_id: &str) -> Result<String, ToolError> {
        let sid = session_id.to_string();
        let all_records = tokio::task::spawn_blocking(move || todo_persistence::get_todos(&sid))
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("Join error: {}", err)))?
            .map_err(|err| ToolError::ExecutionFailed(format!("DB error: {}", err)))?;

        if all_records.is_empty() {
            return Ok("No todos for this session.".to_string());
        }

        let ready: Vec<(usize, &TodoRecord)> = all_records
            .iter()
            .enumerate()
            .filter(|(_, r)| r.status == "pending" && is_ready(r, &all_records))
            .collect();

        if ready.is_empty() {
            return Ok(
                "No ready tasks — all pending tasks are waiting on blockers (or none exist)."
                    .to_string(),
            );
        }

        let json_items: Vec<Value> = ready
            .iter()
            .map(|(idx, todo)| {
                let mut obj = serde_json::json!({
                    "index": idx,
                    "content": todo.content,
                    "activeForm": todo.active_form,
                    "status": todo.status,
                    "priority": todo.priority,
                });
                if !todo.blocked_by.is_empty() {
                    obj["blockedBy"] = serde_json::json!(todo.blocked_by);
                }
                obj
            })
            .collect();

        let output = serde_json::to_string_pretty(&json_items)
            .expect("Vec<Value> serialization is infallible");
        Ok(format!(
            "{} ready task(s) (pending with all blockers completed)\n{}",
            ready.len(),
            output
        ))
    }
}

#[derive(Clone, Copy)]
enum TodoAction {
    Wrote,
    Updated(usize),
    Read,
}

fn records_to_json(records: &[TodoRecord]) -> Vec<Value> {
    records
        .iter()
        .enumerate()
        .map(|(idx, todo)| {
            let mut obj = serde_json::json!({
                "index": idx,
                "content": todo.content,
                "activeForm": todo.active_form,
                "status": todo.status,
                "priority": todo.priority,
            });
            if !todo.blocked_by.is_empty() {
                obj["blockedBy"] = serde_json::json!(todo.blocked_by);
            }
            obj
        })
        .collect()
}

/// Returns `true` if every task listed in `blocked_by` has status
/// `"completed"` or `"cancelled"`. Missing indices are treated as
/// completed (defensive: the index was already removed via a rewrite).
fn is_ready(record: &TodoRecord, all: &[TodoRecord]) -> bool {
    record.blocked_by.iter().all(|&blocker_idx| {
        all.get(blocker_idx)
            .map(|blocker| blocker.status == "completed" || blocker.status == "cancelled")
            .unwrap_or(true)
    })
}

fn render_result(records: &[TodoRecord], action: TodoAction) -> String {
    let json_items = records_to_json(records);
    let pending_count = records.iter().filter(|r| r.status != "completed").count();
    let output =
        serde_json::to_string_pretty(&json_items).expect("Vec<Value> serialization is infallible");

    let header = match action {
        TodoAction::Wrote => format!("{} todos ({} remaining)", records.len(), pending_count),
        TodoAction::Updated(idx) => format!(
            "Updated todo #{} — {} todos ({} remaining)",
            idx,
            records.len(),
            pending_count
        ),
        TodoAction::Read => format!("{} todos ({} remaining)", records.len(), pending_count),
    };

    match action {
        // Reads are neutral information retrieval — no progress nudge.
        TodoAction::Read => format!("{}\n{}", header, output),
        // Writes and updates are mutations; append a progress nudge so
        // the model keeps driving the checklist rather than narrating
        // next steps in prose.
        TodoAction::Wrote | TodoAction::Updated(_) => {
            format!("{}\n{}\n\n{}", header, output, TODO_PROGRESS_NUDGE)
        }
    }
}

fn broadcast_todos(session_id: &str, records: &[TodoRecord]) {
    crate::bus::broadcast_event(
        "agent:todos_updated",
        serde_json::json!({
            "sessionId": session_id,
            "todos": records_to_json(records),
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::{
        parse_embedded_todo_array, sanitize_optional_todo_content, sanitize_required_todo_content,
        sanitize_todo_text,
    };

    #[test]
    fn sanitize_todo_text_replaces_standalone_internal_plan_artifacts() {
        assert_eq!(
            sanitize_todo_text("plan_subagent.plan.md"),
            "Implement approved plan"
        );
        assert_eq!(
            sanitize_todo_text(".orgii/plans/plan_sdeagent.plan.md"),
            "Implement approved plan"
        );
    }

    #[test]
    fn sanitize_todo_text_replaces_internal_plan_artifacts_inside_titles() {
        assert_eq!(
            sanitize_todo_text("Read plan_subagent.plan.md"),
            "Read approved plan"
        );
        assert_eq!(
            sanitize_todo_text("Implement tasks from `.orgii/plans/foo.plan.md`"),
            "Implement tasks from `approved plan`"
        );
    }

    #[test]
    fn sanitize_required_todo_content_rejects_empty_after_trim() {
        let err = sanitize_required_todo_content("   ", 3).unwrap_err();
        assert!(
            err.to_string().contains("Todo 3 has empty 'content'"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn sanitize_optional_todo_content_drops_empty_update_patch() {
        assert_eq!(sanitize_optional_todo_content("   "), None);
        assert_eq!(
            sanitize_optional_todo_content(" Update docs "),
            Some("Update docs".to_string())
        );
    }

    #[tokio::test]
    async fn call_context_session_wins_over_shared_registry_session() {
        let context = std::sync::Arc::new(super::TodoSessionContext::new());
        let tool = super::TodoTool::new(std::sync::Arc::clone(&context));
        *context.session_id.lock().await = Some("child-session".to_string());

        let call_ctx =
            crate::tools::call_context::CallContext::new("call-parent", "parent-session");

        assert_eq!(
            tool.session_id(&call_ctx).await.expect("session id"),
            "parent-session"
        );
    }

    #[tokio::test]
    async fn stored_session_remains_fallback_for_direct_callers() {
        let context = std::sync::Arc::new(super::TodoSessionContext::new());
        let tool = super::TodoTool::new(std::sync::Arc::clone(&context));
        *context.session_id.lock().await = Some("direct-session".to_string());

        assert_eq!(
            tool.session_id(&crate::tools::call_context::CallContext::default())
                .await
                .expect("fallback session id"),
            "direct-session"
        );
    }

    #[test]
    fn parameters_require_non_empty_todo_content_when_present() {
        let tool = super::TodoTool::new(std::sync::Arc::new(super::TodoSessionContext::new()));
        let parameters = crate::tools::traits::Tool::parameters(&tool);

        assert_eq!(
            parameters.pointer("/properties/todos/items/properties/content/minLength"),
            Some(&serde_json::json!(1))
        );
        assert_eq!(
            parameters.pointer("/properties/content/minLength"),
            Some(&serde_json::json!(1))
        );
    }

    #[test]
    fn sanitize_todo_text_preserves_normal_markdown_targets() {
        assert_eq!(
            sanitize_todo_text("Create orgii-plan-updated-123.md"),
            "Create orgii-plan-updated-123.md"
        );
    }

    #[test]
    fn parse_embedded_todo_array_round_trips_render_result_output() {
        let records = vec![
            super::TodoRecord {
                content: "Fix bug".to_string(),
                active_form: Some("Fixing bug".to_string()),
                status: "in_progress".to_string(),
                priority: "high".to_string(),
                blocked_by: vec![],
            },
            super::TodoRecord {
                content: "Write tests".to_string(),
                active_form: None,
                status: "pending".to_string(),
                priority: "medium".to_string(),
                blocked_by: vec![0],
            },
        ];
        let rendered = super::render_result(&records, super::TodoAction::Updated(0));
        let parsed = parse_embedded_todo_array(&rendered).expect("snapshot must parse");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["content"], "Fix bug");
        assert_eq!(parsed[0]["activeForm"], "Fixing bug");
        assert_eq!(parsed[1]["blockedBy"], serde_json::json!([0]));
    }

    #[test]
    fn parse_embedded_todo_array_rejects_no_snapshot_output() {
        assert!(parse_embedded_todo_array("No todos for this session.").is_none());
    }
}
