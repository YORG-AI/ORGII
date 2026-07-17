//! External hook payload adapters for session provenance.
//!
//! Vendor payloads are accepted only at this boundary and immediately reduced
//! to [`ResourceInteractionEnvelopeV1`]. Raw tool responses, prompts, commands,
//! and file contents are never copied into the envelope.

use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use std::path::Path;

use crate::canonical::{
    AttributionPrecision, ResourceAction, ResourceInteractionEnvelopeV1,
    ResourceInteractionOutcome, SessionActorLifecycleEnvelopeV1, SessionActorLifecyclePhase,
    RESOURCE_INTERACTION_SCHEMA_VERSION, SESSION_ACTOR_SCHEMA_VERSION,
};
use crate::resource_interaction::{explicit_file_paths, file_interactions_from_tool};
use crate::sources::imported_history::metadata::{
    SOURCE_ANTIGRAVITY, SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP, SOURCE_CURSOR_IDE,
    SOURCE_FACTORY_DROID, SOURCE_KIMI, SOURCE_OPENCODE, SOURCE_QWEN_CODE, SOURCE_TRAE,
    SOURCE_WINDSURF, SOURCE_ZCODE,
};

// Session-id prefixes for hook sources handled inline here. Qwen/Droid/Kimi/
// Antigravity have no transcript importer yet; Trae/OpenCode/Windsurf DO import,
// so those must mirror the prefixes their importers use (`sources::*::history`)
// for a hook session and its imported transcript to resolve to one id.
const QWEN_CODE_SESSION_PREFIX: &str = "qwencodeapp-";
const FACTORY_DROID_SESSION_PREFIX: &str = "droidapp-";
const TRAE_SESSION_PREFIX: &str = "traeapp-";
const OPENCODE_SESSION_PREFIX: &str = "opencodeapp-";
const WINDSURF_SESSION_PREFIX: &str = "windsurfapp-";
const KIMI_SESSION_PREFIX: &str = "kimiapp-";
const ANTIGRAVITY_SESSION_PREFIX: &str = "antigravityapp-";
const ZCODE_SESSION_PREFIX: &str = "zcodeapp-";

const MAX_RESOURCE_INTERACTIONS_PER_HOOK: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookSource {
    ClaudeCode,
    Codex,
    Cursor,
    QwenCode,
    FactoryDroid,
    Trae,
    OpenCode,
    Windsurf,
    Kimi,
    Antigravity,
    ZCode,
}

impl HookSource {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            SOURCE_CLAUDE_CODE | "claude" => Ok(Self::ClaudeCode),
            SOURCE_CODEX_APP | "codex" => Ok(Self::Codex),
            SOURCE_CURSOR_IDE | "cursor" => Ok(Self::Cursor),
            SOURCE_QWEN_CODE | "qwen" => Ok(Self::QwenCode),
            // `SOURCE_FACTORY_DROID` is already "droid"; accept "factory" too.
            SOURCE_FACTORY_DROID | "factory" => Ok(Self::FactoryDroid),
            // `SOURCE_TRAE`/`SOURCE_OPENCODE`/etc. already equal their words.
            SOURCE_TRAE => Ok(Self::Trae),
            SOURCE_OPENCODE => Ok(Self::OpenCode),
            SOURCE_WINDSURF => Ok(Self::Windsurf),
            SOURCE_KIMI => Ok(Self::Kimi),
            SOURCE_ANTIGRAVITY => Ok(Self::Antigravity),
            SOURCE_ZCODE => Ok(Self::ZCode),
            other => Err(format!(
                "Unsupported session-provenance hook source: {other}"
            )),
        }
    }

    pub fn as_source_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => SOURCE_CLAUDE_CODE,
            Self::Codex => SOURCE_CODEX_APP,
            Self::Cursor => SOURCE_CURSOR_IDE,
            Self::QwenCode => SOURCE_QWEN_CODE,
            Self::FactoryDroid => SOURCE_FACTORY_DROID,
            Self::Trae => SOURCE_TRAE,
            Self::OpenCode => SOURCE_OPENCODE,
            Self::Windsurf => SOURCE_WINDSURF,
            Self::Kimi => SOURCE_KIMI,
            Self::Antigravity => SOURCE_ANTIGRAVITY,
            Self::ZCode => SOURCE_ZCODE,
        }
    }

    fn canonical_session_id(self, source_session_id: &str, payload: &Value) -> String {
        match self {
            Self::ClaudeCode => {
                crate::sources::claude_code::canonical_session_id(source_session_id)
            }
            Self::Codex => string_field(payload, &["transcript_path", "transcriptPath"])
                .as_deref()
                .and_then(transcript_file_stem)
                .map(crate::sources::codex::canonical_session_id)
                .unwrap_or_else(|| crate::sources::codex::canonical_session_id(source_session_id)),
            Self::Cursor => crate::sources::cursor_ide::canonical_session_id(source_session_id),
            // Gemini-family (Qwen), Droid, Kimi, and Antigravity emit
            // Claude-Code-shaped payloads but have no importer yet, so the
            // canonical id is a stable prefix over the vendor session id.
            Self::QwenCode => format!("{QWEN_CODE_SESSION_PREFIX}{source_session_id}"),
            Self::FactoryDroid => format!("{FACTORY_DROID_SESSION_PREFIX}{source_session_id}"),
            Self::Kimi => format!("{KIMI_SESSION_PREFIX}{source_session_id}"),
            Self::Antigravity => format!("{ANTIGRAVITY_SESSION_PREFIX}{source_session_id}"),
            // Trae/OpenCode/Windsurf/ZCode DO have importers; the prefix must
            // match theirs so a hook session and its imported transcript unify.
            Self::Trae => format!("{TRAE_SESSION_PREFIX}{source_session_id}"),
            Self::OpenCode => format!("{OPENCODE_SESSION_PREFIX}{source_session_id}"),
            Self::Windsurf => format!("{WINDSURF_SESSION_PREFIX}{source_session_id}"),
            Self::ZCode => format!("{ZCODE_SESSION_PREFIX}{source_session_id}"),
        }
    }

    fn canonical_lifecycle_session_id(self, source_session_id: &str, payload: &Value) -> String {
        if self != Self::Codex {
            return self.canonical_session_id(source_session_id, payload);
        }
        string_field(payload, &["transcript_path", "transcriptPath"])
            .as_deref()
            .and_then(transcript_file_stem)
            // Real Codex SubagentStart payloads point `transcript_path` at
            // the child rollout even though `session_id` is the parent. Only
            // trust the common path as the parent locator when its stem
            // actually carries the parent thread id.
            .filter(|file_stem| file_stem.ends_with(source_session_id))
            .map(crate::sources::codex::canonical_session_id)
            .unwrap_or_else(|| crate::sources::codex::canonical_session_id(source_session_id))
    }
}

