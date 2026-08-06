//! Filesystem tools — `read_file`, `list_dir`, and `delete_file`.
//!
//! Thin wrappers over shared file infrastructure. When `ActionRouter` is
//! present and in `work_station` mode, calls are routed through the frontend
//! ActionSystem instead of direct backend filesystem access.
//!
//! `edit_file` lives in [`super::edit_file`] (supports both create/overwrite
//! and search-replace).

mod delete_file;
mod list_dir;
mod read_file;
mod write_env_file;

pub use delete_file::DeleteFileTool;
pub use list_dir::ListDirTool;
pub use read_file::ReadFileTool;
pub use write_env_file::WriteEnvFileTool;

use parking_lot::RwLock;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::security::SecurityPolicy;
use crate::session::workspace::SessionWorkspace;
use crate::tools::traits::ToolError;

/// Shared handle to a session's live `SessionWorkspace`. Held as an
/// `Arc<RwLock<_>>` so `/add-dir` mutator commands land in file tools without
/// rebuilding the tool registry; tools snapshot the roots into a
/// `Vec<PathBuf>` on each call.
pub(super) type WorkspaceStateHandle = Arc<RwLock<SessionWorkspace>>;

/// Build the full extra-roots list for a file-tool call: every live
/// `effective_root()` of the session workspace (workspace_root, worktree
/// working_dir, all `/add-dir` grants) plus the static extras pinned at
/// construction time (scratchpad, readonly skill dirs).
///
/// Callers pass the result as the `additional_allowed_dirs` argument of
/// `tool_infra::file::resolve_path_with_extras`; combined with a live
/// `working_dir()` primary root this makes the session workspace the
/// single source of truth for file-tool path authorization.
pub(super) fn allowed_roots(
    static_dirs: &[PathBuf],
    workspace_state: Option<&WorkspaceStateHandle>,
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = static_dirs.to_vec();
    if let Some(state) = workspace_state {
        out.extend(state.read().effective_roots());
    }
    out
}

/// Live primary sandbox root: the session's current `working_dir()` when
/// the tool was constructed restricted, `None` when unrestricted.
pub(super) fn live_allowed_dir(
    restricted: bool,
    workspace_state: Option<&WorkspaceStateHandle>,
    fallback: Option<&PathBuf>,
) -> Option<PathBuf> {
    if !restricted {
        return None;
    }
    workspace_state
        .map(|state| state.read().working_dir().to_path_buf())
        .or_else(|| fallback.cloned())
}

/// Apply the file-tool authorization order shared by native structured file
/// tools. Global exemptions are consulted by the underlying helper on every
/// call, so removing one takes effect before the next tool invocation.
pub(super) fn authorize_path(
    raw: &str,
    allowed_dir: Option<&Path>,
    additional_allowed_dirs: &[PathBuf],
    policy: Option<&SecurityPolicy>,
) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let global_roots = crate::security::global_path_exemptions::global_paths();
    let mut authorized_roots = additional_allowed_dirs.to_vec();
    authorized_roots.extend(global_roots.iter().cloned());
    let path = crate::security::global_path_exemptions::authorize_path_with_global_roots(
        raw,
        allowed_dir,
        additional_allowed_dirs,
        policy,
        &global_roots,
    )?;
    Ok((path, authorized_roots))
}

/// Map `tool_service` String errors to `ToolError`.
pub(super) fn map_err(err: String) -> ToolError {
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
