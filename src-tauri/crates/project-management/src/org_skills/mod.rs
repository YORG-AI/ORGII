//! Org-shared skills.
//!
//! A shared skill is a small durable snapshot (SKILL.md plus bundled
//! files, size-capped) that rides the org-entity sync carrier like typed
//! properties, statuses, saved views, and quick actions. Every member
//! materializes active rows into `~/.orgii/org-skills/<org>/<name>/`,
//! which the skills loader scans as its own source. Unshare is archival
//! so removals propagate through snapshots and materializations follow.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::projects::io::helpers::{conn, now_ms};

/// Hard cap on one shared skill's total content (SKILL.md + files).
/// The snapshot rides org entity pushes; a repo-sized skill does not
/// belong on that wire.
pub const MAX_ORG_SKILL_BYTES: usize = 256 * 1024;
/// Bound each file independently as well as the aggregate snapshot. Keeping
/// this equal to the aggregate limit preserves the existing accepted payload
/// range while making the per-file invariant explicit at every ingress.
const MAX_ORG_SKILL_FILE_BYTES: usize = MAX_ORG_SKILL_BYTES;
const MAX_ORG_SKILL_FILES: usize = 256;
const MAX_ORG_SKILL_PATH_BYTES: usize = 1024;
const MAX_ORG_SKILL_PATH_COMPONENT_BYTES: usize = 255;
const ORG_SCOPE_MISMATCH: &str = "PM_ERR:ORG_SCOPE_MISMATCH";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgSkillFile {
    pub relative_path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgSkill {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub description: String,
    pub skill_md: String,
    pub files: Vec<OrgSkillFile>,
    pub provenance: Option<serde_json::Value>,
    pub shared_by: Option<String>,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareOrgSkillRequest {
    pub org_id: String,
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub skill_md: String,
    #[serde(default)]
    pub files: Vec<OrgSkillFile>,
    pub provenance: Option<serde_json::Value>,
    pub shared_by: Option<String>,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

fn valid_relative_path(path: &str) -> bool {
    let mut components = path.split('/');
    let Some(first) = components.next() else {
        return false;
    };
    let reserved_root = first.eq_ignore_ascii_case("SKILL.md")
        || first.eq_ignore_ascii_case(".orgii-skill-origin.json");

    !path.is_empty()
        && path.len() <= MAX_ORG_SKILL_PATH_BYTES
        && !path.contains(['\\', ':', '\0'])
        && !path.chars().any(char::is_control)
        && !reserved_root
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part.len() <= MAX_ORG_SKILL_PATH_COMPONENT_BYTES
        })
}

/// Validate the complete materialized snapshot at every ingress: local share,
/// remote apply, and DB-to-filesystem materialization. The returned name is
/// the same trimmed canonical form historically used by `share`.
fn validate_skill_snapshot(
    name: &str,
    skill_md: &str,
    files: &[OrgSkillFile],
) -> Result<String, String> {
    let name = name.trim().to_string();
    if !valid_name(&name) {
        return Err("PM_ERR:ORG_SKILL_NAME_INVALID".to_string());
    }
    if skill_md.trim().is_empty() {
        return Err("Shared skill needs a SKILL.md body".to_string());
    }
    if files.len() > MAX_ORG_SKILL_FILES {
        return Err(format!(
            "PM_ERR:ORG_SKILL_TOO_MANY_FILES:{}:{MAX_ORG_SKILL_FILES}",
            files.len()
        ));
    }
    if skill_md.len() > MAX_ORG_SKILL_FILE_BYTES {
        return Err(format!(
            "PM_ERR:ORG_SKILL_TOO_LARGE_FILE:SKILL.md:{}:{MAX_ORG_SKILL_FILE_BYTES}",
            skill_md.len()
        ));
    }

    let mut normalized_paths = Vec::with_capacity(files.len());
    let mut total_bytes = skill_md.len();
    if total_bytes > MAX_ORG_SKILL_BYTES {
        return Err(format!(
            "PM_ERR:ORG_SKILL_TOO_LARGE:{total_bytes}:{MAX_ORG_SKILL_BYTES}"
        ));
    }
    for file in files {
        if !valid_relative_path(&file.relative_path) {
            return Err(format!(
                "PM_ERR:ORG_SKILL_PATH_INVALID:{}",
                file.relative_path
            ));
        }
        if file.content.len() > MAX_ORG_SKILL_FILE_BYTES {
            return Err(format!(
                "PM_ERR:ORG_SKILL_TOO_LARGE_FILE:{}:{}:{MAX_ORG_SKILL_FILE_BYTES}",
                file.relative_path,
                file.content.len()
            ));
        }
        let normalized = file.relative_path.to_ascii_lowercase();
        if normalized_paths.iter().any(|existing: &String| {
            existing == &normalized
                || normalized.starts_with(&format!("{existing}/"))
                || existing.starts_with(&format!("{normalized}/"))
        }) {
            return Err(format!(
                "PM_ERR:ORG_SKILL_PATH_COLLISION:{}",
                file.relative_path
            ));
        }
        normalized_paths.push(normalized);
        total_bytes = total_bytes
            .checked_add(file.relative_path.len())
            .and_then(|size| size.checked_add(file.content.len()))
            .ok_or_else(|| format!("PM_ERR:ORG_SKILL_TOO_LARGE:overflow:{MAX_ORG_SKILL_BYTES}"))?;
        if total_bytes > MAX_ORG_SKILL_BYTES {
            return Err(format!(
                "PM_ERR:ORG_SKILL_TOO_LARGE:{total_bytes}:{MAX_ORG_SKILL_BYTES}"
            ));
        }
    }
    Ok(name)
}

fn validated_org_dir(org_id: &str) -> Result<std::path::PathBuf, String> {
    app_paths::org_skills_dir(org_id).map_err(|_| "PM_ERR:ORG_SKILL_ORG_ID_INVALID".to_string())
}

fn validate_org_id(org_id: &str) -> Result<(), String> {
    validated_org_dir(org_id).map(|_| ())
}

fn guard_skill_id_org(connection: &Connection, id: &str, org_id: &str) -> Result<(), String> {
    let stored_org: Option<String> = connection
        .query_row(
            "SELECT org_id FROM pm_org_skills WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("org skill scope lookup: {err}"))?;
    if stored_org.as_deref().is_some_and(|stored| stored != org_id) {
        return Err(format!("{ORG_SCOPE_MISMATCH}:org_skill:{id}"));
    }
    Ok(())
}

pub fn share(request: ShareOrgSkillRequest) -> Result<OrgSkill, String> {
    validate_org_id(&request.org_id)?;
    let name = validate_skill_snapshot(&request.name, &request.skill_md, &request.files)?;
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("org-skill:{}:{}", request.org_id, name));
    let files_json =
        serde_json::to_string(&request.files).map_err(|err| format!("org skill files: {err}"))?;
    let provenance_json = request
        .provenance
        .as_ref()
        .map(|value| serde_json::to_string(value).map_err(|err| format!("org skill: {err}")))
        .transpose()?;
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("org skill store tx: {err}"))?;
    guard_skill_id_org(&tx, &id, &request.org_id)?;
    let now = now_ms();
    let changed = tx
        .execute(
            "INSERT INTO pm_org_skills (
                 id, org_id, name, description, skill_md, files_json,
                 provenance_json, shared_by, archived_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?9)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 description = excluded.description,
                 skill_md = excluded.skill_md,
                 files_json = excluded.files_json,
                 provenance_json = excluded.provenance_json,
                 shared_by = excluded.shared_by,
                 archived_at = NULL,
                 updated_at = excluded.updated_at
             WHERE pm_org_skills.org_id = excluded.org_id",
            params![
                id,
                request.org_id,
                name,
                request.description.trim(),
                request.skill_md,
                files_json,
                provenance_json,
                request.shared_by,
                now
            ],
        )
        .map_err(|err| format!("org skill store: {err}"))?;
    if changed != 1 {
        return Err(format!("{ORG_SCOPE_MISMATCH}:org_skill:{id}"));
    }
    crate::sync::collab_bridge::record_org_skills_touch(&tx, &request.org_id, &id)?;
    let skill = read(&tx, &request.org_id, &id)?;
    tx.commit()
        .map_err(|err| format!("org skill store commit: {err}"))?;
    materialize_org(&connection, &request.org_id)?;
    Ok(skill)
}

