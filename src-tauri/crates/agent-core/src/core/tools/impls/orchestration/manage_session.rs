//! Unified session management tool: `session`.
//!
//! Consolidates the former `session_create`, `session_monitor`, and
//! `session_intervene` into a single tool with an `action` parameter.
//! All actions route through the frontend ActionSystem via the `ActionBridge`
//! request/response mechanism (events delivered over the Tauri IPC Channel,
//! results returned via the `agent_ade_action_result` Tauri command).

use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

use crate::tools::impls::web::control_orgii::{execute_gui_action_with_timeout, ActionBridge};
use crate::tools::names as tool_names;
use crate::tools::traits::{optional_bool, optional_string, required_string, Tool, ToolError};

/// Timeout for session actions (seconds).
const SESSION_ACTION_TIMEOUT_SECS: u64 = 30;

pub struct SessionTool {
    bridge: Arc<ActionBridge>,
    session_account_id: Option<String>,
    agent_model: String,
}

impl SessionTool {
    pub fn new(
        bridge: Arc<ActionBridge>,
        session_account_id: Option<String>,
        agent_model: String,
    ) -> Self {
        Self {
            bridge,
            session_account_id,
            agent_model,
        }
    }
}

#[async_trait]
impl Tool for SessionTool {
    fn name(&self) -> &str {
        tool_names::MANAGE_SESSION
    }

    fn category(&self) -> &str {
        crate::tools::categories::SESSION
    }

    fn description(&self) -> &str {
        "Manage coding agent sessions: propose, create, monitor, intervene, and update metadata.\n\n\
         ## Actions\n\
         - **propose** — PREFERRED for ADE Manager: surface a pre-filled session proposal card \
           to the user and wait for confirmation before launching. Use this whenever you are \
           suggesting a new session on the user's behalf — it shows the task, repo, and agent \
           to the user who can edit and approve. The session is only created after approval. \
           IMPORTANT: call propose at most ONCE per turn. Do not propose multiple sessions in \
           the same response — propose one, wait for the result, then stop. Only propose \
           another session in a subsequent turn after the user has interacted.\n\
         - **create** — Immediately start a new agent session. Only use when the user has \
           explicitly confirmed they want a session launched right now (e.g. after a propose \
           was already shown and approved). Do NOT use create as the first step — use propose \
           instead. Also limited to one call per turn.\n\
         - **list** — List sessions, optionally filtered by status\n\
         - **get_status** — Get detailed status of a session (includes pending questions)\n\
         - **send_message** — Send a text follow-up or instruction to a session\n\
         - **answer_question** — Answer a pending question (get question_id from get_status)\n\
         - **pause** / **resume** / **cancel** — Lifecycle control\n\
         - **open** — Navigate to the session workspace in the IDE\n\
         - **upload_file** — Upload a file to the session context\n\
         - **merge** — Merge a completed session's worktree branch\n\
         - **rename** — Rename a session (sets the display name)\n\
         - **update_stats** — Write outcome stats (commits, PRs, file/line changes) to the session record"
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "Action to perform. Use 'propose' (not 'create') when suggesting a new session — it shows a confirmation card to the user first.",
                    "enum": [
                        "propose", "create", "list", "get_status",
                        "send_message", "answer_question",
                        "pause", "resume", "cancel", "open", "upload_file", "merge",
                        "rename", "update_stats"
                    ]
                },
                "task": {
                    "type": "string",
                    "description": "Task description (for create)"
                },
                "session_id": {
                    "type": "string",
                    "description": "Target session ID (required for most actions except create/list)"
                },
                "repo_path": {
                    "type": "string",
                    "description": "Repository path (for create, defaults to current workspace)"
                },
                "name": {
                    "type": "string",
                    "description": "Session name (for create, defaults to first 60 chars of task)"
                },
                "model": {
                    "type": "string",
                    "description": "Override LLM model (for create)"
                },
                "account_id": {
                    "type": "string",
                    "description": "Override account ID (for create)"
                },
                "agent_definition_id": {
                    "type": "string",
                    "description": "Agent definition ID (for create)"
                },
                "status": {
                    "type": "string",
                    "description": "Filter by status (for list)"
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (for list)"
                },
                "content": {
                    "type": "string",
                    "description": "Message content (for send_message)"
                },
                "question_id": {
                    "type": "string",
                    "description": "Question ID (for answer_question, from get_status)"
                },
                "answer": {
                    "type": "string",
                    "description": "Answer text (for answer_question)"
                },
                "file_path": {
                    "type": "string",
                    "description": "Local file path (for upload_file)"
                },
                "force": {
                    "type": "boolean",
                    "description": "Force cancel without graceful shutdown (for cancel)"
                },
                "merge_strategy": {
                    "type": "string",
                    "description": "Merge strategy: \"auto\", \"leave\", or \"ff\" (for merge, default: auto)",
                    "enum": ["auto", "leave", "ff"]
                },
                "new_name": {
                    "type": "string",
                    "description": "New display name for the session (for rename)"
                },
                "commit_count": {
                    "type": "integer",
                    "description": "Number of git commits made this session (for update_stats)"
                },
                "pr_count": {
                    "type": "integer",
                    "description": "Number of pull requests opened this session (for update_stats)"
                },
                "pr_url": {
                    "type": "string",
                    "description": "URL of the primary PR opened (for update_stats; omit to leave unchanged, pass empty string to clear)"
                },
                "files_changed": {
                    "type": "integer",
                    "description": "Distinct files changed this session (for update_stats)"
                },
                "lines_added": {
                    "type": "integer",
                    "description": "Lines added across all edits this session (for update_stats)"
                },
                "lines_removed": {
                    "type": "integer",
                    "description": "Lines removed across all edits this session (for update_stats)"
                },
                "branch": {
                    "type": "string",
                    "description": "Git branch to append to this session's branch history (for update_stats). Safe to call on every turn — server deduplicates. For worktree sessions the branch is already recorded automatically; use this for mid-session branch switches in the main workspace."
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
        ctx.require_tool_authority(self.name())?;
        let action = required_string(&params, "action")?;

        match action.as_str() {
            "propose" => self.exec_propose(&params).await,
            "create" => self.exec_create(&params).await,
            "list" => self.exec_list(&params).await,
            "get_status" => self.exec_get_status(&params).await,
            "rename" => self.exec_rename(&params).await,
            "update_stats" => self.exec_update_stats(&params).await,
            "send_message" | "answer_question" | "pause" | "resume" | "cancel" | "open"
            | "upload_file" | "merge" => self.exec_intervene(&action, &params).await,
            other => Err(ToolError::InvalidParams(format!(
                "Unknown session action: \"{}\". Use propose, create, list, get_status, \
                 send_message, answer_question, pause, resume, cancel, open, upload_file, \
                 merge, rename, or update_stats.",
                other
            ))),
        }
    }
}