pub fn normalize_hook_payload(
    source: HookSource,
    payload: &Value,
) -> Result<Vec<ResourceInteractionEnvelopeV1>, String> {
    // Windsurf's payload shape is entirely different (verb-per-event under
    // `agent_action_name` + a nested `tool_info`), so it is normalized on its
    // own path rather than threaded through the Claude-family logic below.
    if source == HookSource::Windsurf {
        return normalize_windsurf_payload(payload);
    }
    let source_session_id = source_session_id(source, payload)
        .ok_or_else(|| "Hook payload is missing its session identifier".to_string())?;
    let cwd = string_field(payload, &["cwd", "workspace_path", "workspacePath"])
        .or_else(|| first_string_array_item(payload, &["workspace_roots", "workspaceRoots"]));
    let turn_id = string_field(payload, &["turn_id", "generation_id", "generationId"]);
    let actor_id = string_field(payload, &["agent_id", "subagent_id", "subagentId"]);
    let hook_event_name =
        string_field(payload, &["hook_event_name", "hookEventName", "event"]).unwrap_or_default();
    let outcome = if hook_event_name.to_ascii_lowercase().contains("failure") {
        ResourceInteractionOutcome::Failed
    } else {
        ResourceInteractionOutcome::Succeeded
    };
    let occurred_at = string_field(payload, &["timestamp", "occurred_at", "occurredAt"])
        .and_then(|timestamp| normalize_rfc3339(&timestamp))
        .unwrap_or_else(now_rfc3339);

    let mut path_actions = if hook_event_name.eq_ignore_ascii_case("subagentStop") {
        modified_file_actions(payload)
    } else {
        tool_path_actions(source, payload)
    };
    path_actions.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.as_str().cmp(right.1.as_str()))
    });
    path_actions.dedup();
    // One vendor callback must not be able to turn a bounded hook payload
    // into an unbounded number of spool files and Git resolver subprocesses.
    path_actions.truncate(MAX_RESOURCE_INTERACTIONS_PER_HOOK);
    if path_actions.is_empty() {
        return Ok(Vec::new());
    }
    let cwd = cwd.ok_or_else(|| {
        "Hook payload with file interactions is missing its workspace path".to_string()
    })?;

    let base_source_event_id = string_field(
        payload,
        &[
            "tool_use_id",
            "toolUseId",
            "event_id",
            "eventId",
            "generation_id",
            "generationId",
        ],
    );
    let session_id = source.canonical_session_id(&source_session_id, payload);
    let precision = if actor_id.is_some() {
        AttributionPrecision::Exact
    } else {
        AttributionPrecision::SessionOnly
    };

    Ok(path_actions
        .into_iter()
        .map(|(file_path, action)| {
            let source_event_id = base_source_event_id
                .as_ref()
                .map(|base| format!("{base}:{}:{file_path}", action.as_str()));
            ResourceInteractionEnvelopeV1 {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                source: source.as_source_str().to_string(),
                source_session_id: source_session_id.clone(),
                session_id: session_id.clone(),
                source_event_id,
                turn_id: turn_id.clone(),
                actor_id: actor_id.clone(),
                cwd: cwd.clone(),
                file_path,
                action,
                outcome,
                occurred_at: occurred_at.clone(),
                attribution_precision: precision,
            }
        })
        .collect())
}