pub fn unshare(org_id: &str, id: &str) -> Result<OrgSkill, String> {
    validate_org_id(org_id)?;
    let connection = conn()?;
    let now = now_ms();
    let changed = connection
        .execute(
            "UPDATE pm_org_skills
                SET archived_at = COALESCE(archived_at, ?3), updated_at = ?3
              WHERE org_id = ?1 AND id = ?2",
            params![org_id, id, now],
        )
        .map_err(|err| format!("org skill store: {err}"))?;
    if changed == 0 {
        return Err(format!("Org skill '{id}' not found"));
    }
    crate::sync::collab_bridge::record_org_skills_touch(&connection, org_id, id)?;
    let skill = read(&connection, org_id, id)?;
    materialize_org(&connection, org_id)?;
    Ok(skill)
}

pub fn list(org_id: &str) -> Result<Vec<OrgSkill>, String> {
    validate_org_id(org_id)?;
    let connection = conn()?;
    query_skills(
        &connection,
        "SELECT id, org_id, name, description, skill_md, files_json,
                provenance_json, shared_by, archived_at, created_at, updated_at
           FROM pm_org_skills
          WHERE org_id = ?1 AND archived_at IS NULL
          ORDER BY name ASC, id ASC",
        params![org_id],
    )
}

/// Every row (archived included) so removals propagate.
pub(crate) fn export_skills(
    connection: &Connection,
    org_id: &str,
) -> Result<Vec<OrgSkill>, String> {
    query_skills(
        connection,
        "SELECT id, org_id, name, description, skill_md, files_json,
                provenance_json, shared_by, archived_at, created_at, updated_at
           FROM pm_org_skills
          WHERE org_id = ?1
          ORDER BY name ASC, id ASC",
        params![org_id],
    )
}