impl SessionTool {
    /// Propose a new session to the user — shows a confirmation card in the ADE Manager
    /// palette with pre-filled parameters. The Rust agent blocks until the user approves
    /// or rejects (up to 5 minutes). If approved the session is created by the frontend
    /// and the new session ID is returned. If rejected or timed out, returns an error so
    /// the agent knows to stop.
    async fn exec_propose(&self, params: &Value) -> Result<String, ToolError> {
        let task = required_string(params, "task")?;
        let mut inner = serde_json::json!({ "task": task });

        if let Some(repo_path) = optional_string(params, "repo_path") {
            inner["repoPath"] = Value::String(repo_path);
        }
        if let Some(name) = optional_string(params, "name") {
            inner["name"] = Value::String(name);
        }
        if let Some(model) = optional_string(params, "model") {
            inner["model"] = Value::String(model);
        }
        if let Some(def_id) = optional_string(params, "agent_definition_id") {
            inner["agentDefinitionId"] = Value::String(def_id);
        }

        let bridge_params = serde_json::json!({
            "action": "session.propose",
            "params": inner
        });

        // Use a longer timeout — the user needs time to read and confirm.
        execute_gui_action_with_timeout(
            &self.bridge,
            "session",
            bridge_params,
            5 * 60, // 5 minutes
        )
        .await
    }

    async fn exec_create(&self, params: &Value) -> Result<String, ToolError> {
        let task = required_string(params, "task")?;
        let mut inner = serde_json::json!({ "task": task });

        if let Some(repo_path) = optional_string(params, "repo_path") {
            inner["repoPath"] = Value::String(repo_path);
        }
        if let Some(name) = optional_string(params, "name") {
            inner["name"] = Value::String(name);
        }

        let account_id = optional_string(params, "account_id");
        let model = optional_string(params, "model");

        let effective_account_id = if account_id.is_some() {
            account_id
        } else {
            self.session_account_id.clone()
        };
        if let Some(acct) = effective_account_id {
            inner["accountId"] = Value::String(acct);
        }

        let effective_model = if model.is_some() {
            model
        } else if self.agent_model.is_empty() {
            None
        } else {
            Some(self.agent_model.clone())
        };
        if let Some(model_val) = effective_model {
            inner["model"] = Value::String(model_val);
        }

        if let Some(def_id) = optional_string(params, "agent_definition_id") {
            inner["agentDefinitionId"] = Value::String(def_id);
        }

        let bridge_params = serde_json::json!({
            "action": "session.create",
            "params": inner
        });

        execute_gui_action_with_timeout(
            &self.bridge,
            "session",
            bridge_params,
            SESSION_ACTION_TIMEOUT_SECS,
        )
        .await
    }

    async fn exec_list(&self, params: &Value) -> Result<String, ToolError> {
        let mut inner = serde_json::json!({});
        if let Some(status) = optional_string(params, "status") {
            inner["status"] = Value::String(status);
        }
        if let Some(limit) = params.get("limit").and_then(|v| v.as_i64()) {
            inner["limit"] = Value::Number(serde_json::Number::from(limit));
        }

        let bridge_params = serde_json::json!({
            "action": "session.list",
            "params": inner
        });

        execute_gui_action_with_timeout(
            &self.bridge,
            "session",
            bridge_params,
            SESSION_ACTION_TIMEOUT_SECS,
        )
        .await
    }

