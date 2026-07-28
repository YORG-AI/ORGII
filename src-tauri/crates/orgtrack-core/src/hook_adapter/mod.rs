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

    pub(crate) fn canonical_session_id(self, source_session_id: &str, payload: &Value) -> String {
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

    pub(crate) fn canonical_lifecycle_session_id(
        self,
        source_session_id: &str,
        payload: &Value,
    ) -> String {
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

pub(crate) fn source_session_id(source: HookSource, payload: &Value) -> Option<String> {
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
                // search-rows: shell-classified searches no longer produce
                // interactions; they now fall through to the empty arm.
                // Restore with the sibling `search-rows` sites.
                // crate::sources::imported_history::FUNCTION_CODE_SEARCH
                // | crate::sources::imported_history::FUNCTION_GLOB_FILE_SEARCH => {
                //     ResourceAction::Search
                // }
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

pub(crate) fn string_field(value: &Value, fields: &[&str]) -> Option<String> {
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

pub(crate) fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn normalize_rfc3339(timestamp: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|timestamp| {
            timestamp
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
}

#[cfg(test)]
mod tests;
