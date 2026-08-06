//! Rust-native Code Map tool.
//!
//! Read-only agent surface over the persistent Code Map symbol graph.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use code_map::{
    CodeMapAction, CodeMapLanguage, CodeMapNodeKind, CodeMapQueryRequest, CodeMapService,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex as TokioMutex;

use crate::security::SecurityPolicy;
use crate::session::workspace::SessionWorkspace;
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params_described, Tool, ToolError};

const DEFAULT_MAX_RESULTS: usize = 50;
const MAX_RESULTS_CAP: usize = 200;
const DEFAULT_MAX_DEPTH: usize = 2;
const MAX_DEPTH_CAP: usize = 5;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeMapToolAction {
    Status,
    Search,
    Node,
    Callers,
    Callees,
    Impact,
    Explore,
}

impl CodeMapToolAction {
    fn as_code_map_action(self) -> CodeMapAction {
        match self {
            Self::Status => CodeMapAction::Status,
            Self::Search => CodeMapAction::Search,
            Self::Node => CodeMapAction::Node,
            Self::Callers => CodeMapAction::Callers,
            Self::Callees => CodeMapAction::Callees,
            Self::Impact => CodeMapAction::Impact,
            Self::Explore => CodeMapAction::Explore,
        }
    }
}

/// Flat params keep the provider schema readable. Per-action requiredness is
/// enforced in `execute_text` so errors can name the missing field exactly.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CodeMapToolParams {
    /// Operation to perform: `status`, `search`, `node`, `callers`, `callees`, `impact`, or `explore`.
    pub action: CodeMapToolAction,
    /// Optional workspace path. Defaults to the current session working directory.
    #[serde(default)]
    pub workspace_path: Option<PathBuf>,
    /// Symbol/name/text query. Required for `search` and `explore`; accepted by node/relationship actions as a resolver.
    #[serde(default)]
    pub query: Option<String>,
    /// Exact Code Map node id. Preferred for `node`, `callers`, `callees`, and `impact` after search results.
    #[serde(default)]
    pub node_id: Option<String>,
    /// File path to inspect or resolve to a file node. May be relative to the selected workspace or absolute within an allowed root.
    #[serde(default)]
    pub file_path: Option<PathBuf>,
    /// Optional symbol kind filter for search/explore, such as `function`, `class`, `interface`, or `file`.
    #[serde(default)]
    pub kind: Option<CodeMapNodeKind>,
    /// Optional language filter for search/explore, such as `rust`, `typescript`, `javascript`, or `python`.
    #[serde(default)]
    pub language: Option<CodeMapLanguage>,
    /// Optional relative path prefix filter for search/explore.
    #[serde(default)]
    pub path_prefix: Option<String>,
    /// Include source snippets when supported. Defaults to true for node/explore and false for search.
    #[serde(default)]
    pub include_source: Option<bool>,
    /// Include relationship summaries when supported. Defaults to true for node/explore.
    #[serde(default)]
    pub include_relationships: Option<bool>,
    /// Maximum result count. Defaults to 50, capped at 200.
    #[serde(default)]
    pub max_results: Option<usize>,
    /// Maximum relationship traversal depth for `impact`. Defaults to 2, capped at 5.
    #[serde(default)]
    pub max_depth: Option<usize>,
}

pub struct CodeMapTool {
    default_workspace: PathBuf,
    active_repo: TokioMutex<Option<PathBuf>>,
    workspace_state: Arc<parking_lot::RwLock<SessionWorkspace>>,
    restrict_to_workspace: bool,
    security_policy: Option<Arc<SecurityPolicy>>,
}

impl CodeMapTool {
    pub fn new(
        default_workspace: PathBuf,
        workspace_state: Arc<parking_lot::RwLock<SessionWorkspace>>,
    ) -> Self {
        Self {
            default_workspace,
            active_repo: TokioMutex::new(None),
            workspace_state,
            restrict_to_workspace: false,
            security_policy: None,
        }
    }

    pub fn with_restrict_to_workspace(mut self, restricted: bool) -> Self {
        self.restrict_to_workspace = restricted;
        self
    }

    pub fn with_security_policy(mut self, policy: Arc<SecurityPolicy>) -> Self {
        self.security_policy = Some(policy);
        self
    }

