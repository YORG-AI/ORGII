//! User-managed, global workspace-containment exemptions.
//!
//! An exemption is deliberately narrower than a general security bypass: it
//! permits a path outside a session workspace, but does not override an
//! agent's forbidden-path policy, read-only mode, command approvals, or OS
//! permissions. Entries are canonical existing directories so a symlink
//! cannot change the meaning of a grant after it was saved.

use std::path::{Component, Path, PathBuf};

use chrono::Utc;
use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
use serde::Serialize;

use super::SecurityPolicy;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalPathExemption {
    pub id: String,
    pub canonical_path: String,
    pub access: String,
    pub recursive: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Create the global exemption table in the shared sessions database.
pub fn init_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS global_path_exemptions (
            id TEXT PRIMARY KEY,
            canonical_path TEXT NOT NULL UNIQUE,
            access TEXT NOT NULL,
            recursive INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_global_path_exemptions_path
         ON global_path_exemptions(canonical_path)",
        [],
    )?;
    Ok(())
}

fn row_to_exemption(row: &rusqlite::Row<'_>) -> SqliteResult<GlobalPathExemption> {
    Ok(GlobalPathExemption {
        id: row.get(0)?,
        canonical_path: row.get(1)?,
        access: row.get(2)?,
        recursive: row.get::<_, i64>(3)? != 0,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn list_with(conn: &Connection) -> SqliteResult<Vec<GlobalPathExemption>> {
    let mut statement = conn.prepare(
        "SELECT id, canonical_path, access, recursive, created_at, updated_at
         FROM global_path_exemptions
         ORDER BY canonical_path ASC",
    )?;
    let rows = statement.query_map([], row_to_exemption)?;
    rows.collect::<SqliteResult<Vec<_>>>()
}

/// List all durable global path exemptions.
pub fn list() -> Result<Vec<GlobalPathExemption>, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    list_with(&conn).map_err(|err| err.to_string())
}

/// Return canonical roots for hot-path authorization checks.
/// An unavailable database fails closed and grants no extra authority.
pub fn global_paths() -> Vec<PathBuf> {
    match list() {
        Ok(entries) => entries
            .into_iter()
            .map(|entry| PathBuf::from(entry.canonical_path))
            .collect(),
        Err(err) => {
            tracing::warn!(error = %err, "global path exemptions unavailable; failing closed");
            Vec::new()
        }
    }
}

fn expand_home(raw: &str) -> Result<PathBuf, String> {
    if raw == "~" {
        return dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string());
    }
    if let Some(suffix) = raw.strip_prefix("~/") {
        let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
        return Ok(home.join(suffix));
    }
    Ok(PathBuf::from(raw))
}

/// Validate and canonicalize an exemption root before it reaches storage.
pub fn canonicalize_registration_path(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("Path must not be empty".to_string());
    }
    if raw.contains('\0') {
        return Err("Path contains null byte".to_string());
    }

    let expanded = expand_home(raw)?;
    if !expanded.is_absolute() {
        return Err("Global path exemptions must use an absolute directory path".to_string());
    }
    if expanded
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Path traversal (..) is not allowed".to_string());
    }

    let canonical = expanded.canonicalize().map_err(|err| {
        format!(
            "Directory \"{}\" does not exist or is inaccessible: {err}",
            expanded.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err("Global path exemptions must point to an existing directory".to_string());
    }
    if canonical == Path::new("/") {
        return Err("The filesystem root cannot be globally exempted".to_string());
    }
    if dirs::home_dir().is_some_and(|home| canonical == home) {
        return Err("The entire home directory cannot be globally exempted".to_string());
    }

    Ok(canonical)
}

/// Add one canonical directory, returning the existing entry on duplicate
/// registration so repeated UI submissions are idempotent.
pub fn add(raw: &str) -> Result<GlobalPathExemption, String> {
    let canonical = canonicalize_registration_path(raw)?;
    let canonical_text = canonical.to_string_lossy().into_owned();

    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| err.to_string())?;
        if let Some(existing) = conn
            .query_row(
                "SELECT id, canonical_path, access, recursive, created_at, updated_at
                 FROM global_path_exemptions WHERE canonical_path = ?1",
                params![canonical_text],
                row_to_exemption,
            )
            .optional()
            .map_err(|err| err.to_string())?
        {
            return Ok(existing);
        }

        let now = Utc::now().to_rfc3339();
        let exemption = GlobalPathExemption {
            id: uuid::Uuid::new_v4().to_string(),
            canonical_path: canonical_text,
            access: "read_write".to_string(),
            recursive: true,
            created_at: now.clone(),
            updated_at: now,
        };
        conn.execute(
            "INSERT INTO global_path_exemptions
             (id, canonical_path, access, recursive, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                exemption.id,
                exemption.canonical_path,
                exemption.access,
                i64::from(exemption.recursive),
                exemption.created_at,
                exemption.updated_at,
            ],
        )
        .map_err(|err| err.to_string())?;
        Ok(exemption)
    })
}

