use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use rusqlite::{params, Connection, OptionalExtension};

/// A fully-written, fsynced artifact waiting for its short atomic install.
///
/// The temporary file lives beside the target so `rename` never crosses a
/// filesystem boundary. Dropping an uninstalled stage cleans up failed DB
/// attempts without touching the previously committed artifact.
#[derive(Clone)]
pub(super) struct OwnedPlanPath {
    logical_path: PathBuf,
    root: PathBuf,
    anchor: PathBuf,
    file_name: String,
}

pub(super) struct StagedPlanArtifact {
    owned: OwnedPlanPath,
    temp_path: PathBuf,
    target_path: PathBuf,
}

/// Plan artifacts are a derived filesystem projection of SQLite state. A
/// dedicated lock preserves commit/install order without holding the global
/// sessions writer across rename or directory fsync.
pub(super) fn plan_artifact_install_lock() -> &'static parking_lot::Mutex<()> {
    static LOCK: OnceLock<parking_lot::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| parking_lot::Mutex::new(()))
}

impl Drop for StagedPlanArtifact {
    fn drop(&mut self) {
        if let Err(err) = std::fs::remove_file(&self.temp_path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %self.temp_path.display(),
                    error = %err,
                    "failed to remove staged Agent Org plan artifact"
                );
            }
        }
    }
}

pub(super) fn validate_plan_file_name(file_name: &str) -> Result<(), String> {
    let path = Path::new(file_name);
    let mut components = path.components();
    let single_normal_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if !single_normal_component
        || !file_name.ends_with(".plan.md")
        || file_name.trim_end_matches(".plan.md").is_empty()
    {
        return Err(format!(
            "Agent Org plan artifact must be one *.plan.md filename, got '{file_name}'"
        ));
    }
    Ok(())
}

pub(super) fn expected_plan_root_with_connection(
    conn: &Connection,
    source_session_id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let session: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT workspace_path, agent_definition_id
             FROM agent_sessions WHERE session_id=?1",
            params![source_session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((workspace_path, agent_definition_id)) = session else {
        return Err(format!(
            "Agent Org plan source session does not exist: {source_session_id}"
        ));
    };

    if let Some(workspace_path) = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let anchor = PathBuf::from(workspace_path);
        if !anchor.is_absolute()
            || anchor
                .components()
                .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        {
            return Err(format!(
                "Agent Org plan source session has an unsafe workspace_path: {workspace_path}"
            ));
        }
        return Ok((anchor.join(".orgii").join("plans"), anchor));
    }

    let agent_id = agent_definition_id.as_deref().unwrap_or("default");
    validate_plan_file_name_component("agent_definition_id", agent_id)?;
    let root = crate::session::plan_mode::paths::plans_directory(None, agent_id)
        .ok_or_else(|| "could not resolve Agent Org fallback Plan root".to_string())?;
    let anchor = root
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("invalid Agent Org fallback Plan root: {}", root.display()))?;
    Ok((root, anchor))
}

fn validate_plan_file_name_component(field: &str, value: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    if value.trim().is_empty()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(format!(
            "Agent Org plan {field} must be one safe path component"
        ));
    }
    Ok(())
}

pub(super) fn validate_owned_plan_path_with_connection(
    conn: &Connection,
    source_session_id: &str,
    plan_path: &str,
) -> Result<OwnedPlanPath, String> {
    let logical_path = PathBuf::from(plan_path);
    let file_name = logical_path
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .ok_or_else(|| format!("Agent Org plan path has no UTF-8 filename: {plan_path}"))?
        .to_string();
    validate_plan_file_name(&file_name)?;
    let (root, anchor) = expected_plan_root_with_connection(conn, source_session_id)?;
    if !logical_path.is_absolute()
        || logical_path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        || logical_path.parent() != Some(root.as_path())
    {
        return Err(format!(
            "Agent Org plan path is outside source session {source_session_id}'s managed root {}: {}",
            root.display(),
            logical_path.display()
        ));
    }
    Ok(OwnedPlanPath {
        logical_path,
        root,
        anchor,
        file_name,
    })
}

/// Resolve the session-owned lexical root one component at a time. Existing
/// symlinks are rejected before canonicalization, and every canonical
/// component must remain under the session's canonical workspace/home anchor.
pub(super) fn resolve_owned_plan_target(
    owned: &OwnedPlanPath,
    create_directories: bool,
) -> Result<Option<PathBuf>, String> {
    let relative_root = owned.root.strip_prefix(&owned.anchor).map_err(|_| {
        format!(
            "Agent Org Plan root {} is outside anchor {}",
            owned.root.display(),
            owned.anchor.display()
        )
    })?;
    let canonical_anchor = std::fs::canonicalize(&owned.anchor).map_err(|err| {
        format!(
            "failed to canonicalize Agent Org Plan anchor {}: {err}",
            owned.anchor.display()
        )
    })?;
    let mut current = canonical_anchor.clone();
    for component in relative_root.components() {
        let Component::Normal(component) = component else {
            return Err(format!(
                "Agent Org Plan root contains an unsafe component: {}",
                owned.root.display()
            ));
        };
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Agent Org Plan root contains a symlink: {}",
                    current.display()
                ));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!(
                    "Agent Org Plan root component is not a directory: {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound && create_directories => {
                std::fs::create_dir(&current).map_err(|create_err| {
                    format!(
                        "failed to create Agent Org Plan directory {}: {create_err}",
                        current.display()
                    )
                })?;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(format!(
                    "failed to inspect Agent Org Plan directory {}: {err}",
                    current.display()
                ));
            }
        }
        let canonical_current = std::fs::canonicalize(&current).map_err(|err| {
            format!(
                "failed to canonicalize Agent Org Plan directory {}: {err}",
                current.display()
            )
        })?;
        if !canonical_current.starts_with(&canonical_anchor) {
            return Err(format!(
                "Agent Org Plan directory escaped its canonical anchor: {}",
                canonical_current.display()
            ));
        }
        current = canonical_current;
    }

    let target = current.join(&owned.file_name);
    match std::fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Agent Org plan artifact is a symlink: {}",
            target.display()
        )),
        Ok(metadata) if !metadata.is_file() => Err(format!(
            "Agent Org plan artifact is not a regular file: {}",
            target.display()
        )),
        Ok(_) => Ok(Some(target)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Some(target)),
        Err(err) => Err(format!(
            "failed to inspect Agent Org plan artifact {}: {err}",
            target.display()
        )),
    }
}