    async fn resolve_workspace(&self, explicit: Option<PathBuf>) -> Result<PathBuf, ToolError> {
        if let Some(path) = explicit {
            return self.authorize_workspace_path(path).await;
        }

        let active_path = self.active_repo.lock().await.clone();
        if let Some(path) = active_path {
            return self.authorize_workspace_path(path).await;
        }

        let path = self.workspace_state.read().working_dir().to_path_buf();
        self.authorize_workspace_path(path).await
    }

    async fn authorize_workspace_path(&self, path: PathBuf) -> Result<PathBuf, ToolError> {
        self.authorize_path(&path).await
    }

    async fn authorize_path(&self, path: &PathBuf) -> Result<PathBuf, ToolError> {
        let workspace_only = self
            .security_policy
            .as_ref()
            .is_some_and(|policy| policy.workspace_only);
        let containment_required = self.restrict_to_workspace || workspace_only;
        let current_workspace = self.workspace_state.read().working_dir().to_path_buf();
        let mut extra = self.workspace_state.read().effective_roots();
        extra.extend(self.active_repo.lock().await.clone());

        // Code Map has always interpreted explicit relative paths from the
        // selected workspace. Keep that base even when open policy does not
        // require workspace containment.
        if let Some(policy) = self.security_policy.as_deref() {
            policy
                .validate_path_syntax(&path.to_string_lossy())
                .map_err(map_path_error)?;
        }
        let resolved_input = if path.is_absolute() {
            path.clone()
        } else {
            current_workspace.join(path)
        };
        crate::security::global_path_exemptions::authorize_path(
            &resolved_input.to_string_lossy(),
            containment_required.then_some(current_workspace.as_path()),
            &extra,
            self.security_policy.as_deref(),
        )
        .map_err(map_path_error)
        .map(|authorized| authorized.canonicalize().unwrap_or(authorized))
    }

    async fn resolve_file_path(
        &self,
        workspace_path: &PathBuf,
        file_path: Option<PathBuf>,
    ) -> Result<Option<PathBuf>, ToolError> {
        let Some(file_path) = file_path else {
            return Ok(None);
        };
        let resolved = if file_path.is_absolute() {
            file_path
        } else {
            workspace_path.join(file_path)
        };
        self.authorize_path(&resolved).await.map(Some)
    }
}

fn map_path_error(err: String) -> ToolError {
    if err.contains("outside the allowed directory")
        || err.contains("null byte")
        || err.contains("forbidden location")
        || err.contains("Path traversal")
        || err.contains("URL-encoded path traversal")
    {
        ToolError::PermissionDenied(err)
    } else {
        ToolError::ExecutionFailed(err)
    }
}