    async fn exec_get_status(&self, params: &Value) -> Result<String, ToolError> {
        let session_id = required_string(params, "session_id")?;

        let bridge_params = serde_json::json!({
            "action": "session.getStatus",
            "params": { "sessionId": session_id }
        });

        execute_gui_action_with_timeout(
            &self.bridge,
            "session",
            bridge_params,
            SESSION_ACTION_TIMEOUT_SECS,
        )
        .await
    }

    async fn exec_rename(&self, params: &Value) -> Result<String, ToolError> {
        let session_id = required_string(params, "session_id")?;
        let new_name = required_string(params, "new_name")?;

        let bridge_params = serde_json::json!({
            "action": "session.patch",
            "params": {
                "sessionId": session_id,
                "name": new_name
            }
        });

        execute_gui_action_with_timeout(
            &self.bridge,
            "session",
            bridge_params,
            SESSION_ACTION_TIMEOUT_SECS,
        )
        .await
    }

    async fn exec_update_stats(&self, params: &Value) -> Result<String, ToolError> {
        let session_id = required_string(params, "session_id")?;

        // Build a minimal patch containing only the stats fields that were provided.
        let mut patch = serde_json::json!({ "sessionId": session_id });

        if let Some(val) = params.get("commit_count").and_then(|v| v.as_i64()) {
            patch["commitCount"] = Value::Number(serde_json::Number::from(val));
        }
        if let Some(val) = params.get("pr_count").and_then(|v| v.as_i64()) {
            patch["prCount"] = Value::Number(serde_json::Number::from(val));
        }
        if let Some(pr_url) = params.get("pr_url") {
            if pr_url.is_null() || pr_url.as_str().map(str::is_empty).unwrap_or(false) {
                patch["prUrl"] = Value::Null;
            } else if let Some(url_str) = pr_url.as_str() {
                patch["prUrl"] = Value::String(url_str.to_string());
            }
        }
        if let Some(val) = params.get("files_changed").and_then(|v| v.as_i64()) {
            patch["filesChanged"] = Value::Number(serde_json::Number::from(val));
        }
        if let Some(val) = params.get("lines_added").and_then(|v| v.as_i64()) {
            patch["linesAdded"] = Value::Number(serde_json::Number::from(val));
        }
        if let Some(val) = params.get("lines_removed").and_then(|v| v.as_i64()) {
            patch["linesRemoved"] = Value::Number(serde_json::Number::from(val));
        }
        if let Some(branch) = params.get("branch").and_then(|v| v.as_str()) {
            let trimmed = branch.trim();
            if !trimmed.is_empty() {
                patch["branch"] = Value::String(trimmed.to_string());
            }
        }

        let bridge_params = serde_json::json!({
            "action": "session.patch",
            "params": patch
        });

        execute_gui_action_with_timeout(
            &self.bridge,
            "session",
            bridge_params,
            SESSION_ACTION_TIMEOUT_SECS,
        )
        .await
    }

    async fn exec_intervene(&self, action: &str, params: &Value) -> Result<String, ToolError> {
        let session_id = required_string(params, "session_id")?;

        let (action_id, action_params) = match action {
            "send_message" => {
                let content = required_string(params, "content")?;
                (
                    "session.sendMessage",
                    serde_json::json!({
                        "sessionId": session_id,
                        "content": content
                    }),
                )
            }

            "answer_question" => {
                let question_id = required_string(params, "question_id")?;
                let answer = required_string(params, "answer")?;
                (
                    "session.answerQuestion",
                    serde_json::json!({
                        "sessionId": session_id,
                        "questionId": question_id,
                        "answer": answer
                    }),
                )
            }

            "pause" => (
                "session.pause",
                serde_json::json!({ "sessionId": session_id }),
            ),

            "resume" => (
                "session.resume",
                serde_json::json!({ "sessionId": session_id }),
            ),

            "cancel" => {
                let mut inner = serde_json::json!({ "sessionId": session_id });
                if let Some(force) = optional_bool(params, "force") {
                    inner["force"] = Value::Bool(force);
                }
                ("session.cancel", inner)
            }

            "open" => (
                "session.open",
                serde_json::json!({ "sessionId": session_id }),
            ),

            "upload_file" => {
                let file_path = required_string(params, "file_path")?;
                (
                    "session.uploadFile",
                    serde_json::json!({
                        "sessionId": session_id,
                        "filePath": file_path
                    }),
                )
            }

            "merge" => {
                let strategy =
                    optional_string(params, "merge_strategy").unwrap_or_else(|| "auto".to_string());
                (
                    "session.merge",
                    serde_json::json!({
                        "sessionId": session_id,
                        "strategy": strategy
                    }),
                )
            }

            other => {
                return Err(ToolError::InvalidParams(format!(
                    "Unknown intervene action: \"{}\"",
                    other
                )));
            }
        };

        let bridge_params = serde_json::json!({
            "action": action_id,
            "params": action_params
        });

        execute_gui_action_with_timeout(
            &self.bridge,
            "session",
            bridge_params,
            SESSION_ACTION_TIMEOUT_SECS,
        )
        .await
    }
}