pub(super) fn stage_plan_artifact_with_connection(
    conn: &Connection,
    source_session_id: &str,
    plan_path: &str,
    canonical_content: &str,
) -> Result<StagedPlanArtifact, String> {
    let owned = validate_owned_plan_path_with_connection(conn, source_session_id, plan_path)?;
    let target_path = resolve_owned_plan_target(&owned, true)?.ok_or_else(|| {
        format!(
            "could not materialize managed Agent Org plan root for {}",
            owned.logical_path.display()
        )
    })?;
    stage_owned_plan_artifact(owned, target_path, canonical_content)
}

pub(super) fn stage_plan_artifact_for_existing_revision_with_connection(
    conn: &Connection,
    source_session_id: &str,
    plan_path: &str,
    canonical_content: &str,
) -> Result<Option<StagedPlanArtifact>, String> {
    let Some(owned) =
        owned_plan_path_for_existing_revision_with_connection(conn, source_session_id, plan_path)?
    else {
        return Ok(None);
    };
    let target_path = resolve_owned_plan_target(&owned, true)?.ok_or_else(|| {
        format!(
            "could not materialize managed Agent Org plan root for {}",
            owned.logical_path.display()
        )
    })?;
    stage_owned_plan_artifact(owned, target_path, canonical_content).map(Some)
}

fn owned_plan_path_for_existing_revision_with_connection(
    conn: &Connection,
    source_session_id: &str,
    plan_path: &str,
) -> Result<Option<OwnedPlanPath>, String> {
    match validate_owned_plan_path_with_connection(conn, source_session_id, plan_path) {
        Ok(owned) => Ok(Some(owned)),
        Err(err) => {
            tracing::warn!(
                source_session_id,
                plan_path,
                error = %err,
                "skipping unmanaged historical Agent Org plan artifact"
            );
            Ok(None)
        }
    }
}

fn stage_owned_plan_artifact(
    owned: OwnedPlanPath,
    target_path: PathBuf,
    canonical_content: &str,
) -> Result<StagedPlanArtifact, String> {
    let parent = target_path.parent().ok_or_else(|| {
        format!(
            "Agent Org plan path has no parent: {}",
            target_path.display()
        )
    })?;
    let temp_path = parent.join(format!(
        ".{}.approval-{}.tmp",
        owned.file_name,
        uuid::Uuid::new_v4()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|err| {
            format!(
                "failed to stage Agent Org plan artifact {}: {err}",
                temp_path.display()
            )
        })?;
    if let Err(err) = file
        .write_all(canonical_content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!(
            "failed to persist staged Agent Org plan artifact {}: {err}",
            temp_path.display()
        ));
    }
    Ok(StagedPlanArtifact {
        owned,
        temp_path,
        target_path,
    })
}

/// Install only the already-fsynced bytes. Callers invoke this after SQLite
/// commits while holding the dedicated artifact lock so two revisions cannot
/// install out of commit order and unrelated database writes are not blocked.
pub(super) fn install_staged_plan_artifact(
    staged: Option<&StagedPlanArtifact>,
) -> Result<(), String> {
    let Some(staged) = staged else {
        return Ok(());
    };
    let current_target = resolve_owned_plan_target(&staged.owned, true)?
        .ok_or_else(|| "managed Agent Org Plan root disappeared before install".to_string())?;
    if current_target != staged.target_path {
        return Err(format!(
            "managed Agent Org plan target changed before install: {} -> {}",
            staged.target_path.display(),
            current_target.display()
        ));
    }
    std::fs::rename(&staged.temp_path, &staged.target_path).map_err(|err| {
        format!(
            "failed to atomically install Agent Org plan artifact {}: {err}",
            staged.target_path.display()
        )
    })?;
    sync_parent_directory(&staged.target_path)
}

#[cfg(unix)]
pub(super) fn sync_parent_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Agent Org plan path has no parent: {}", path.display()))?;
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|err| {
            format!(
                "failed to sync Agent Org plan directory {}: {err}",
                parent.display()
            )
        })
}

#[cfg(not(unix))]
pub(super) fn sync_parent_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// A committed DB mutation must never be surfaced as failed merely because
/// its derived artifact could not be installed. SQLite remains authoritative,
/// and approval detail reads use the durable database content.
pub(super) fn finish_committed_artifact<T>(
    result: Result<(T, Option<String>), String>,
    staged: Option<&StagedPlanArtifact>,
) -> Result<T, String> {
    match result {
        Ok((value, artifact_error)) => {
            if let Some(err) = artifact_error {
                tracing::warn!(
                    plan_path = staged
                        .map(|artifact| artifact.target_path.display().to_string())
                        .unwrap_or_default(),
                    error = %err,
                    "Agent Org plan DB commit succeeded but its derived artifact could not be installed"
                );
            }
            Ok(value)
        }
        Err(err) => Err(err),
    }
}
