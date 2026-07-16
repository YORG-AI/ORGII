//! Explicit context import tool.
//!
//! This records source metadata plus an optional explicit snippet. Hydration is
//! always opt-in: imported context appears in the prompt only after the agent
//! records a source via this tool.

use async_trait::async_trait;
use serde_json::Value;

use crate::session::context_import::{ContextSnapshotMeta, ContextSourceKind};
use crate::session::persistence as unified_persistence;
use crate::tools::names as tool_names;
use crate::tools::traits::{optional_bool, optional_int, optional_string, required_string, Tool, ToolError};

fn parse_source_kind(raw: &str) -> Result<ContextSourceKind, ToolError> {
    match raw {
        "session" => Ok(ContextSourceKind::Session),
        "work_item" => Ok(ContextSourceKind::WorkItem),
        "file" => Ok(ContextSourceKind::File),
        "memory" => Ok(ContextSourceKind::Memory),
        "imported_context" => Ok(ContextSourceKind::ImportedContext),
        "global_preference" => Ok(ContextSourceKind::GlobalPreference),
        other => Err(ToolError::InvalidParams(format!(
            "unsupported source_kind: {other}"
        ))),
    }
}

/// Records an explicit context import/snapshot for the current session.
pub struct ImportContextTool {
    session_id: String,
}

impl ImportContextTool {
    pub fn new(session_id: String) -> Self {
        Self { session_id }
    }
}

#[async_trait]
impl Tool for ImportContextTool {
    fn name(&self) -> &str {
        tool_names::IMPORT_CONTEXT
    }

    fn category(&self) -> &str {
        crate::tools::categories::PROJECT
    }

    fn description(&self) -> &str {
        "Explicitly import context metadata from another session, work item, file, or memory source."
    }

    fn llm_description(&self) -> Option<String> {
        Some(
            "Record an explicit context import for the current session. Use this before relying on context from another session/work item/file/memory. The import is auditable and namespaced; unrelated sessions are never imported implicitly."
                .to_string(),
        )
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "source_kind": {
                    "type": "string",
                    "enum": ["session", "work_item", "file", "memory", "imported_context", "global_preference"],
                    "description": "Where the context comes from."
                },
                "source_id": {
                    "type": "string",
                    "description": "Stable id/path/key for the imported source."
                },
                "title": {
                    "type": "string",
                    "description": "Optional human-readable label for UI source chips."
                },
                "token_estimate": {
                    "type": "integer",
                    "description": "Estimated tokens imported from this source."
                },
                "pinned": {
                    "type": "boolean",
                    "description": "Whether this import should be pinned in context selection."
                },
                "snippet": {
                    "type": "string",
                    "description": "Optional explicit source excerpt to hydrate into the next prompt. Keep it short and relevant."
                }
            },
            "required": ["source_kind", "source_id"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let source_kind = parse_source_kind(&required_string(&params, "source_kind")?)?;
        let source_id = required_string(&params, "source_id")?;
        let title = optional_string(&params, "title");
        let token_estimate = optional_int(&params, "token_estimate").unwrap_or(0) as i64;
        let pinned = optional_bool(&params, "pinned").unwrap_or(false);
        let snippet = optional_string(&params, "snippet");
        let meta = ContextSnapshotMeta::new_with_snippet(
            self.session_id.clone(),
            source_kind,
            source_id,
            title,
            token_estimate,
            pinned,
            snippet,
        );
        let snapshot_id = meta.snapshot_id.clone();
        let namespace = meta.namespace.clone();
        let source_label = format!("{}:{}", meta.source_kind.as_str(), meta.source_id);
        tokio::task::spawn_blocking(move || unified_persistence::save_context_snapshot(&meta))
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("import_context task failed: {err}")))?
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        Ok(format!(
            "Imported context snapshot {} from {} into namespace {}",
            snapshot_id, source_label, namespace
        ))
    }

    fn is_read_only(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::traits::CallContext;
    use test_helpers::test_env;

    #[tokio::test]
    async fn import_context_tool_records_snapshot() {
        let _sandbox = test_env::sandbox();
        let tool = ImportContextTool::new("target-session".to_string());
        let result = tool
            .execute_text(
                serde_json::json!({
                    "source_kind": "session",
                    "source_id": "source-session",
                    "title": "Source Session",
                    "token_estimate": 321,
                    "pinned": true,
                    "snippet": "Important prior decision: keep imports explicit."
                }),
                &CallContext::new("call-import-context", "target-session"),
            )
            .await
            .expect("import context");
        assert!(result.contains("session:source-session"));
        let snapshots = unified_persistence::load_context_snapshots("target-session")
            .expect("load snapshots");
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].namespace, "session:source-session");
        assert_eq!(snapshots[0].token_estimate, 321);
        assert!(snapshots[0].pinned);
        assert_eq!(snapshots[0].snippet.as_deref(), Some("Important prior decision: keep imports explicit."));
    }
}
