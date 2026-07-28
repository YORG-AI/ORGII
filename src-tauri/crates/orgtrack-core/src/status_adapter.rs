//! Unified live-status normalizer for agent lifecycle hooks.
//!
//! Sibling of [`crate::hook_adapter`]: vendor lifecycle payloads are accepted
//! only at this boundary and reduced to one [`AgentStatusEventV1`] per hook
//! invocation. Per-CLI event vocabularies map into a single four-state
//! machine so every surface (managed sessions, imported sessions, sidebar)
//! classifies liveness the same way.
//!
//! Privacy: unlike provenance envelopes these events carry short previews
//! (tool name/input, permission question) for "currently running X" display.
//! They are never persisted to `sessions.db` — only an in-memory map and the
//! owner-only `last-status.json` cache hold them. Prompts and assistant text
//! are never captured.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hook_adapter::{
    normalize_rfc3339, now_rfc3339, source_session_id, string_field, HookSource,
};

pub const AGENT_STATUS_SCHEMA_VERSION: u32 = 1;

const MAX_TOOL_NAME_CHARS: usize = 60;
const MAX_TOOL_INPUT_PREVIEW_CHARS: usize = 160;
const MAX_INTERACTIVE_PROMPT_CHARS: usize = 500;

/// Canonical id for a hook session, shared with the provenance adapter so a
/// status event and its imported transcript resolve to the same session row.
pub fn canonical_session_id_for(
    source: HookSource,
    source_session_id: &str,
    payload: &Value,
) -> String {
    source.canonical_session_id(source_session_id, payload)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentLiveState {
    Working,
    Waiting,
    Done,
    Failed,
}

impl AgentLiveState {
    /// Map into the existing session-status vocabulary
    /// (`session_directory/status.rs::ACTIVE_STATUSES`, frontend
    /// `TERMINAL_STATUSES`) so no classifier or status-dot component
    /// needs a new case.
    pub fn as_session_status_str(self) -> &'static str {
        match self {
            Self::Working => "running",
            Self::Waiting => "waiting_for_user",
            Self::Done => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusEventV1 {
    pub schema_version: u32,
    /// `HookSource::as_source_str()` value (e.g. `claude_code`).
    pub source: String,
    pub source_session_id: String,
    /// Canonical id (`claudecodeapp-<uuid>`, `codexapp-<stem>`, ...), equal to
    /// the imported-history cache key and `orgtrack_core_sessions.session_id`.
    pub session_id: String,
    pub state: AgentLiveState,
    /// Vendor event name, for diagnostics only — consumers switch on `state`.
    pub event_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_input_preview: Option<String>,
    /// Permission/question text a Waiting state is blocked on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interactive_prompt: Option<String>,
    #[serde(default)]
    pub is_interrupt: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// `ORGII_SESSION_ID` env passthrough for GUI-launched sessions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orgii_session_id: Option<String>,
    pub occurred_at: String,
}

/// One entry point per hook invocation. Returns `None` for events with no
/// status semantics (unknown names, idle TUI opens, notifications).
pub fn normalize_status_payload(
    source: HookSource,
    payload: &Value,
    orgii_session_id: Option<String>,
) -> Option<AgentStatusEventV1> {
    let event_name = string_field(payload, &["hook_event_name", "hookEventName", "event"])?;
    let source_session_id = source_session_id(source, payload)?;
    let state = state_for_event(source, &event_name, payload)?;

    // Subagent lifecycle events describe activity inside a parent turn;
    // attribute them to the parent (Codex child-rollout stem guard included).
    let session_id = if is_subagent_event(&event_name) {
        source.canonical_lifecycle_session_id(&source_session_id, payload)
    } else {
        source.canonical_session_id(&source_session_id, payload)
    };

    let (tool_name, tool_input_preview) = tool_snapshot(source, payload);
    let interactive_prompt = if state == AgentLiveState::Waiting {
        interactive_prompt(payload, tool_name.as_deref())
    } else {
        None
    };

    Some(AgentStatusEventV1 {
        schema_version: AGENT_STATUS_SCHEMA_VERSION,
        source: source.as_source_str().to_string(),
        source_session_id,
        session_id,
        state,
        is_interrupt: is_interrupt(source, &event_name, payload),
        event_name,
        tool_name,
        tool_input_preview,
        interactive_prompt,
        cwd: string_field(payload, &["cwd", "workspace_path", "workspacePath"]),
        orgii_session_id,
        occurred_at: string_field(payload, &["timestamp", "occurred_at", "occurredAt"])
            .and_then(|timestamp| normalize_rfc3339(&timestamp))
            .unwrap_or_else(now_rfc3339),
    })
}

/// Case/format-insensitive event key: strips non-alphanumerics and lowercases,
/// so `UserPromptSubmit`, `user_prompt_submit`, and `userPromptSubmit` unify.
fn event_key(event_name: &str) -> String {
    event_name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn is_subagent_event(event_name: &str) -> bool {
    matches!(
        event_key(event_name).as_str(),
        "subagentstart" | "subagentstop"
    )
}

fn state_for_event(
    source: HookSource,
    event_name: &str,
    payload: &Value,
) -> Option<AgentLiveState> {
    use AgentLiveState::*;
    let key = event_key(event_name);
    match source {
        // Claude-family vocabularies. Qwen/Trae/ZCode are unverified but emit
        // Claude-shaped payloads; the normalizer accepts the family names and
        // the installer gates which events actually get installed per CLI.
        HookSource::ClaudeCode
        | HookSource::QwenCode
        | HookSource::FactoryDroid
        | HookSource::Trae
        | HookSource::ZCode
        | HookSource::Kimi => match key.as_str() {
            "userpromptsubmit" | "pretooluse" | "posttooluse" | "posttoolusefailure"
            | "postcompaction" => {
                // Kimi models "ask the user" as a tool call rather than a
                // PermissionRequest event.
                if source == HookSource::Kimi
                    && key == "pretooluse"
                    && tool_snapshot(source, payload)
                        .0
                        .is_some_and(|name| name.eq_ignore_ascii_case("AskUserQuestion"))
                {
                    return Some(Waiting);
                }
                Some(Working)
            }
            "permissionrequest" => Some(Waiting),
            "stop" => Some(Done),
            "stopfailure" => Some(Failed),
            // SessionStart fires when a TUI opens/resumes while idle;
            // Notification carries no turn semantics. Mapping either to
            // Working would show a spinner before the user typed anything.
            _ => None,
        },
        HookSource::Codex => match key.as_str() {
            "sessionstart" | "userpromptsubmit" | "pretooluse" | "posttooluse"
            | "subagentstart" | "subagentstop" => Some(Working),
            "permissionrequest" => Some(Waiting),
            "stop" => Some(Done),
            _ => None,
        },
        HookSource::Cursor => match key.as_str() {
            "beforesubmitprompt" | "pretooluse" | "posttooluse" | "posttoolusefailure"
            | "afteragentresponse" | "subagentstart" | "subagentstop" => Some(Working),
            // Cursor has no waiting/permission vocabulary.
            "stop" | "sessionend" => Some(Done),
            _ => None,
        },
        HookSource::Antigravity => match key.as_str() {
            "preinvocation" | "postinvocation" | "pretooluse" | "posttooluse" => {
                match tool_snapshot(source, payload).0 {
                    Some(name)
                        if name.eq_ignore_ascii_case("ask_question")
                            || name.eq_ignore_ascii_case("ask_permission") =>
                    {
                        Some(Waiting)
                    }
                    _ => Some(Working),
                }
            }
            // Antigravity keeps emitting Stop while background work continues.
            "stop" => {
                if payload.get("fullyIdle").and_then(Value::as_bool) == Some(false) {
                    Some(Working)
                } else {
                    Some(Done)
                }
            }
            _ => None,
        },
        // Synthetic names emitted by the managed OpenCode plugin.
        HookSource::OpenCode => match key.as_str() {
            "sessionbusy" | "messagepart" => Some(Working),
            "permissionrequest" | "askuserquestion" => Some(Waiting),
            "sessionidle" => Some(Done),
            "sessionerror" => Some(Failed),
            _ => None,
        },
        // Windsurf only exposes tool-level events: treat every known verb as a
        // Working heartbeat; Done comes from the registry's staleness fallback.
        HookSource::Windsurf => match key.as_str() {
            "prereadcode" | "postreadcode" | "prewritecode" | "postwritecode" | "runcommand"
            | "pretooluse" | "posttooluse" => Some(Working),
            _ => None,
        },
    }
}

fn is_interrupt(source: HookSource, event_name: &str, payload: &Value) -> bool {
    let key = event_key(event_name);
    match source {
        HookSource::Cursor => {
            (key == "stop" || key == "sessionend")
                && string_field(payload, &["status"])
                    .is_some_and(|status| !status.eq_ignore_ascii_case("completed"))
        }
        _ => {
            key == "stop"
                && payload
                    .get("is_interrupt")
                    .or_else(|| payload.get("isInterrupt"))
                    .and_then(Value::as_bool)
                    == Some(true)
        }
    }
}

/// Tool name + compact input preview, both char-capped.
fn tool_snapshot(source: HookSource, payload: &Value) -> (Option<String>, Option<String>) {
    // Antigravity nests the tool under `toolCall` (name + args) rather than
    // the Claude-family flat `tool_name` / `tool_input`.
    let (name, input) = if source == HookSource::Antigravity {
        let call = payload.get("toolCall").or_else(|| payload.get("tool_call"));
        let name = call
            .and_then(|call| string_field(call, &["name", "ToolName", "toolName"]))
            .or_else(|| {
                call.and_then(|call| call.get("args").or_else(|| call.get("Args")))
                    .and_then(|args| string_field(args, &["ToolName", "tool_name", "toolName"]))
            });
        let input = call.and_then(|call| call.get("args").or_else(|| call.get("Args")));
        (name, input)
    } else {
        (
            string_field(payload, &["tool_name", "toolName", "tool"]),
            payload
                .get("tool_input")
                .or_else(|| payload.get("toolInput")),
        )
    };

    let preview = input.and_then(|input| {
        let compact = match input {
            Value::String(text) => text.trim().to_string(),
            Value::Null => return None,
            other => serde_json::to_string(other).ok()?,
        };
        if compact.is_empty() || compact == "{}" {
            return None;
        }
        Some(truncate_chars(&compact, MAX_TOOL_INPUT_PREVIEW_CHARS))
    });

    (
        name.map(|name| truncate_chars(&name, MAX_TOOL_NAME_CHARS)),
        preview,
    )
}

fn interactive_prompt(payload: &Value, tool_name: Option<&str>) -> Option<String> {
    let text = string_field(
        payload,
        &["message", "prompt", "question", "permission_prompt"],
    )
    .or_else(|| tool_name.map(|name| format!("Permission requested: {name}")))?;
    Some(truncate_chars(&text, MAX_INTERACTIVE_PROMPT_CHARS))
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn claude_payload(event: &str) -> Value {
        json!({
            "session_id": "11111111-2222-3333-4444-555555555555",
            "hook_event_name": event,
            "cwd": "/repo",
            "timestamp": "2026-07-17T10:00:00.000Z",
        })
    }

    #[test]
    fn claude_events_map_to_expected_states() {
        let cases = [
            ("UserPromptSubmit", Some(AgentLiveState::Working)),
            ("PreToolUse", Some(AgentLiveState::Working)),
            ("PostToolUse", Some(AgentLiveState::Working)),
            ("PostToolUseFailure", Some(AgentLiveState::Working)),
            ("PermissionRequest", Some(AgentLiveState::Waiting)),
            ("Stop", Some(AgentLiveState::Done)),
            ("StopFailure", Some(AgentLiveState::Failed)),
            ("SessionStart", None),
            ("Notification", None),
        ];
        for (event, expected) in cases {
            let normalized =
                normalize_status_payload(HookSource::ClaudeCode, &claude_payload(event), None);
            assert_eq!(
                normalized.as_ref().map(|status| status.state),
                expected,
                "event {event}"
            );
        }
    }

    #[test]
    fn claude_canonical_id_and_metadata_flow_through() {
        let mut payload = claude_payload("PreToolUse");
        payload["tool_name"] = json!("Bash");
        payload["tool_input"] = json!({"command": "npm test"});
        let status = normalize_status_payload(
            HookSource::ClaudeCode,
            &payload,
            Some("orgii-session-1".to_string()),
        )
        .expect("status");
        assert_eq!(
            status.session_id,
            crate::sources::claude_code::canonical_session_id(
                "11111111-2222-3333-4444-555555555555"
            )
        );
        assert_eq!(status.source, "claude_code");
        assert_eq!(status.tool_name.as_deref(), Some("Bash"));
        assert!(status
            .tool_input_preview
            .as_deref()
            .unwrap()
            .contains("npm test"));
        assert_eq!(status.orgii_session_id.as_deref(), Some("orgii-session-1"));
        assert_eq!(status.occurred_at, "2026-07-17T10:00:00.000Z");
        assert_eq!(status.cwd.as_deref(), Some("/repo"));
    }

    #[test]
    fn claude_stop_carries_interrupt_flag() {
        let mut payload = claude_payload("Stop");
        payload["is_interrupt"] = json!(true);
        let status =
            normalize_status_payload(HookSource::ClaudeCode, &payload, None).expect("status");
        assert_eq!(status.state, AgentLiveState::Done);
        assert!(status.is_interrupt);
    }

    #[test]
    fn permission_request_surfaces_interactive_prompt() {
        let mut payload = claude_payload("PermissionRequest");
        payload["tool_name"] = json!("Bash");
        payload["message"] = json!("Allow Bash to run `rm -rf target`?");
        let status =
            normalize_status_payload(HookSource::ClaudeCode, &payload, None).expect("status");
        assert_eq!(status.state, AgentLiveState::Waiting);
        assert_eq!(
            status.interactive_prompt.as_deref(),
            Some("Allow Bash to run `rm -rf target`?")
        );
    }

    #[test]
    fn permission_request_falls_back_to_tool_name_prompt() {
        let mut payload = claude_payload("PermissionRequest");
        payload["tool_name"] = json!("Write");
        let status =
            normalize_status_payload(HookSource::ClaudeCode, &payload, None).expect("status");
        assert_eq!(
            status.interactive_prompt.as_deref(),
            Some("Permission requested: Write")
        );
    }

    #[test]
    fn kimi_ask_user_question_tool_is_waiting() {
        let payload = json!({
            "session_id": "kimi-1",
            "hook_event_name": "PreToolUse",
            "tool_name": "AskUserQuestion",
            "tool_input": {"question": "Which file?"},
        });
        let status = normalize_status_payload(HookSource::Kimi, &payload, None).expect("status");
        assert_eq!(status.state, AgentLiveState::Waiting);
        assert_eq!(status.session_id, "kimiapp-kimi-1");
    }

    #[test]
    fn codex_subagent_events_attribute_to_parent() {
        let payload = json!({
            "session_id": "parent-thread",
            "hook_event_name": "SubagentStart",
            "agent_id": "child-1",
            "transcript_path": "/x/rollout-child-abc.jsonl",
        });
        let status = normalize_status_payload(HookSource::Codex, &payload, None).expect("status");
        assert_eq!(status.state, AgentLiveState::Working);
        // Child rollout stem does not end with the parent id, so the parent
        // session id wins (mirrors canonical_lifecycle_session_id's guard).
        assert_eq!(
            status.session_id,
            crate::sources::codex::canonical_session_id("parent-thread")
        );
    }

    #[test]
    fn cursor_stop_with_non_completed_status_is_interrupt() {
        let payload = json!({
            "conversation_id": "conv-9",
            "hook_event_name": "stop",
            "status": "aborted",
        });
        let status = normalize_status_payload(HookSource::Cursor, &payload, None).expect("status");
        assert_eq!(status.state, AgentLiveState::Done);
        assert!(status.is_interrupt);
    }

    #[test]
    fn antigravity_ask_question_tool_is_waiting_and_busy_stop_keeps_working() {
        let ask = json!({
            "session_id": "ag-1",
            "hook_event_name": "PreInvocation",
            "toolCall": {"name": "ask_question", "args": {"question": "?"}},
        });
        let status = normalize_status_payload(HookSource::Antigravity, &ask, None).expect("ask");
        assert_eq!(status.state, AgentLiveState::Waiting);

        let busy_stop = json!({
            "session_id": "ag-1",
            "hook_event_name": "Stop",
            "fullyIdle": false,
        });
        let status =
            normalize_status_payload(HookSource::Antigravity, &busy_stop, None).expect("stop");
        assert_eq!(status.state, AgentLiveState::Working);
    }

    #[test]
    fn opencode_synthetic_events_map() {
        let cases = [
            ("SessionBusy", AgentLiveState::Working),
            ("MessagePart", AgentLiveState::Working),
            ("PermissionRequest", AgentLiveState::Waiting),
            ("SessionIdle", AgentLiveState::Done),
            ("SessionError", AgentLiveState::Failed),
        ];
        for (event, expected) in cases {
            let payload = json!({"session_id": "oc-1", "hook_event_name": event});
            let status =
                normalize_status_payload(HookSource::OpenCode, &payload, None).expect("status");
            assert_eq!(status.state, expected, "event {event}");
            assert_eq!(status.session_id, "opencodeapp-oc-1");
        }
    }

    #[test]
    fn windsurf_events_are_working_heartbeats_only() {
        let payload = json!({
            "trajectory_id": "traj-1",
            "hook_event_name": "post_write_code",
        });
        let status =
            normalize_status_payload(HookSource::Windsurf, &payload, None).expect("status");
        assert_eq!(status.state, AgentLiveState::Working);
        assert_eq!(status.session_id, "windsurfapp-traj-1");
    }

    #[test]
    fn previews_and_prompts_are_char_capped() {
        let mut payload = claude_payload("PermissionRequest");
        payload["tool_name"] = json!("A".repeat(200));
        payload["tool_input"] = json!({"command": "x".repeat(500)});
        payload["message"] = json!("m".repeat(1000));
        let status =
            normalize_status_payload(HookSource::ClaudeCode, &payload, None).expect("status");
        assert_eq!(status.tool_name.unwrap().chars().count(), 60);
        assert_eq!(status.tool_input_preview.unwrap().chars().count(), 160);
        assert_eq!(status.interactive_prompt.unwrap().chars().count(), 500);
    }

    #[test]
    fn missing_session_id_or_unknown_event_returns_none() {
        let no_session = json!({"hook_event_name": "Stop"});
        assert!(normalize_status_payload(HookSource::ClaudeCode, &no_session, None).is_none());
        let unknown = json!({"session_id": "s", "hook_event_name": "SomethingElse"});
        assert!(normalize_status_payload(HookSource::ClaudeCode, &unknown, None).is_none());
    }
}