/// Windsurf (Cascade) hooks fire one verb-per-event (`post_write_code`,
/// `post_read_code`, …) and carry the touched file only inside `tool_info`.
/// There is no top-level `cwd`, tool name, or `tool_input`; the file path is
/// absolute, so its parent directory anchors the git-workspace resolver. Only
/// file read/write events yield a resource interaction.
fn normalize_windsurf_payload(
    payload: &Value,
) -> Result<Vec<ResourceInteractionEnvelopeV1>, String> {
    let Some(source_session_id) = string_field(payload, &["trajectory_id", "trajectoryId"]) else {
        return Ok(Vec::new());
    };
    let event =
        string_field(payload, &["agent_action_name", "agentActionName"]).unwrap_or_default();
    let action = match event.as_str() {
        "post_write_code" | "pre_write_code" => ResourceAction::Write,
        "post_read_code" | "pre_read_code" => ResourceAction::Read,
        // run-command / cascade-response / mcp events carry no path we track.
        _ => return Ok(Vec::new()),
    };
    let tool_info = payload.get("tool_info").or_else(|| payload.get("toolInfo"));
    let Some(file_path) = tool_info.and_then(|info| string_field(info, &["file_path", "filePath"]))
    else {
        return Ok(Vec::new());
    };
    let cwd = Path::new(&file_path)
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .filter(|parent| !parent.is_empty())
        .unwrap_or_else(|| file_path.clone());
    let occurred_at = string_field(payload, &["timestamp", "occurred_at", "occurredAt"])
        .and_then(|timestamp| normalize_rfc3339(&timestamp))
        .unwrap_or_else(now_rfc3339);
    let source_event_id = string_field(payload, &["execution_id", "executionId"])
        .map(|base| format!("{base}:{}:{file_path}", action.as_str()));
    let envelope = ResourceInteractionEnvelopeV1 {
        schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
        source: SOURCE_WINDSURF.to_string(),
        source_session_id: source_session_id.clone(),
        session_id: format!("{WINDSURF_SESSION_PREFIX}{source_session_id}"),
        source_event_id,
        turn_id: None,
        actor_id: None,
        cwd,
        file_path,
        action,
        outcome: ResourceInteractionOutcome::Succeeded,
        occurred_at,
        attribution_precision: AttributionPrecision::SessionOnly,
    };
    envelope
        .validate()
        .map_err(|err| format!("Invalid Windsurf resource-interaction envelope: {err}"))?;
    Ok(vec![envelope])
}

/// Reduce a vendor subagent lifecycle hook to local-only session metadata.
/// Raw prompts, assistant messages, tool payloads, and transcript contents are
/// never copied across this boundary.
pub fn normalize_actor_lifecycle_payload(
    source: HookSource,
    payload: &Value,
) -> Result<Option<SessionActorLifecycleEnvelopeV1>, String> {
    let Some(phase) = hook_lifecycle_phase(payload) else {
        return Ok(None);
    };
    let source_session_id = if source == HookSource::Cursor {
        string_field(payload, &["parent_conversation_id", "parentConversationId"])
            .or_else(|| source_session_id(source, payload))
    } else {
        source_session_id(source, payload)
    }
    .ok_or_else(|| "Hook payload is missing its session identifier".to_string())?;
    let Some(actor_id) = string_field(payload, &["agent_id", "subagent_id", "subagentId"]) else {
        // Some vendors emit a coarse subagent-stop event with only modified
        // files. Keep those resource observations, but do not invent an actor
        // identity or transcript relationship.
        return Ok(None);
    };
    let cwd = string_field(payload, &["cwd", "workspace_path", "workspacePath"])
        .or_else(|| first_string_array_item(payload, &["workspace_roots", "workspaceRoots"]))
        .ok_or_else(|| "Actor lifecycle hook is missing its workspace path".to_string())?;
    let occurred_at = string_field(payload, &["timestamp", "occurred_at", "occurredAt"])
        .and_then(|timestamp| normalize_rfc3339(&timestamp))
        .unwrap_or_else(now_rfc3339);
    let transcript_path = string_field(payload, &["agent_transcript_path", "agentTranscriptPath"]);
    let session_id = source.canonical_lifecycle_session_id(&source_session_id, payload);
    let envelope = SessionActorLifecycleEnvelopeV1 {
        schema_version: SESSION_ACTOR_SCHEMA_VERSION,
        source: source.as_source_str().to_string(),
        source_session_id,
        session_id,
        turn_id: string_field(payload, &["turn_id", "generation_id", "generationId"]),
        actor_id,
        actor_type: string_field(
            payload,
            &["agent_type", "agentType", "subagent_type", "subagentType"],
        ),
        phase,
        occurred_at,
        cwd,
        transcript_path,
    };
    envelope.validate().map_err(|err| err.to_string())?;
    Ok(Some(envelope))
}