fn query_skills(
    connection: &Connection,
    sql: &str,
    parameters: impl rusqlite::Params,
) -> Result<Vec<OrgSkill>, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|err| format!("org skill store: {err}"))?;
    let skills = statement
        .query_map(parameters, decode_skill)
        .map_err(|err| format!("org skill store: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("org skill store: {err}"))?;
    Ok(skills)
}

fn read(connection: &Connection, org_id: &str, id: &str) -> Result<OrgSkill, String> {
    connection
        .query_row(
            "SELECT id, org_id, name, description, skill_md, files_json,
                    provenance_json, shared_by, archived_at, created_at, updated_at
               FROM pm_org_skills
              WHERE org_id = ?1 AND id = ?2",
            params![org_id, id],
            decode_skill,
        )
        .map_err(|err| format!("org skill store: {err}"))
}

fn decode_skill(row: &rusqlite::Row<'_>) -> rusqlite::Result<OrgSkill> {
    let files_raw: String = row.get(5)?;
    let provenance_raw: Option<String> = row.get(6)?;
    Ok(OrgSkill {
        id: row.get(0)?,
        org_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        skill_md: row.get(4)?,
        files: serde_json::from_str(&files_raw).unwrap_or_default(),
        provenance: provenance_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
        shared_by: row.get(7)?,
        archived_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

/// Apply org skills carried on a pulled entity snapshot, then refresh the
/// local materialization so the loader sees the change immediately.
pub(crate) fn validate_wire_skills(
    connection: &Connection,
    org_id: &str,
    payload: &serde_json::Value,
) -> Result<Vec<OrgSkill>, String> {
    let Some(raw) = payload.get("orgSkills") else {
        return Ok(Vec::new());
    };
    validate_org_id(org_id)?;
    let mut skills: Vec<OrgSkill> =
        serde_json::from_value(raw.clone()).map_err(|err| format!("org skill wire: {err}"))?;

    // Validate the whole remote batch before applying any row, so one
    // malformed later entry cannot leave a partially accepted snapshot.
    for skill in &mut skills {
        if skill.org_id != org_id {
            return Err(format!(
                "org skill '{}' belongs to another organization",
                skill.id
            ));
        }
        skill.name = validate_skill_snapshot(&skill.name, &skill.skill_md, &skill.files)?;
        guard_skill_id_org(connection, &skill.id, org_id)?;
    }
    Ok(skills)
}

pub(crate) fn apply_wire_skills(
    connection: &Connection,
    org_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let skills = validate_wire_skills(connection, org_id, payload)?;

    let mut changed = false;
    for skill in skills {
        let local_updated_at: Option<i64> = connection
            .query_row(
                "SELECT updated_at FROM pm_org_skills WHERE id = ?1",
                params![skill.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("org skill watermark: {err}"))?;
        if local_updated_at.is_some_and(|local| local >= skill.updated_at) {
            continue;
        }
        if crate::sync::collab_bridge::has_pending_collab_field_path(
            connection,
            org_id,
            &format!("orgSkills.{}", skill.id),
            "org skill pending-path probe",
        )? {
            continue;
        }
        let files_json = serde_json::to_string(&skill.files)
            .map_err(|err| format!("org skill wire files: {err}"))?;
        let provenance_json = skill
            .provenance
            .as_ref()
            .map(|value| {
                serde_json::to_string(value).map_err(|err| format!("org skill wire: {err}"))
            })
            .transpose()?;
        let applied = connection
            .execute(
                "INSERT INTO pm_org_skills (
                     id, org_id, name, description, skill_md, files_json,
                     provenance_json, shared_by, archived_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     description = excluded.description,
                     skill_md = excluded.skill_md,
                     files_json = excluded.files_json,
                     provenance_json = excluded.provenance_json,
                     shared_by = excluded.shared_by,
                     archived_at = excluded.archived_at,
                     updated_at = excluded.updated_at
                 WHERE pm_org_skills.org_id = excluded.org_id
                   AND excluded.updated_at >= pm_org_skills.updated_at",
                params![
                    skill.id,
                    skill.org_id,
                    skill.name,
                    skill.description,
                    skill.skill_md,
                    files_json,
                    provenance_json,
                    skill.shared_by,
                    skill.archived_at,
                    skill.created_at,
                    skill.updated_at,
                ],
            )
            .map_err(|err| format!("org skill apply: {err}"))?;
        if applied == 0 {
            guard_skill_id_org(connection, &skill.id, org_id)?;
            continue;
        }
        changed = true;
    }
    if changed {
        materialize_org(connection, org_id)?;
    }
    Ok(())
}

/// Write every active shared skill for one org under
/// `~/.orgii/org-skills/<org>/`, and remove directories whose row is
/// archived or gone. Content writes are compared first so repeated
/// materializations are cheap and never bump mtimes needlessly.
pub(crate) fn materialize_org(connection: &Connection, org_id: &str) -> Result<(), String> {
    let skills = export_skills(connection, org_id)?;
    let org_root = app_paths::org_skills_root();
    ensure_directory_without_symlink(&org_root)?;
    let org_dir = validated_org_dir(org_id)?;
    ensure_directory_without_symlink(&org_dir)?;
    let mut active_names = std::collections::HashSet::new();
    for skill in skills.iter().filter(|skill| skill.archived_at.is_none()) {
        let name = validate_skill_snapshot(&skill.name, &skill.skill_md, &skill.files)?;
        active_names.insert(name.clone());
        let skill_dir = org_dir.join(&name);
        ensure_directory_without_symlink(&skill_dir)?;
        let mut desired_files =
            std::collections::HashSet::from([std::path::PathBuf::from("SKILL.md")]);
        desired_files.extend(
            skill
                .files
                .iter()
                .map(|file| std::path::PathBuf::from(&file.relative_path)),
        );
        if skill.provenance.is_some() {
            desired_files.insert(std::path::PathBuf::from(".orgii-skill-origin.json"));
        }
        reconcile_skill_directory(&skill_dir, &desired_files)?;
        write_if_changed(&skill_dir.join("SKILL.md"), &skill.skill_md)?;
        for file in &skill.files {
            let path = skill_dir.join(&file.relative_path);
            if let Some(parent) = path.parent() {
                ensure_relative_directories_without_symlink(&skill_dir, parent)?;
            }
            write_if_changed(&path, &file.content)?;
        }
        if let Some(provenance) = &skill.provenance {
            let raw = serde_json::to_string_pretty(provenance)
                .map_err(|err| format!("org skill materialize: {err}"))?;
            write_if_changed(&skill_dir.join(".orgii-skill-origin.json"), &raw)?;
        }
    }
    if org_dir.exists() {
        let entries =
            std::fs::read_dir(&org_dir).map_err(|err| format!("org skill materialize: {err}"))?;
        for entry in entries {
            let entry = entry.map_err(|err| format!("org skill materialize: {err}"))?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !active_names.contains(name) {
                let file_type = entry
                    .file_type()
                    .map_err(|err| format!("org skill materialize: {err}"))?;
                if file_type.is_symlink() || file_type.is_file() {
                    std::fs::remove_file(&path)
                        .map_err(|err| format!("org skill materialize: {err}"))?;
                } else if file_type.is_dir() {
                    std::fs::remove_dir_all(&path)
                        .map_err(|err| format!("org skill materialize: {err}"))?;
                }
            }
        }
    }
    Ok(())
}

/// Remove materialized files that are no longer present in the authoritative
/// snapshot before writing the new snapshot.  Expected path components are
/// checked by the normal write path; a symlink at an expected path is an
/// error, while an unexpected symlink is unlinked without following it.
fn reconcile_skill_directory(
    skill_dir: &std::path::Path,
    desired_files: &std::collections::HashSet<std::path::PathBuf>,
) -> Result<(), String> {
    let mut desired_directories = std::collections::HashSet::new();
    for file in desired_files {
        let mut parent = file.parent();
        while let Some(directory) = parent.filter(|path| !path.as_os_str().is_empty()) {
            desired_directories.insert(directory.to_path_buf());
            parent = directory.parent();
        }
    }

    fn visit(
        root: &std::path::Path,
        directory: &std::path::Path,
        desired_files: &std::collections::HashSet<std::path::PathBuf>,
        desired_directories: &std::collections::HashSet<std::path::PathBuf>,
    ) -> Result<(), String> {
        for entry in
            std::fs::read_dir(directory).map_err(|err| format!("org skill materialize: {err}"))?
        {
            let entry = entry.map_err(|err| format!("org skill materialize: {err}"))?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| format!("PM_ERR:ORG_SKILL_PATH_ESCAPE:{}", path.display()))?
                .to_path_buf();
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|err| format!("org skill materialize: {err}"))?;
            let expected_file = desired_files.contains(&relative);
            let expected_directory = desired_directories.contains(&relative);

            if metadata.file_type().is_symlink() {
                if expected_file || expected_directory {
                    return Err(format!("PM_ERR:ORG_SKILL_SYMLINK:{}", path.display()));
                }
                std::fs::remove_file(&path)
                    .map_err(|err| format!("org skill materialize: {err}"))?;
            } else if metadata.is_file() {
                if !expected_file {
                    std::fs::remove_file(&path)
                        .map_err(|err| format!("org skill materialize: {err}"))?;
                }
            } else if metadata.is_dir() {
                if expected_directory {
                    visit(root, &path, desired_files, desired_directories)?;
                } else {
                    std::fs::remove_dir_all(&path)
                        .map_err(|err| format!("org skill materialize: {err}"))?;
                }
            } else {
                return Err(format!(
                    "PM_ERR:ORG_SKILL_PATH_UNSUPPORTED:{}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    visit(skill_dir, skill_dir, desired_files, &desired_directories)
}

fn ensure_directory_without_symlink(path: &std::path::Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("PM_ERR:ORG_SKILL_SYMLINK:{}", path.display()))
        }
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(format!(
            "PM_ERR:ORG_SKILL_PATH_NOT_DIRECTORY:{}",
            path.display()
        )),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path).map_err(|err| format!("org skill materialize: {err}"))?;
            let metadata = std::fs::symlink_metadata(path)
                .map_err(|err| format!("org skill materialize: {err}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "PM_ERR:ORG_SKILL_PATH_NOT_DIRECTORY:{}",
                    path.display()
                ));
            }
            Ok(())
        }
        Err(err) => Err(format!("org skill materialize: {err}")),
    }
}

fn ensure_relative_directories_without_symlink(
    root: &std::path::Path,
    parent: &std::path::Path,
) -> Result<(), String> {
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| format!("PM_ERR:ORG_SKILL_PATH_ESCAPE:{}", parent.display()))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(format!("PM_ERR:ORG_SKILL_PATH_ESCAPE:{}", parent.display()));
        };
        current.push(component);
        ensure_directory_without_symlink(&current)?;
    }
    Ok(())
}

