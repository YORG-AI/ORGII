//! Project CRUD against the `projects` table.
//!
//! Rows are keyed by project ID alone; repo/workspace linkage lives in
//! `linked_repos_json`. The `slug` parameter is the human-readable
//! identifier; we look up by slug since the schema enforces a unique
//! slug index. New rows get a fresh ULID-style ID via the caller
//! (`ProjectMeta.id`); we never mint IDs here so callers stay in charge
//! of identifier strategy.

use rusqlite::{params, OptionalExtension};

use super::helpers::{conn, from_iso8601, map_db, now_ms, to_iso8601};
use crate::projects::types::{AgentDefaults, ProjectData, ProjectMeta};

const WORK_ITEM_PREFIX_LENGTH: usize = 3;
const DEFAULT_WORK_ITEM_PREFIX: &str = "STR";

pub fn derive_work_item_prefix(project_name: &str) -> String {
    let mut prefix = String::new();
    for character in project_name.chars() {
        if character.is_ascii_alphanumeric() {
            prefix.push(character.to_ascii_uppercase());
            if prefix.len() == WORK_ITEM_PREFIX_LENGTH {
                break;
            }
        }
    }

    if prefix.is_empty() {
        return DEFAULT_WORK_ITEM_PREFIX.to_string();
    }

    while prefix.len() < WORK_ITEM_PREFIX_LENGTH {
        prefix.push('X');
    }
    prefix
}

pub fn normalize_custom_work_item_prefix(prefix: &str) -> Result<String, String> {
    let normalized = prefix.trim().to_ascii_uppercase();
    let is_valid_length = normalized.chars().count() == WORK_ITEM_PREFIX_LENGTH;
    let is_valid_chars = normalized
        .chars()
        .all(|character| character.is_ascii_alphanumeric());

    if !is_valid_length || !is_valid_chars {
        return Err(format!(
            "Work item prefix must be exactly {} alphanumeric characters",
            WORK_ITEM_PREFIX_LENGTH
        ));
    }

    Ok(normalized)
}

/// Read every project in the store, ordered by `updated_at` desc.
pub fn read_all_projects() -> Result<Vec<ProjectData>, String> {
    read_all_projects_scoped(None)
}

pub fn read_all_projects_scoped(org_id: Option<&str>) -> Result<Vec<ProjectData>, String> {
    let connection = conn()?;
    let mut out = Vec::new();

    if let Some(org_id) = org_id {
        let mut stmt = map_db(connection.prepare(
            "SELECT id, name, slug, org_id, workspace_id, status, priority, health, lead, description,
                    short_id_prefix, next_work_item_id, start_date, target_date,
                    linked_repos_json, agent_defaults_json, created_at, updated_at
             FROM projects
             WHERE org_id = ?1
             ORDER BY updated_at DESC, created_at DESC",
        ))?;
        let rows = map_db(stmt.query_map(params![org_id], row_to_project_data))?;
        for entry in rows {
            out.push(map_db(entry)?);
        }
        return Ok(out);
    }

    let mut stmt = map_db(connection.prepare(
        "SELECT id, name, slug, org_id, workspace_id, status, priority, health, lead, description,
                short_id_prefix, next_work_item_id, start_date, target_date,
                linked_repos_json, agent_defaults_json, created_at, updated_at
         FROM projects
         ORDER BY updated_at DESC, created_at DESC",
    ))?;
    let rows = map_db(stmt.query_map([], row_to_project_data))?;
    for entry in rows {
        out.push(map_db(entry)?);
    }
    Ok(out)
}

/// Read one project by slug.
pub fn read_project(slug: &str) -> Result<ProjectData, String> {
    read_project_scoped(slug, None)
}

pub fn read_project_scoped(slug: &str, org_id: Option<&str>) -> Result<ProjectData, String> {
    let connection = conn()?;
    let row = if let Some(org_id) = org_id {
        map_db(
            connection
                .query_row(
                    "SELECT id, name, slug, org_id, workspace_id, status, priority, health, lead, description,
                            short_id_prefix, next_work_item_id, start_date, target_date,
                            linked_repos_json, agent_defaults_json, created_at, updated_at
                     FROM projects WHERE slug = ?1 AND org_id = ?2",
                    params![slug, org_id],
                    row_to_project_data,
                )
                .optional(),
        )?
    } else {
        map_db(
            connection
                .query_row(
                    "SELECT id, name, slug, org_id, workspace_id, status, priority, health, lead, description,
                            short_id_prefix, next_work_item_id, start_date, target_date,
                            linked_repos_json, agent_defaults_json, created_at, updated_at
                     FROM projects WHERE slug = ?1",
                    params![slug],
                    row_to_project_data,
                )
                .optional(),
        )?
    };
    row.ok_or_else(|| format!("Project '{}' not found", slug))
}