#[async_trait]
impl Tool for CodeMapTool {
    fn name(&self) -> &str {
        tool_names::USE_CODE_MAP
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn search_hint(&self) -> &str {
        "code map symbol graph callers callees impact dependencies relationships references"
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn output_budget(&self) -> usize {
        30_000
    }

    fn description(&self) -> &str {
        "Use the Rust-native Code Map symbol graph for the current workspace.\n\
         This read-only tool queries an existing Code Map index. Use it when you need repository-scale symbol context: where a type/function is defined, who calls it, what it calls, impact radius, or relationship-oriented exploration. Use `manage_code_map` for index lifecycle actions such as status checks, incremental indexing, full rebuilds, cancellation, or clearing the local index.\n\
         Code Map reports confidence/provenance because some languages are AST-backed while fallback extraction is heuristic.\n\
         Workflow:\n\
         - For broad architecture, dependency, or impact questions, prefer `use_code_map` over ad-hoc text search after confirming the index is ready.\n\
         - If the index is missing, stale, failed, or indexing status is unknown, use `manage_code_map` status/index/reindex first when that tool is available.\n\
         - After search/explore returns a node_id, pass that node_id to node/callers/callees/impact rather than repeating fuzzy queries.\n\
         Actions:\n\
         - status: show index status, freshness, unresolved refs, and file/symbol/relationship counts\n\
         - search: find symbols by name, qualified name, source signature, or path\n\
         - node: inspect a symbol or file with source context and relationships\n\
         - callers: show incoming call/reference relationships, excluding containment-only edges\n\
         - callees: show outgoing call/reference relationships, excluding containment-only edges\n\
         - impact: bounded reverse traversal for semantic dependency impact analysis\n\
         - explore: ranked Code Map exploration with source context and relationship counts."
    }

    fn llm_description(&self) -> Option<String> {
        let workspace = self
            .workspace_state
            .try_read()
            .map(|state| state.working_dir().display().to_string())
            .unwrap_or_else(|| self.default_workspace.display().to_string());
        Some(format!(
            "Use the Rust-native Code Map symbol graph for {workspace}. Prefer this over ad-hoc text search for repository-scale symbol, dependency, caller/callee, or impact questions after the index is ready. This tool is read-only and expects an existing index; use `manage_code_map` first when indexing, refreshing, clearing, or checking stale/missing index state. After search/explore returns a node_id, pass that node_id to node/callers/callees/impact instead of repeating fuzzy queries. Results include confidence/provenance because some extraction and relationships are heuristic. Actions: status, search, node, callers, callees, impact, explore."
        ))
    }

    fn parameters(&self) -> Value {
        params_schema::<CodeMapToolParams>()
    }

    async fn set_active_repo(&self, repo_path: &str) {
        let path = PathBuf::from(repo_path);
        if path.exists() {
            *self.active_repo.lock().await = Some(path);
        }
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let params: CodeMapToolParams = parse_params_described(params)?;
        let workspace_path = self.resolve_workspace(params.workspace_path).await?;
        let file_path = self
            .resolve_file_path(&workspace_path, params.file_path)
            .await?;
        let max_results = params
            .max_results
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .clamp(1, MAX_RESULTS_CAP);
        let max_depth = params
            .max_depth
            .unwrap_or(DEFAULT_MAX_DEPTH)
            .clamp(1, MAX_DEPTH_CAP);

        let kind = params.kind;
        let language = params.language;
        let path_prefix = params.path_prefix;
        let include_source = params.include_source;
        let include_relationships = params.include_relationships;

        match params.action {
            CodeMapToolAction::Status => CodeMapService::query(
                CodeMapAction::Status,
                CodeMapQueryRequest {
                    workspace_path,
                    query: None,
                    node_id: None,
                    file_path: None,
                    kind: None,
                    language: None,
                    path_prefix: None,
                    include_source: false,
                    include_relationships: false,
                    max_results,
                    max_depth,
                },
            )
            .await
            .map_err(|err| ToolError::ExecutionFailed(err.to_string())),
            CodeMapToolAction::Search | CodeMapToolAction::Explore => {
                let query = params.query.ok_or_else(|| {
                    ToolError::InvalidParams("`search` and `explore` require `query`.".to_string())
                })?;
                CodeMapService::query(
                    params.action.as_code_map_action(),
                    CodeMapQueryRequest {
                        workspace_path,
                        query: Some(query),
                        node_id: None,
                        file_path: None,
                        kind,
                        language,
                        path_prefix,
                        include_source: include_source
                            .unwrap_or(matches!(params.action, CodeMapToolAction::Explore)),
                        include_relationships: include_relationships
                            .unwrap_or(matches!(params.action, CodeMapToolAction::Explore)),
                        max_results,
                        max_depth,
                    },
                )
                .await
                .map_err(|err| ToolError::ExecutionFailed(err.to_string()))
            }
            CodeMapToolAction::Node
            | CodeMapToolAction::Callers
            | CodeMapToolAction::Callees
            | CodeMapToolAction::Impact => {
                if params.node_id.is_none() && params.query.is_none() && file_path.is_none() {
                    return Err(ToolError::InvalidParams(
                        "`node`, `callers`, `callees`, and `impact` require one of `node_id`, `query`, or `file_path`.".to_string(),
                    ));
                }
                CodeMapService::query(
                    params.action.as_code_map_action(),
                    CodeMapQueryRequest {
                        workspace_path,
                        query: params.query,
                        node_id: params.node_id,
                        file_path,
                        kind,
                        language,
                        path_prefix,
                        include_source: include_source
                            .unwrap_or(matches!(params.action, CodeMapToolAction::Node)),
                        include_relationships: include_relationships.unwrap_or(true),
                        max_results,
                        max_depth,
                    },
                )
                .await
                .map_err(|err| ToolError::ExecutionFailed(err.to_string()))
            }
        }
    }
}

#[cfg(test)]
#[path = "code_map_tests.rs"]
mod tests;