fn hook_lifecycle_phase(payload: &Value) -> Option<SessionActorLifecyclePhase> {
    let event = string_field(payload, &["hook_event_name", "hookEventName", "event"])?;
    let normalized = event
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "subagentstart" => Some(SessionActorLifecyclePhase::Started),
        "subagentstop" => Some(SessionActorLifecyclePhase::Stopped),
        _ => None,
    }
}

fn transcript_file_stem(path: &str) -> Option<&str> {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn source_session_id(source: HookSource, payload: &Value) -> Option<String> {
    match source {
        HookSource::ClaudeCode
        | HookSource::Codex
        | HookSource::QwenCode
        | HookSource::FactoryDroid
        | HookSource::Trae
        | HookSource::OpenCode
        | HookSource::Kimi
        | HookSource::Antigravity
        | HookSource::ZCode => string_field(payload, &["session_id", "sessionId"]),
        // Windsurf keys its session on `trajectory_id` (handled on its own path,
        // but kept here for completeness/lifecycle callers).
        HookSource::Windsurf => string_field(payload, &["trajectory_id", "trajectoryId"]),
        HookSource::Cursor => string_field(
            payload,
            &[
                "conversation_id",
                "conversationId",
                "session_id",
                "sessionId",
            ],
        ),
    }
}

fn tool_path_actions(source: HookSource, payload: &Value) -> Vec<(String, ResourceAction)> {
    // Antigravity nests the tool under `toolCall` (name + args) rather than the
    // Claude-family flat `tool_name` / `tool_input`.
    let (tool_name, tool_input) = if source == HookSource::Antigravity {
        let call = payload.get("toolCall").or_else(|| payload.get("tool_call"));
        let name = call
            .and_then(|c| string_field(c, &["name", "ToolName", "toolName"]))
            .or_else(|| {
                call.and_then(|c| c.get("args").or_else(|| c.get("Args")))
                    .and_then(|args| string_field(args, &["ToolName", "tool_name", "toolName"]))
            })
            .unwrap_or_default();
        let input = call
            .and_then(|c| c.get("args").or_else(|| c.get("Args")))
            .unwrap_or(&Value::Null);
        (name, input)
    } else {
        let name = string_field(payload, &["tool_name", "toolName"]).unwrap_or_default();
        let input = payload
            .get("tool_input")
            .or_else(|| payload.get("toolInput"))
            .unwrap_or(&Value::Null);
        (name, input)
    };

    let explicit = file_interactions_from_tool(&tool_name, tool_input, None)
        .into_iter()
        .map(|interaction| (interaction.file_path, interaction.action))
        .collect::<Vec<_>>();
    if !explicit.is_empty() {
        return explicit;
    }

    if matches!(source, HookSource::Codex | HookSource::Cursor) {
        return shell_path_actions(&tool_name, tool_input);
    }
    Vec::new()
}

/// Reuse the transcript importer's conservative shell classifier at the hook
/// boundary. It recognizes only read-only file commands (`cat`, bounded
/// `sed`, `head`, `tail`) and code-search commands. The raw command is used
/// transiently for classification and is never copied into the envelope.
fn shell_path_actions(tool_name: &str, tool_input: &Value) -> Vec<(String, ResourceAction)> {
    crate::sources::codex::app::normalize_codex_tool_calls(tool_name, tool_input.clone())
        .into_iter()
        .flat_map(|(canonical_name, args)| {
            let action = match canonical_name.as_str() {
                crate::sources::imported_history::FUNCTION_READ_FILE => ResourceAction::Read,
                crate::sources::imported_history::FUNCTION_CODE_SEARCH
                | crate::sources::imported_history::FUNCTION_GLOB_FILE_SEARCH => {
                    ResourceAction::Search
                }
                crate::sources::imported_history::FUNCTION_EDIT_FILE => ResourceAction::Write,
                _ => return Vec::new(),
            };
            explicit_file_paths(&args)
                .into_iter()
                .map(|path| (path, action))
                .collect()
        })
        .collect()
}

fn modified_file_actions(payload: &Value) -> Vec<(String, ResourceAction)> {
    payload
        .get("modified_files")
        .or_else(|| payload.get("modifiedFiles"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .map(|path| (path.to_string(), ResourceAction::Write))
        .collect()
}

fn string_field(value: &Value, fields: &[&str]) -> Option<String> {
    fields.iter().find_map(|field| {
        value
            .get(*field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|field| !field.is_empty())
            .map(str::to_string)
    })
}

fn first_string_array_item(value: &Value, fields: &[&str]) -> Option<String> {
    fields.iter().find_map(|field| {
        value
            .get(*field)
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find_map(Value::as_str))
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
    })
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn normalize_rfc3339(timestamp: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|timestamp| {
            timestamp
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_read_keeps_exact_subagent_attribution_without_raw_output() {
        let envelopes = normalize_hook_payload(
            HookSource::ClaudeCode,
            &json!({
                "session_id": "session-1",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                "tool_name": "Read",
                "tool_use_id": "tool-1",
                "agent_id": "agent-1",
                "tool_input": {"file_path": "/repo/src/lib.rs"},
                "tool_response": {"content": "secret file contents"}
            }),
        )
        .expect("normalize Claude hook");

        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].session_id, "claudecodeapp-session-1");
        assert_eq!(envelopes[0].actor_id.as_deref(), Some("agent-1"));
        assert_eq!(envelopes[0].action, ResourceAction::Read);
        assert_eq!(
            envelopes[0].attribution_precision,
            AttributionPrecision::Exact
        );
        let serialized = serde_json::to_string(&envelopes[0]).expect("serialize envelope");
        assert!(!serialized.contains("secret file contents"));
    }

    #[test]
    fn qwen_replace_normalizes_to_a_write_without_raw_output() {
        let envelopes = normalize_hook_payload(
            HookSource::QwenCode,
            &json!({
                "session_id": "qwen-1",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                // Gemini-family in-place edit tool.
                "tool_name": "replace",
                "tool_use_id": "tool-9",
                "tool_input": {
                    "file_path": "/repo/src/main.rs",
                    "old_string": "secret before",
                    "new_string": "secret after"
                },
                "tool_response": {"output": "diff with secret contents"}
            }),
        )
        .expect("normalize Qwen hook");

        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].source, "qwen_code");
        assert_eq!(envelopes[0].session_id, "qwencodeapp-qwen-1");
        assert_eq!(envelopes[0].action, ResourceAction::Write);
        let serialized = serde_json::to_string(&envelopes[0]).expect("serialize envelope");
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn factory_droid_create_preserves_the_create_action() {
        let envelopes = normalize_hook_payload(
            HookSource::FactoryDroid,
            &json!({
                "session_id": "droid-1",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                "tool_name": "Create",
                "tool_use_id": "tool-7",
                "tool_input": {"file_path": "/repo/src/new.rs"}
            }),
        )
        .expect("normalize Droid hook");

        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].source, "droid");
        assert_eq!(envelopes[0].session_id, "droidapp-droid-1");
        assert_eq!(envelopes[0].action, ResourceAction::Create);
        assert_eq!(envelopes[0].file_path, "/repo/src/new.rs");
    }

    #[test]
    fn opencode_edit_normalizes_to_a_write_with_camelcase_path() {
        let envelopes = normalize_hook_payload(
            HookSource::OpenCode,
            &json!({
                "session_id": "ses_abc",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                "tool_name": "edit",
                "tool_use_id": "call_1",
                "tool_input": {"filePath": "/repo/src/main.rs", "oldString": "a", "newString": "b"},
                "output": {"output": "secret diff output"}
            }),
        )
        .expect("normalize OpenCode hook");

        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].source, "opencode");
        assert_eq!(envelopes[0].session_id, "opencodeapp-ses_abc");
        assert_eq!(envelopes[0].action, ResourceAction::Write);
        assert_eq!(envelopes[0].file_path, "/repo/src/main.rs");
        let serialized = serde_json::to_string(&envelopes[0]).expect("serialize envelope");
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn trae_edit_normalizes_to_a_write() {
        let envelopes = normalize_hook_payload(
            HookSource::Trae,
            &json!({
                "session_id": "trae-1",
                "cwd": "/repo",
                "workspace_roots": ["/repo"],
                "hook_event_name": "PostToolUse",
                "tool_name": "EditFile",
                "tool_use_id": "t1",
                "tool_input": {"file_path": "/repo/src/lib.rs"}
            }),
        )
        .expect("normalize Trae hook");

        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].source, "trae");
        assert_eq!(envelopes[0].session_id, "traeapp-trae-1");
        assert_eq!(envelopes[0].action, ResourceAction::Write);
    }

    #[test]
    fn kimi_str_replace_normalizes_to_a_write() {
        let envelopes = normalize_hook_payload(
            HookSource::Kimi,
            &json!({
                "session_id": "kimi-1",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                "tool_name": "StrReplaceFile",
                "tool_input": {"file_path": "/repo/src/lib.rs", "content": "secret"}
            }),
        )
        .expect("normalize Kimi hook");

        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].source, "kimi");
        assert_eq!(envelopes[0].session_id, "kimiapp-kimi-1");
        assert_eq!(envelopes[0].action, ResourceAction::Write);
        let serialized = serde_json::to_string(&envelopes[0]).expect("serialize envelope");
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn antigravity_toolcall_write_normalizes_to_a_write() {
        let envelopes = normalize_hook_payload(
            HookSource::Antigravity,
            &json!({
                "session_id": "ag-1",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                // Antigravity nests the tool under `toolCall`, not tool_name/tool_input.
                "toolCall": {
                    "name": "write_file",
                    "args": {"file_path": "/repo/src/app.ts", "content": "x"}
                }
            }),
        )
        .expect("normalize Antigravity hook");

        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].source, "antigravity");
        assert_eq!(envelopes[0].session_id, "antigravityapp-ag-1");
        assert_eq!(envelopes[0].action, ResourceAction::Write);
        assert_eq!(envelopes[0].file_path, "/repo/src/app.ts");
    }

    #[test]
    fn windsurf_post_write_code_normalizes_from_tool_info() {
        let envelopes = normalize_hook_payload(
            HookSource::Windsurf,
            &json!({
                "agent_action_name": "post_write_code",
                "trajectory_id": "traj-9",
                "execution_id": "exec-1",
                "timestamp": "2026-07-15T03:00:00Z",
                "model_name": "cascade",
                "tool_info": {
                    "file_path": "/repo/src/main.rs",
                    "edits": [{"old_string": "secret a", "new_string": "secret b"}]
                }
            }),
        )
        .expect("normalize Windsurf hook");

        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].source, "windsurf");
        assert_eq!(envelopes[0].session_id, "windsurfapp-traj-9");
        assert_eq!(envelopes[0].action, ResourceAction::Write);
        assert_eq!(envelopes[0].file_path, "/repo/src/main.rs");
        // No top-level cwd: the file's parent dir anchors the resolver.
        assert_eq!(envelopes[0].cwd, "/repo/src");
        let serialized = serde_json::to_string(&envelopes[0]).expect("serialize envelope");
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn windsurf_non_file_event_yields_no_envelope() {
        let envelopes = normalize_hook_payload(
            HookSource::Windsurf,
            &json!({
                "agent_action_name": "post_run_command",
                "trajectory_id": "traj-9",
                "tool_info": {"command_line": "npm test", "cwd": "/repo"}
            }),
        )
        .expect("normalize Windsurf command hook");
        assert!(envelopes.is_empty());
    }

    #[test]
    fn zcode_write_normalizes_to_a_write() {
        let envelopes = normalize_hook_payload(
            HookSource::ZCode,
            &json!({
                "session_id": "zc-1",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                "tool_name": "Write",
                "tool_input": {"file_path": "/repo/src/lib.rs"}
            }),
        )
        .expect("normalize ZCode hook");

        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].source, "zcode");
        assert_eq!(envelopes[0].session_id, "zcodeapp-zc-1");
        assert_eq!(envelopes[0].action, ResourceAction::Write);
    }

    #[test]
    fn unknown_hook_source_is_rejected() {
        assert!(HookSource::parse("gemini-cli").is_err());
        assert!(HookSource::parse("warp").is_err());
        assert!(HookSource::parse("cline").is_err());
        assert_eq!(HookSource::parse("qwen").unwrap(), HookSource::QwenCode);
        assert_eq!(
            HookSource::parse("droid").unwrap(),
            HookSource::FactoryDroid
        );
        assert_eq!(HookSource::parse("trae").unwrap(), HookSource::Trae);
        assert_eq!(HookSource::parse("opencode").unwrap(), HookSource::OpenCode);
        assert_eq!(HookSource::parse("windsurf").unwrap(), HookSource::Windsurf);
        assert_eq!(HookSource::parse("kimi").unwrap(), HookSource::Kimi);
        assert_eq!(
            HookSource::parse("antigravity").unwrap(),
            HookSource::Antigravity
        );
        assert_eq!(HookSource::parse("zcode").unwrap(), HookSource::ZCode);
    }

    #[test]
    fn codex_apply_patch_preserves_per_file_actions() {
        let envelopes = normalize_hook_payload(
            HookSource::Codex,
            &json!({
                "session_id": "session-2",
                "turn_id": "turn-2",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                "tool_name": "apply_patch",
                "tool_use_id": "tool-2",
                "tool_input": {
                    "command": "*** Begin Patch\n*** Add File: src/new.rs\n+x\n*** Delete File: src/old.rs\n*** End Patch"
                }
            }),
        )
        .expect("normalize Codex hook");

        assert_eq!(envelopes.len(), 2);
        assert_eq!(envelopes[0].session_id, "codexapp-session-2");
        assert_eq!(envelopes[0].action, ResourceAction::Create);
        assert_eq!(envelopes[1].action, ResourceAction::Delete);
        assert_eq!(
            envelopes[0].attribution_precision,
            AttributionPrecision::SessionOnly
        );
    }

    #[test]
    fn codex_uses_parent_transcript_stem_as_loadable_root_session() {
        let envelopes = normalize_hook_payload(
            HookSource::Codex,
            &json!({
                "session_id": "019f-parent-thread",
                "transcript_path": "/Users/me/.codex/sessions/2026/07/14/rollout-2026-07-14T10-00-00-019f-parent-thread.jsonl",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                "tool_name": "Read",
                "tool_use_id": "tool-1",
                "tool_input": {"file_path": "src/lib.rs"}
            }),
        )
        .expect("normalize Codex hook");

        assert_eq!(
            envelopes[0].session_id,
            "codexapp-rollout-2026-07-14T10-00-00-019f-parent-thread"
        );
        assert_eq!(envelopes[0].source_session_id, "019f-parent-thread");
    }

    #[test]
    fn codex_subagent_stop_keeps_only_lifecycle_and_child_locator_metadata() {
        let payload = json!({
            "session_id": "019f-parent-thread",
            "turn_id": "turn-1",
            "transcript_path": "/Users/me/.codex/sessions/parent-rollout-019f-parent-thread.jsonl",
            "cwd": "/repo",
            "hook_event_name": "SubagentStop",
            "agent_id": "agent-1",
            "agent_type": "explorer",
            "agent_transcript_path": "/Users/me/.codex/sessions/child-rollout.jsonl",
            "last_assistant_message": "private answer"
        });
        let lifecycle = normalize_actor_lifecycle_payload(HookSource::Codex, &payload)
            .expect("normalize lifecycle")
            .expect("lifecycle envelope");

        assert_eq!(
            lifecycle.session_id,
            "codexapp-parent-rollout-019f-parent-thread"
        );
        assert_eq!(lifecycle.actor_id, "agent-1");
        assert_eq!(lifecycle.actor_type.as_deref(), Some("explorer"));
        assert_eq!(lifecycle.phase, SessionActorLifecyclePhase::Stopped);
        assert_eq!(
            lifecycle.transcript_path.as_deref(),
            Some("/Users/me/.codex/sessions/child-rollout.jsonl")
        );
        let serialized = serde_json::to_string(&lifecycle).expect("serialize lifecycle");
        assert!(!serialized.contains("private answer"));
    }

    #[test]
    fn codex_subagent_start_does_not_mistake_child_transcript_for_parent() {
        let lifecycle = normalize_actor_lifecycle_payload(
            HookSource::Codex,
            &json!({
                "session_id": "019f-parent-thread",
                "turn_id": "turn-1",
                "transcript_path": "/Users/me/.codex/sessions/child-rollout-019f-child-thread.jsonl",
                "cwd": "/repo",
                "hook_event_name": "SubagentStart",
                "agent_id": "019f-child-thread",
                "agent_type": "default"
            }),
        )
        .expect("normalize lifecycle")
        .expect("lifecycle envelope");

        assert_eq!(lifecycle.session_id, "codexapp-019f-parent-thread");
        assert_eq!(lifecycle.phase, SessionActorLifecyclePhase::Started);
    }

    #[test]
    fn cursor_subagent_start_preserves_parent_and_actor_identity() {
        let lifecycle = normalize_actor_lifecycle_payload(
            HookSource::Cursor,
            &json!({
                "conversation_id": "cursor-current-context",
                "generation_id": "generation-1",
                "workspace_roots": ["/repo"],
                "hook_event_name": "subagentStart",
                "subagent_id": "cursor-child-1",
                "subagent_type": "explore",
                "parent_conversation_id": "cursor-parent-1",
                "task": "private task description"
            }),
        )
        .expect("normalize Cursor lifecycle")
        .expect("Cursor lifecycle envelope");

        assert_eq!(lifecycle.source_session_id, "cursor-parent-1");
        assert_eq!(lifecycle.session_id, "cursoride-cursor-parent-1");
        assert_eq!(lifecycle.actor_id, "cursor-child-1");
        assert_eq!(lifecycle.actor_type.as_deref(), Some("explore"));
        assert_eq!(lifecycle.phase, SessionActorLifecyclePhase::Started);
        let serialized = serde_json::to_string(&lifecycle).expect("serialize lifecycle");
        assert!(!serialized.contains("private task description"));
    }

    #[test]
    fn codex_exec_command_records_read_path_without_retaining_command() {
        let envelopes = normalize_hook_payload(
            HookSource::Codex,
            &json!({
                "session_id": "session-read",
                "turn_id": "turn-read",
                "cwd": "/repo",
                "hook_event_name": "PostToolUse",
                "tool_name": "exec_command",
                "tool_use_id": "tool-read",
                "tool_input": {"cmd": "sed -n '1,20p' src/lib.rs"},
                "tool_response": {"output": "private source"}
            }),
        )
        .expect("normalize Codex shell read");

        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].file_path, "src/lib.rs");
        assert_eq!(envelopes[0].action, ResourceAction::Read);
        let serialized = serde_json::to_string(&envelopes).expect("serialize envelopes");
        assert!(!serialized.contains("sed -n"));
        assert!(!serialized.contains("private source"));
    }

    #[test]
    fn cursor_subagent_stop_uses_modified_files() {
        let envelopes = normalize_hook_payload(
            HookSource::Cursor,
            &json!({
                "conversation_id": "conversation-1",
                "generation_id": "generation-1",
                "workspace_roots": ["/repo"],
                "hook_event_name": "subagentStop",
                "modified_files": ["src/a.rs", "src/b.rs"]
            }),
        )
        .expect("normalize Cursor hook");

        assert_eq!(envelopes.len(), 2);
        assert_eq!(envelopes[0].session_id, "cursoride-conversation-1");
        assert_eq!(envelopes[0].cwd, "/repo");
        assert_eq!(envelopes[0].actor_id, None);
        assert_eq!(
            envelopes[0].attribution_precision,
            AttributionPrecision::SessionOnly
        );
        assert!(envelopes
            .iter()
            .all(|envelope| envelope.action == ResourceAction::Write));
    }

    #[test]
    fn cursor_post_tool_use_matches_live_payload_without_retaining_private_fields() {
        let envelopes = normalize_hook_payload(
            HookSource::Cursor,
            &json!({
                "conversation_id": "conversation-live",
                "generation_id": "generation-live",
                "workspace_roots": ["/repo"],
                "hook_event_name": "postToolUse",
                "tool_name": "Read",
                "tool_use_id": "tool-live",
                "tool_input": {"file_path": "src/lib.rs"},
                "tool_output": "private file contents",
                "user_email": "private@example.com"
            }),
        )
        .expect("normalize live Cursor hook shape");

        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].session_id, "cursoride-conversation-live");
        assert_eq!(envelopes[0].turn_id.as_deref(), Some("generation-live"));
        assert_eq!(
            envelopes[0].source_event_id.as_deref(),
            Some("tool-live:read:src/lib.rs")
        );
        assert_eq!(envelopes[0].cwd, "/repo");
        assert_eq!(envelopes[0].file_path, "src/lib.rs");
        assert_eq!(envelopes[0].action, ResourceAction::Read);
        assert_eq!(
            envelopes[0].attribution_precision,
            AttributionPrecision::SessionOnly
        );
        let serialized = serde_json::to_string(&envelopes).expect("serialize envelopes");
        assert!(!serialized.contains("private file contents"));
        assert!(!serialized.contains("private@example.com"));
    }

    #[test]
    fn vendor_timestamps_are_normalized_to_utc() {
        let envelopes = normalize_hook_payload(
            HookSource::ClaudeCode,
            &json!({
                "session_id": "session-3",
                "cwd": "/repo",
                "timestamp": "2026-07-14T10:00:00+02:00",
                "tool_name": "Read",
                "tool_input": {"file_path": "src/lib.rs"}
            }),
        )
        .expect("normalize timestamp");
        assert_eq!(envelopes[0].occurred_at, "2026-07-14T08:00:00.000Z");
    }

    #[test]
    fn file_interactions_without_a_workspace_are_rejected() {
        let error = normalize_hook_payload(
            HookSource::ClaudeCode,
            &json!({
                "session_id": "session-4",
                "tool_name": "Read",
                "tool_input": {"file_path": "src/lib.rs"}
            }),
        )
        .expect_err("relative paths without a workspace must not be attributed");
        assert!(error.contains("workspace path"));
    }

    #[test]
    fn one_hook_payload_has_a_bounded_interaction_fanout() {
        let modified_files = (0..=MAX_RESOURCE_INTERACTIONS_PER_HOOK)
            .map(|index| format!("src/generated-{index}.rs"))
            .collect::<Vec<_>>();
        let envelopes = normalize_hook_payload(
            HookSource::Cursor,
            &json!({
                "conversation_id": "bounded-fanout",
                "workspace_roots": ["/repo"],
                "hook_event_name": "subagentStop",
                "modified_files": modified_files
            }),
        )
        .expect("normalize bounded hook payload");

        assert_eq!(envelopes.len(), MAX_RESOURCE_INTERACTIONS_PER_HOOK);
    }
}