fn write_if_changed(path: &std::path::Path, content: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!("PM_ERR:ORG_SKILL_SYMLINK:{}", path.display()));
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(format!("PM_ERR:ORG_SKILL_PATH_NOT_FILE:{}", path.display()));
        }
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("org skill materialize: {err}")),
    }
    if std::fs::read_to_string(path)
        .map(|existing| existing == content)
        .unwrap_or(false)
    {
        return Ok(());
    }
    std::fs::write(path, content).map_err(|err| format!("org skill materialize: {err}"))
}

/// Startup sweep: bring every org's materialization in line with the
/// database, so a fresh checkout sees shared skills before any sync tick.
pub fn materialize_all() -> Result<(), String> {
    let connection = conn()?;
    let mut statement = connection
        .prepare("SELECT DISTINCT org_id FROM pm_org_skills")
        .map_err(|err| format!("org skill store: {err}"))?;
    let orgs = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("org skill store: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("org skill store: {err}"))?;
    drop(statement);
    for org_id in orgs {
        materialize_org(&connection, &org_id)?;
    }
    Ok(())
}

pub mod commands {
    use super::{OrgSkill, ShareOrgSkillRequest};

    #[tauri::command]
    pub async fn project_list_org_skills(org_id: String) -> Result<Vec<OrgSkill>, String> {
        tokio::task::spawn_blocking(move || super::list(&org_id))
            .await
            .map_err(|err| format!("Task join error: {err}"))?
    }

    #[tauri::command]
    pub async fn project_share_org_skill(
        app: tauri::AppHandle,
        request: ShareOrgSkillRequest,
    ) -> Result<OrgSkill, String> {
        let result = tokio::task::spawn_blocking(move || super::share(request))
            .await
            .map_err(|err| format!("Task join error: {err}"))?;
        if result.is_ok() {
            use tauri::Emitter;
            let _ = app.emit(
                crate::projects::events::DATA_CHANGED_EVENT,
                chrono::Utc::now().to_rfc3339(),
            );
        }
        result
    }

    #[tauri::command]
    pub async fn project_unshare_org_skill(
        app: tauri::AppHandle,
        org_id: String,
        id: String,
    ) -> Result<OrgSkill, String> {
        let result = tokio::task::spawn_blocking(move || super::unshare(&org_id, &id))
            .await
            .map_err(|err| format!("Task join error: {err}"))?;
        if result.is_ok() {
            use tauri::Emitter;
            let _ = app.emit(
                crate::projects::events::DATA_CHANGED_EVENT,
                chrono::Utc::now().to_rfc3339(),
            );
        }
        result
    }
}

#[cfg(test)]
mod tests;