/// Create or update a project.
///
/// Slug-uniqueness is enforced by a `UNIQUE INDEX` on the column. When
/// `expect_new` is true, an existing row with the same slug is rejected
/// before we touch anything; this preserves the legacy "duplicate slug"
/// error contract.
pub fn write_project(
    slug: &str,
    meta: &ProjectMeta,
    description: &str,
    expect_new: bool,
) -> Result<(), String> {
    let mut next_meta = meta.clone();
    if next_meta.work_item_prefix_custom {
        next_meta.work_item_prefix =
            normalize_custom_work_item_prefix(&next_meta.work_item_prefix)?;
    } else {
        next_meta.work_item_prefix = derive_work_item_prefix(&next_meta.name);
    }

    let connection = conn()?;

    if expect_new {
        let exists: bool = map_db(
            connection
                .query_row(
                    "SELECT 1 FROM projects WHERE slug = ?1",
                    params![slug],
                    |_| Ok(true),
                )
                .optional(),
        )?
        .unwrap_or(false);
        if exists {
            return Err(format!(
                "A project with slug '{}' already exists. Choose a different name.",
                slug
            ));
        }
    }

    let now = now_ms();
    let created_at = if next_meta.created_at.is_empty() {
        now
    } else {
        from_iso8601(&next_meta.created_at)
    };

    let linked_repos_json = serde_json::to_string(&next_meta.linked_repos)
        .map_err(|err| format!("serialize linked_repos: {}", err))?;
    let agent_defaults_json = next_meta
        .agent_defaults
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| format!("serialize agent_defaults: {}", err))?;

    map_db(connection.execute(
        "INSERT INTO projects (
            id, name, slug, org_id, workspace_id, status, priority, health, lead, description,
            short_id_prefix, next_work_item_id, start_date, target_date,
            linked_repos_json, agent_defaults_json, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
            ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18
         )
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            slug = excluded.slug,
            org_id = excluded.org_id,
            workspace_id = excluded.workspace_id,
            status = excluded.status,
            priority = excluded.priority,
            health = excluded.health,
            lead = excluded.lead,
            description = excluded.description,
            short_id_prefix = excluded.short_id_prefix,
            next_work_item_id = excluded.next_work_item_id,
            start_date = excluded.start_date,
            target_date = excluded.target_date,
            linked_repos_json = excluded.linked_repos_json,
            agent_defaults_json = excluded.agent_defaults_json,
            updated_at = excluded.updated_at",
        params![
            next_meta.id,
            next_meta.name,
            slug,
            next_meta.org_id,
            next_meta.workspace_id,
            next_meta.status,
            next_meta.priority,
            next_meta.health,
            next_meta.lead,
            description,
            next_meta.work_item_prefix,
            next_meta.next_work_item_id as i64,
            next_meta.start_date,
            next_meta.target_date,
            linked_repos_json,
            agent_defaults_json,
            created_at,
            now,
        ],
    ))?;

    Ok(())
}

