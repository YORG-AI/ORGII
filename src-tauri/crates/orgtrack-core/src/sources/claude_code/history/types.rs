use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;

use crate::sources::imported_history::{
    self,
    metadata::{ImportedHistoryImpactStats, RoundUsage},
};

#[derive(Debug, Clone)]
pub(super) struct ClaudeCodeHistoryMeta {
    pub(super) source_session_id: String,
    pub(super) session_id: String,
    pub(super) source_path: String,
    pub(super) source_record_key: String,
    pub(super) source_mtime_ms: i64,
    pub(super) source_size_bytes: i64,
    pub(super) source_fingerprint: String,
    pub(super) name: String,
    pub(super) created_at_ms: i64,
    pub(super) updated_at_ms: i64,
    pub(super) model: Option<String>,
    pub(super) repo_path: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) input_tokens: i64,
    pub(super) output_tokens: i64,
    pub(super) cache_read_tokens: i64,
    pub(super) cache_write_tokens: i64,
    pub(super) rounds: Vec<RoundUsage>,
    pub(super) impact: ImportedHistoryImpactStats,
    /// Raw `entrypoint` recorded by the transcript, naming the client surface
    /// that produced it. Empty when no record carried one.
    pub(super) entrypoint: String,
    /// Set for Task-tool subagent transcripts: the parent session's frontend
    /// id (`claudecodeapp-<parent-uuid>`). `None` for ordinary top-level
    /// sessions. Non-empty values are subsumed out of the sidebar/kanban.
    pub(super) parent_session_id: Option<String>,
    /// `uuid` of the first `type == "user"` line. Context-window continuation
    /// rewrites copy the conversation into a NEW session file with no link
    /// field, but message uuids are preserved — so this is a stable group key
    /// uniting a conversation's continuation siblings for dedupe.
    pub(super) first_user_uuid: Option<String>,
    /// Compact-boundary uuids retained by continuation rewrites. Together
    /// with `first_user_uuid` these form a bounded ancestry marker set.
    pub(super) continuation_markers: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClaudeJsonlLine {
    #[serde(default)]
    pub(super) r#type: String,
    #[serde(default)]
    pub(super) subtype: String,
    #[serde(default)]
    pub(super) summary: String,
    /// `ai-title` records: the auto-generated title shown in the Claude Code app.
    #[serde(default)]
    pub(super) ai_title: String,
    /// `custom-title` records: a user-set title that overrides the AI title.
    #[serde(default)]
    pub(super) custom_title: String,
    #[serde(default)]
    pub(super) timestamp: Option<String>,
    #[serde(default)]
    pub(super) cwd: String,
    #[serde(default)]
    pub(super) git_branch: String,
    #[serde(default)]
    pub(super) message: Option<ClaudeMessage>,
    /// Sidecar payload on tool-result lines. For edit tools it carries a
    /// `structuredPatch` with exact `+`/`-` diff lines.
    #[serde(default)]
    pub(super) tool_use_result: Option<Value>,
    /// `true` on every line of a Task-tool subagent transcript
    /// (`<parent-uuid>/subagents/agent-*.jsonl`). Marks the whole file as a
    /// child session that must be subsumed under its parent.
    /// Which client surface produced this record (`claude-desktop`, `cli`,
    /// `vscode`, an `sdk-*` embedder, ...). Written on user records.
    #[serde(default)]
    pub(super) entrypoint: String,
    #[serde(default)]
    pub(super) is_sidechain: bool,
    /// The parent session's UUID. On a subagent transcript every line carries
    /// the spawning session's id here (not the subagent's own `agent-*` stem),
    /// which is exactly the parent linkage we need.
    #[serde(default)]
    pub(super) session_id: String,
    /// Per-message uuid, preserved verbatim across continuation rewrites.
    #[serde(default)]
    pub(super) uuid: String,
    /// `true` on harness-injected user lines (command caveats, hook feedback,
    /// loop ticks) that Claude Code's own UI hides from the conversation.
    #[serde(default)]
    pub(super) is_meta: bool,
    /// Provenance of a user line. Observed kinds: `human` (typed prompt) and
    /// `task-notification` (background-task completion wake).
    #[serde(default)]
    pub(super) origin: Option<ClaudeLineOrigin>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ClaudeLineOrigin {
    #[serde(default)]
    pub(super) kind: String,
}

pub(super) fn is_harness_injected_user_line(parsed: &ClaudeJsonlLine) -> bool {
    imported_history::is_harness_injected_user_marker(
        parsed.is_meta,
        parsed.origin.as_ref().map(|origin| origin.kind.as_str()),
    )
}

#[derive(Debug, Deserialize)]
pub(super) struct ClaudeMessage {
    /// Assistant API-response id (`msg_…`). One response is written across
    /// several JSONL lines that each repeat the cumulative `usage`, so tokens
    /// are counted once per unique id.
    #[serde(default)]
    pub(super) id: String,
    #[serde(default)]
    pub(super) model: String,
    #[serde(default)]
    pub(super) content: Value,
    #[serde(default)]
    pub(super) usage: Option<ClaudeUsage>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ClaudeUsage {
    #[serde(default)]
    pub(super) input_tokens: i64,
    #[serde(default)]
    pub(super) output_tokens: i64,
    #[serde(default)]
    pub(super) cache_read_input_tokens: i64,
    #[serde(default)]
    pub(super) cache_creation_input_tokens: i64,
}

#[derive(Debug, Clone)]
pub(super) struct ClaudeSessionTitle {
    pub(super) name: String,
    pub(super) name_source: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClaudeSessionMetadataFile {
    #[serde(default)]
    pub(super) session_id: String,
    #[serde(default)]
    pub(super) name: String,
    #[serde(default)]
    pub(super) name_source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ClaudeSubagentMetadataFile {
    #[serde(default)]
    pub(super) description: String,
}

#[derive(Debug, Clone)]
pub(super) struct ClaudeCodeSessionFile {
    pub(super) file_stem: String,
    pub(super) path: PathBuf,
}