/// Remove an exemption by stable id. Removing a missing id is idempotent.
pub fn remove(id: &str) -> Result<bool, String> {
    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| err.to_string())?;
        conn.execute(
            "DELETE FROM global_path_exemptions WHERE id = ?1",
            params![id],
        )
        .map(|count| count > 0)
        .map_err(|err| err.to_string())
    })
}

/// Whether a canonical candidate is under one of the supplied exemption roots.
pub fn allows_candidate_with_roots(candidate: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| candidate.starts_with(root))
}

/// Whether a candidate is covered by the live durable grant list.
pub fn allows_candidate(candidate: &Path) -> bool {
    allows_candidate_with_roots(candidate, &global_paths())
}

/// Authorize a structured file path before it can be routed to the frontend.
/// Explicit forbidden paths are checked both before and after resolution.
pub fn authorize_path(
    raw: &str,
    allowed_dir: Option<&Path>,
    additional_allowed_dirs: &[PathBuf],
    policy: Option<&SecurityPolicy>,
) -> Result<PathBuf, String> {
    let global_roots = global_paths();
    authorize_path_with_global_roots(
        raw,
        allowed_dir,
        additional_allowed_dirs,
        policy,
        &global_roots,
    )
}

pub(crate) fn authorize_path_with_global_roots(
    raw: &str,
    allowed_dir: Option<&Path>,
    additional_allowed_dirs: &[PathBuf],
    policy: Option<&SecurityPolicy>,
    global_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    if let Some(policy) = policy {
        policy.validate_path_syntax(raw)?;
    }

    let mut roots = additional_allowed_dirs.to_vec();
    roots.extend_from_slice(global_roots);
    let resolved =
        crate::foundation::tool_infra::file::resolve_path_with_extras(raw, allowed_dir, &roots)?;

    if let Some(policy) = policy {
        policy.validate_resolved_path(&resolved)?;
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_requires_an_existing_absolute_directory() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = canonicalize_registration_path(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(canonical, dir.path().canonicalize().unwrap());
        assert!(canonicalize_registration_path("relative/path").is_err());
        let missing = "/path/that/does/not/exist";
        let error = canonicalize_registration_path(missing).unwrap_err();
        assert!(error.contains(missing));
        assert!(error.contains("does not exist"));
    }

    #[test]
    fn candidate_must_be_under_a_granted_root() {
        let root = PathBuf::from("/tmp/global-grant");
        assert!(allows_candidate_with_roots(
            Path::new("/tmp/global-grant/nested/file.txt"),
            &[root.clone()]
        ));
        assert!(!allows_candidate_with_roots(
            Path::new("/tmp/global-grant-sibling/file.txt"),
            &[root]
        ));
    }

    #[test]
    fn exemption_allows_outside_workspace_but_forbidden_path_wins() {
        use crate::security::{AutonomyLevel, CommandRiskRules};

        let workspace = tempfile::tempdir().unwrap();
        let exemption = tempfile::tempdir().unwrap();
        let target = exemption.path().join("outside.txt");
        std::fs::write(&target, "allowed by exemption").unwrap();
        let roots = vec![exemption.path().canonicalize().unwrap()];

        let allowed = authorize_path_with_global_roots(
            target.to_str().unwrap(),
            Some(workspace.path()),
            &[],
            Some(&SecurityPolicy::permissive()),
            &roots,
        )
        .unwrap();
        assert_eq!(allowed, target);

        let forbidden_policy = SecurityPolicy::new(
            AutonomyLevel::Full,
            true,
            Vec::new(),
            Vec::new(),
            vec![exemption.path().to_string_lossy().into_owned()],
            true,
            CommandRiskRules::default(),
        );
        assert!(authorize_path_with_global_roots(
            target.to_str().unwrap(),
            Some(workspace.path()),
            &[],
            Some(&forbidden_policy),
            &roots,
        )
        .is_err());
    }
}