/// Delete a project and everything that cascades from it: work items,
/// labels, milestones, and members.
pub fn delete_project(slug: &str) -> Result<(), String> {
    let connection = conn()?;
    let affected =
        map_db(connection.execute("DELETE FROM projects WHERE slug = ?1", params![slug]))?;

    if affected == 0 {
        return Err(format!("Project '{}' not found", slug));
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------

fn row_to_project_data(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectData> {
    let id: String = row.get(0)?;
    let name: String = row.get(1)?;
    let slug: String = row.get(2)?;
    let org_id: String = row.get(3)?;
    let workspace_id: Option<String> = row.get(4)?;
    let status: String = row.get(5)?;
    let priority: String = row.get(6)?;
    let health: String = row.get(7)?;
    let lead: Option<String> = row.get(8)?;
    let description: String = row.get::<_, Option<String>>(9)?.unwrap_or_default();
    let short_id_prefix: String = row.get(10)?;
    let next_work_item_id: i64 = row.get(11)?;
    let start_date: Option<String> = row.get(12)?;
    let target_date: Option<String> = row.get(13)?;
    let linked_repos_json: String = row.get(14)?;
    let agent_defaults_json: Option<String> = row.get(15)?;
    let created_at_ms: i64 = row.get(16)?;
    let updated_at_ms: i64 = row.get(17)?;

    // `linked_repos_json` is a DB-stored JSON array of repo paths. Silent
    // empty fallback would make a project's repo links disappear from the
    // UI without any signal — the user would re-add them and the corrupt
    // row would persist. Warn so DB corruption / schema drift is visible.
    let linked_repos: Vec<String> = match serde_json::from_str(&linked_repos_json) {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!(
                project_id = %id,
                error = %err,
                raw_len = linked_repos_json.len(),
                "projects::io: linked_repos JSON parse failed; rendering project with no linked repos"
            );
            Vec::new()
        }
    };
    // `agent_defaults_json` is a DB-stored JSON blob holding the
    // project's default agent / model / key-source. A silent
    // `None` on a corrupt row would make the project look like
    // "no defaults configured", and the user's UI would silently
    // revert to global defaults. Warn so the corruption surfaces.
    let agent_defaults: Option<AgentDefaults> = match agent_defaults_json.as_deref() {
        Some(raw) => match serde_json::from_str::<AgentDefaults>(raw) {
            Ok(v) => Some(v),
            Err(err) => {
                tracing::warn!(
                    project_id = %id,
                    error = %err,
                    raw_len = raw.len(),
                    "projects::io: agent_defaults JSON parse failed; reverting to project-level no-defaults"
                );
                None
            }
        },
        None => None,
    };

    let meta = ProjectMeta {
        id,
        name,
        org_id,
        workspace_id,
        status,
        priority,
        health,
        lead,
        members: vec![],
        labels: vec![],
        linked_repos,
        start_date,
        target_date,
        created_at: to_iso8601(created_at_ms),
        updated_at: to_iso8601(updated_at_ms),
        next_work_item_id: next_work_item_id.max(1) as u32,
        work_item_prefix: short_id_prefix,
        work_item_prefix_custom: false,
        agent_defaults,
    };

    Ok(ProjectData {
        meta,
        description,
        slug,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_helpers::test_env;

    fn fixture(meta_id: &str, name: &str, slug_hint: &str) -> (String, ProjectMeta) {
        let meta = ProjectMeta {
            id: meta_id.to_string(),
            name: name.to_string(),
            org_id: "personal-org".to_string(),
            workspace_id: None,
            status: "active".to_string(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
            lead: None,
            members: vec![],
            labels: vec![],
            linked_repos: vec!["github.com/example/repo".to_string()],
            start_date: None,
            target_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            next_work_item_id: 1,
            work_item_prefix: String::new(),
            work_item_prefix_custom: false,
            agent_defaults: None,
        };
        (slug_hint.to_string(), meta)
    }

    #[test]
    fn write_then_read_round_trips_core_fields() {
        let _sandbox = test_env::sandbox();
        let (slug, meta) = fixture("s1", "Project One", "project-one");
        write_project(&slug, &meta, "Hello world", true).expect("write");

        let back = read_project("project-one").expect("read");
        assert_eq!(back.meta.id, "s1");
        assert_eq!(back.meta.name, "Project One");
        assert_eq!(back.meta.workspace_id, None);
        assert_eq!(back.description, "Hello world");
        assert_eq!(back.meta.linked_repos, vec!["github.com/example/repo"]);
        // Auto-derived prefix from name "Project One" → "STO".
        assert_eq!(back.meta.work_item_prefix, "STO");
    }

    #[test]
    fn workspace_id_round_trips_without_repo_inference() {
        let _sandbox = test_env::sandbox();
        let (slug, mut meta) = fixture(
            "workspace-project",
            "Workspace Project",
            "workspace-project",
        );
        meta.workspace_id = Some("workspace-explicit".to_string());
        write_project(&slug, &meta, "", true).expect("write");

        let back = read_project(&slug).expect("read");
        assert_eq!(
            back.meta.workspace_id.as_deref(),
            Some("workspace-explicit")
        );
    }

    #[test]
    fn workspace_id_survives_unrelated_edits_and_can_be_explicitly_unlinked() {
        let _sandbox = test_env::sandbox();
        let (slug, mut meta) = fixture(
            "workspace-project",
            "Workspace Project",
            "workspace-project",
        );
        meta.workspace_id = Some("workspace-explicit".to_string());
        write_project(&slug, &meta, "", true).expect("create with workspace");

        let mut unrelated_edit = read_project(&slug)
            .expect("read before unrelated edit")
            .meta;
        unrelated_edit.priority = "high".to_string();
        write_project(&slug, &unrelated_edit, "", false).expect("save unrelated edit");

        let mut linked = read_project(&slug).expect("read preserved workspace").meta;
        assert_eq!(linked.workspace_id.as_deref(), Some("workspace-explicit"));
        assert_eq!(linked.priority, "high");

        linked.workspace_id = None;
        write_project(&slug, &linked, "", false).expect("explicit unlink");

        assert_eq!(
            read_project(&slug)
                .expect("read explicitly unlinked project")
                .meta
                .workspace_id,
            None
        );
    }

    #[test]
    fn read_unknown_project_returns_error() {
        let _sandbox = test_env::sandbox();
        let err = read_project("ghost").unwrap_err();
        assert!(err.contains("ghost"), "error should mention slug: {}", err);
    }

    #[test]
    fn read_all_orders_by_updated_at_desc() {
        let _sandbox = test_env::sandbox();

        let (s1, m1) = fixture("p1", "Alpha", "alpha");
        write_project(&s1, &m1, "", true).expect("p1");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let (s2, m2) = fixture("p2", "Beta", "beta");
        write_project(&s2, &m2, "", true).expect("p2");

        let projects = read_all_projects().expect("list");
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].meta.id, "p2", "newest first");
        assert_eq!(projects[1].meta.id, "p1");
    }

    #[test]
    fn read_all_returns_every_project_regardless_of_repo_links() {
        let _sandbox = test_env::sandbox();

        let (s1, mut m1) = fixture("p1", "Alpha", "alpha");
        m1.linked_repos = vec!["github.com/foo/repo-a".to_string()];
        write_project(&s1, &m1, "", true).expect("p1");

        let (s2, mut m2) = fixture("p2", "Beta", "beta");
        m2.linked_repos = vec!["github.com/foo/repo-b".to_string()];
        write_project(&s2, &m2, "", true).expect("p2");

        let (s3, mut m3) = fixture("p3", "Gamma", "gamma");
        m3.linked_repos = vec![];
        write_project(&s3, &m3, "", true).expect("p3");

        let all = read_all_projects().expect("all");
        let mut ids: Vec<String> = all.iter().map(|project| project.meta.id.clone()).collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["p1".to_string(), "p2".to_string(), "p3".to_string()]
        );
    }

    #[test]
    fn duplicate_slug_with_expect_new_errors() {
        let _sandbox = test_env::sandbox();
        let (s1, m1) = fixture("p1", "Alpha", "alpha");
        write_project(&s1, &m1, "", true).expect("first");

        let (_, m2) = fixture("p2", "Alpha2", "alpha");
        let err = write_project("alpha", &m2, "", true).unwrap_err();
        assert!(err.contains("already exists"), "msg: {}", err);
    }

    #[test]
    fn upsert_overwrites_when_id_matches() {
        let _sandbox = test_env::sandbox();
        let (slug, mut meta) = fixture("p1", "Alpha", "alpha");
        write_project(&slug, &meta, "", true).expect("first");

        meta.name = "Alpha Renamed".to_string();
        meta.priority = "high".to_string();
        write_project(&slug, &meta, "v2", false).expect("update");

        let back = read_project(&slug).expect("read");
        assert_eq!(back.meta.name, "Alpha Renamed");
        assert_eq!(back.meta.priority, "high");
        assert_eq!(back.description, "v2");
    }

    #[test]
    fn delete_cascades_to_labels_and_members() {
        use crate::projects::io::labels::{read_labels, write_labels};
        use crate::projects::io::members::{read_members, write_members};
        use crate::projects::types::{LabelEntry, LabelsFile, MemberEntry, MembersFile};

        let _sandbox = test_env::sandbox();
        let (slug, meta) = fixture("p1", "Alpha", "alpha");
        write_project(&slug, &meta, "", true).expect("project");
        write_labels(
            "p1",
            &LabelsFile {
                labels: vec![LabelEntry {
                    id: "l1".into(),
                    name: "bug".into(),
                    color: "#f00".into(),
                }],
            },
        )
        .expect("labels");
        write_members(
            "p1",
            &MembersFile {
                members: vec![MemberEntry {
                    id: "u1".into(),
                    name: "Alice".into(),
                    email: None,
                    avatar: None,
                    github_username: None,
                    last_commit_date: None,
                    active: true,
                }],
            },
        )
        .expect("members");

        delete_project(&slug).expect("delete");

        // FK cascade should have wiped both child tables.
        let labels_after = read_labels("p1").expect("read labels");
        let members_after = read_members("p1").expect("read members");
        assert!(labels_after.labels.is_empty());
        assert!(members_after.members.is_empty());
    }

    #[test]
    fn delete_project_errors_when_project_is_missing() {
        let _sandbox = test_env::sandbox();
        let error = delete_project("missing-project").unwrap_err();
        assert_eq!(error, "Project 'missing-project' not found");
    }

    #[test]
    fn derive_prefix_pads_short_names() {
        assert_eq!(derive_work_item_prefix("Hi"), "HIX");
        assert_eq!(derive_work_item_prefix("Project One"), "STO");
        assert_eq!(derive_work_item_prefix(""), DEFAULT_WORK_ITEM_PREFIX);
    }

    #[test]
    fn normalize_custom_prefix_validates() {
        assert_eq!(
            normalize_custom_work_item_prefix(" abc ").unwrap(),
            "ABC".to_string()
        );
        assert!(normalize_custom_work_item_prefix("AB").is_err());
        assert!(normalize_custom_work_item_prefix("ABCD").is_err());
        assert!(normalize_custom_work_item_prefix("AB!").is_err());
    }
}
