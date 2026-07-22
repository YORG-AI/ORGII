//! Project org CRUD against the `project_orgs` table.

use std::path::Path;

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::helpers::{conn, map_db, now_ms, to_iso8601};
use crate::projects::types::{
    ConfigureProjectOrgGitFolderSyncRequest, CreateProjectOrgRequest, ProjectOrg, PERSONAL_ORG_ID,
};

const LOCAL_ORG_SOURCE: &str = "local";
const NO_SYNC_PROVIDER: &str = "none";
const GIT_FOLDER_SYNC_PROVIDER: &str = "git_folder";
const DEFAULT_ORG_KEY_PREFIX: &str = "ORG";
const DEFAULT_ORG_ID_PREFIX: &str = "org";

pub fn read_project_orgs() -> Result<Vec<ProjectOrg>, String> {
    let connection = conn()?;
    let mut stmt = map_db(connection.prepare(
        "SELECT id, name, slug, org_key, source, sync_provider, sync_config_json,
                sync_connection_id, external_org_id, created_at, updated_at
         FROM project_orgs
         ORDER BY updated_at DESC, created_at DESC, name ASC",
    ))?;
    let rows = map_db(stmt.query_map([], row_to_project_org))?;
    let mut orgs = Vec::new();
    for entry in rows {
        orgs.push(map_db(entry)?);
    }
    Ok(orgs)
}

pub fn read_project_org(org_id: &str) -> Result<ProjectOrg, String> {
    let connection = conn()?;
    map_db(
        connection
            .query_row(
                "SELECT id, name, slug, org_key, source, sync_provider, sync_config_json,
                        sync_connection_id, external_org_id, created_at, updated_at
                 FROM project_orgs
                 WHERE id = ?1",
                params![org_id],
                row_to_project_org,
            )
            .optional(),
    )?
    .ok_or_else(|| format!("org not found: {}", org_id))
}

pub fn create_project_org(request: &CreateProjectOrgRequest) -> Result<ProjectOrg, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("Org name is required".to_string());
    }

    let slug = normalize_slug(name);
    if slug.is_empty() {
        return Err("Org name must include at least one alphanumeric character".to_string());
    }

    let org_id = request
        .id
        .as_ref()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{}-{}", DEFAULT_ORG_ID_PREFIX, slug));

    let connection = conn()?;
    let id_exists: bool = map_db(
        connection
            .query_row(
                "SELECT 1 FROM project_orgs WHERE id = ?1",
                params![&org_id],
                |_| Ok(true),
            )
            .optional(),
    )?
    .unwrap_or(false);
    if id_exists {
        return Err(format!("An org named '{}' already exists", name));
    }
    let (slug, org_key) = free_slug_and_key(&connection, &slug)?;

    let now = now_ms();
    let org = ProjectOrg {
        id: org_id,
        name: name.to_string(),
        slug: slug.clone(),
        org_key,
        source: LOCAL_ORG_SOURCE.to_string(),
        sync_provider: NO_SYNC_PROVIDER.to_string(),
        sync_config_json: None,
        sync_connection_id: None,
        external_org_id: None,
        created_at: to_iso8601(now),
        updated_at: to_iso8601(now),
    };

    map_db(connection.execute(
        "INSERT INTO project_orgs (
            id, name, slug, org_key, source, sync_provider, sync_config_json,
            sync_connection_id, external_org_id, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            org.id,
            org.name,
            org.slug,
            org.org_key,
            org.source,
            org.sync_provider,
            org.sync_config_json,
            org.sync_connection_id,
            org.external_org_id,
            now,
            now,
        ],
    ))?;

    Ok(org)
}

/// Delete a local project org and all data owned by it.
///
/// The personal org is a permanent schema root. Collab-backed rows are also
/// rejected here because their lifecycle must go through the cloud leave/delete
/// flow so remote membership and tombstones stay authoritative.
pub fn delete_project_org(org_id: &str) -> Result<(), String> {
    let org_id = org_id.trim();
    if org_id.is_empty() {
        return Err("Org ID is required".to_string());
    }
    if org_id == PERSONAL_ORG_ID {
        return Err("The default personal org cannot be deleted".to_string());
    }

    let mut connection = conn()?;
    let tx = map_db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let org: Option<(String, String, Option<String>)> = map_db(
        tx.query_row(
            "SELECT source, sync_provider, external_org_id
               FROM project_orgs
              WHERE id = ?1",
            params![org_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional(),
    )?;
    let Some((source, sync_provider, external_org_id)) = org else {
        return Err(format!("org not found: {}", org_id));
    };
    if source != LOCAL_ORG_SOURCE
        || sync_provider == crate::sync::collab_bridge::COLLAB_SYNC_PROVIDER
        || external_org_id.is_some()
    {
        return Err(
            "Cloud-backed orgs must be managed through cloud organization settings".to_string(),
        );
    }

    // Adapter tables have no foreign keys to `projects`; clean them before the
    // project rows disappear. The outbox predicate also removes standalone
    // collab-shaped rows that were explicitly tagged with this org.
    for table in ["webhook_secrets", "import_progress", "outbox_conflicts"] {
        map_db(tx.execute(
            &format!(
                "DELETE FROM {table}
                  WHERE project_slug IN (SELECT slug FROM projects WHERE org_id = ?1)"
            ),
            params![org_id],
        ))?;
    }
    map_db(tx.execute(
        "DELETE FROM outbox_entries
          WHERE org_id = ?1
             OR project_slug IN (SELECT slug FROM projects WHERE org_id = ?1)",
        params![org_id],
    ))?;
    map_db(tx.execute("DELETE FROM workitems WHERE org_id = ?1", params![org_id]))?;
    map_db(tx.execute("DELETE FROM projects WHERE org_id = ?1", params![org_id]))?;
    map_db(tx.execute("DELETE FROM project_orgs WHERE id = ?1", params![org_id]))?;
    map_db(tx.commit())
}

#[derive(Debug, Serialize)]
struct GitFolderSyncConfig<'a> {
    folder_path: &'a str,
}

pub fn configure_project_org_git_folder_sync(
    request: &ConfigureProjectOrgGitFolderSyncRequest,
) -> Result<ProjectOrg, String> {
    let org_id = request.org_id.trim();
    if org_id.is_empty() {
        return Err("Org ID is required".to_string());
    }

    let folder_path = request.folder_path.trim();
    if folder_path.is_empty() {
        return Err("Git folder path is required".to_string());
    }

    let path = Path::new(folder_path);
    if !path.is_dir() {
        return Err(format!("Git folder does not exist: {}", folder_path));
    }

    let git_metadata_path = path.join(".git");
    if !git_metadata_path.is_dir() && !git_metadata_path.is_file() {
        return Err(format!("Folder is not a Git working tree: {}", folder_path));
    }

    let sync_config_json = serde_json::to_string(&GitFolderSyncConfig { folder_path })
        .map_err(|err| format!("Failed to encode Git folder sync config: {}", err))?;
    let now = now_ms();
    let connection = conn()?;
    let updated = map_db(connection.execute(
        "UPDATE project_orgs
            SET sync_provider = ?1,
                sync_config_json = ?2,
                sync_connection_id = NULL,
                external_org_id = NULL,
                updated_at = ?3
          WHERE id = ?4",
        params![GIT_FOLDER_SYNC_PROVIDER, sync_config_json, now, org_id],
    ))?;
    if updated == 0 {
        return Err(format!("org not found: {}", org_id));
    }

    read_project_org(org_id)
}

/// Mark a project org as backed by the orgii collab plane (design
/// §16.2): `source='collab'`, `sync_provider='orgii_collab'`. Mirrors
/// [`configure_project_org_git_folder_sync`]; the two providers are
/// mutually exclusive per org. `external_org_id` records the collab org
/// id when the aliased local org uses a different id.
pub fn configure_project_org_collab_sync(
    org_id: &str,
    external_org_id: Option<&str>,
) -> Result<ProjectOrg, String> {
    let org_id = org_id.trim();
    if org_id.is_empty() {
        return Err("Org ID is required".to_string());
    }
    let now = now_ms();
    let connection = conn()?;
    let updated = map_db(connection.execute(
        "UPDATE project_orgs
            SET source = ?1,
                sync_provider = ?2,
                sync_config_json = NULL,
                sync_connection_id = NULL,
                external_org_id = ?3,
                updated_at = ?4
          WHERE id = ?5",
        params![
            crate::sync::collab_bridge::COLLAB_ORG_SOURCE,
            crate::sync::collab_bridge::COLLAB_SYNC_PROVIDER,
            external_org_id,
            now,
            org_id,
        ],
    ))?;
    if updated == 0 {
        return Err(format!("org not found: {}", org_id));
    }

    read_project_org(org_id)
}

fn row_to_project_org(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectOrg> {
    let created_at_ms: i64 = row.get(9)?;
    let updated_at_ms: i64 = row.get(10)?;
    Ok(ProjectOrg {
        id: row.get(0)?,
        name: row.get(1)?,
        slug: row.get(2)?,
        org_key: row.get(3)?,
        source: row.get(4)?,
        sync_provider: row.get(5)?,
        sync_config_json: row.get(6)?,
        sync_connection_id: row.get(7)?,
        external_org_id: row.get(8)?,
        created_at: to_iso8601(created_at_ms),
        updated_at: to_iso8601(updated_at_ms),
    })
}

fn normalize_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_separator = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            last_was_separator = false;
        } else if !last_was_separator && !slug.is_empty() {
            slug.push('-');
            last_was_separator = true;
        }
    }
    slug.trim_matches('-').to_string()
}

fn free_slug_and_key(
    connection: &rusqlite::Connection,
    base_slug: &str,
) -> Result<(String, String), String> {
    for attempt in 0..100u32 {
        let slug = if attempt == 0 {
            base_slug.to_string()
        } else {
            format!("{}-{}", base_slug, attempt + 1)
        };
        let org_key = if attempt == 0 {
            org_key_from_slug(&slug)
        } else {
            let base_key = org_key_from_slug(base_slug);
            let suffix = (attempt + 1).to_string();
            let keep = 8usize.saturating_sub(suffix.len()).min(base_key.len());
            format!("{}{}", &base_key[..keep], suffix)
        };
        let taken: bool = map_db(
            connection
                .query_row(
                    "SELECT 1 FROM project_orgs WHERE slug = ?1 OR org_key = ?2",
                    params![&slug, &org_key],
                    |_| Ok(true),
                )
                .optional(),
        )?
        .unwrap_or(false);
        if !taken {
            return Ok((slug, org_key));
        }
    }
    Err(format!(
        "Could not derive a unique slug for org '{}'",
        base_slug
    ))
}

fn org_key_from_slug(slug: &str) -> String {
    let mut key = String::new();
    for character in slug.chars() {
        if character.is_ascii_alphanumeric() {
            key.push(character.to_ascii_uppercase());
            if key.len() == 8 {
                break;
            }
        }
    }
    if key.is_empty() {
        DEFAULT_ORG_KEY_PREFIX.to_string()
    } else {
        key
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use test_helpers::test_env;

    #[test]
    fn read_project_orgs_includes_default_personal_org() {
        let _sandbox = test_env::sandbox();
        let orgs = read_project_orgs().expect("read orgs");
        assert!(orgs.iter().any(|org| org.id == "personal-org"));
    }

    #[test]
    fn create_project_org_round_trips() {
        let _sandbox = test_env::sandbox();
        let org = create_project_org(&CreateProjectOrgRequest {
            name: "Platform Team".to_string(),
            id: None,
        })
        .expect("create org");

        assert_eq!(org.id, "org-platform-team");
        assert_eq!(org.source, LOCAL_ORG_SOURCE);

        let orgs = read_project_orgs().expect("read orgs");
        assert!(orgs.iter().any(|entry| entry.id == org.id));
    }

    #[test]
    fn create_project_org_uniquifies_colliding_slug_and_key() {
        let _sandbox = test_env::sandbox();
        let first = create_project_org(&CreateProjectOrgRequest {
            name: "vinceorz418's workspace".to_string(),
            id: Some("cloud-org-a".to_string()),
        })
        .expect("create first org");
        let second = create_project_org(&CreateProjectOrgRequest {
            name: "vinceorz's workspace".to_string(),
            id: Some("cloud-org-b".to_string()),
        })
        .expect("create second org despite key collision");

        assert_ne!(first.slug, second.slug);
        assert_ne!(first.org_key, second.org_key);
        assert_eq!(second.org_key.len(), 8);
    }

    #[test]
    fn create_project_org_accepts_explicit_canonical_id() {
        let _sandbox = test_env::sandbox();
        let org = create_project_org(&CreateProjectOrgRequest {
            name: "Supabase Team".to_string(),
            id: Some("org-supabase-canonical".to_string()),
        })
        .expect("create org");

        assert_eq!(org.id, "org-supabase-canonical");

        let read_back = read_project_org(&org.id).expect("read org");
        assert_eq!(read_back.name, "Supabase Team");
    }

    #[test]
    fn delete_project_org_rejects_default_personal_org() {
        let _sandbox = test_env::sandbox();

        let error = delete_project_org(PERSONAL_ORG_ID).expect_err("personal org is protected");

        assert!(error.contains("cannot be deleted"));
        assert!(read_project_org(PERSONAL_ORG_ID).is_ok());
    }

    #[test]
    fn delete_project_org_rejects_collab_backed_alias() {
        let _sandbox = test_env::sandbox();
        let org = create_project_org(&CreateProjectOrgRequest {
            name: "Cloud Alias".to_string(),
            id: None,
        })
        .expect("create org");
        configure_project_org_collab_sync(&org.id, Some("cloud-org-id"))
            .expect("configure collab org");

        let error = delete_project_org(&org.id).expect_err("collab org is protected");

        assert!(error.contains("cloud organization settings"));
        assert!(read_project_org(&org.id).is_ok());
    }

    #[test]
    fn delete_project_org_removes_owned_rows_and_sync_metadata() {
        let _sandbox = test_env::sandbox();
        let org = create_project_org(&CreateProjectOrgRequest {
            name: "Disposable Team".to_string(),
            id: None,
        })
        .expect("create org");
        let connection = conn().expect("open project database");
        let now = now_ms();
        connection
            .execute(
                "INSERT INTO projects (
                    id, org_id, name, slug, short_id_prefix, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params!["project-1", &org.id, "Project", "project", "PRJ", now, now],
            )
            .expect("insert project");
        connection
            .execute(
                "INSERT INTO workitems (
                    id, org_id, project_id, short_id, title, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    "work-item-1",
                    &org.id,
                    "project-1",
                    "PRJ-1",
                    "Work item",
                    now,
                    now
                ],
            )
            .expect("insert work item");
        connection
            .execute(
                "INSERT INTO outbox_entries (
                    project_slug, entity_type, entity_id, op, payload_json, created_at, org_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    "project",
                    "project",
                    "project-1",
                    "update",
                    "{}",
                    now,
                    &org.id
                ],
            )
            .expect("insert outbox row");
        drop(connection);

        delete_project_org(&org.id).expect("delete local org");

        let connection = conn().expect("reopen project database");
        for (table, predicate) in [
            ("project_orgs", "id"),
            ("projects", "org_id"),
            ("workitems", "org_id"),
            ("outbox_entries", "org_id"),
        ] {
            let count: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE {predicate} = ?1"),
                    params![&org.id],
                    |row| row.get(0),
                )
                .expect("count remaining rows");
            assert_eq!(count, 0, "{table} rows should be deleted");
        }
    }

    #[test]
    fn configure_project_org_git_folder_sync_round_trips() {
        let sandbox = test_env::sandbox();
        let org = create_project_org(&CreateProjectOrgRequest {
            name: "Platform Team".to_string(),
            id: None,
        })
        .expect("create org");
        let repo_path = sandbox.path().join("repo");
        fs::create_dir_all(repo_path.join(".git")).expect("create git folder");

        let configured =
            configure_project_org_git_folder_sync(&ConfigureProjectOrgGitFolderSyncRequest {
                org_id: org.id.clone(),
                folder_path: repo_path.to_string_lossy().to_string(),
            })
            .expect("configure git folder sync");

        assert_eq!(configured.id, org.id);
        assert_eq!(configured.sync_provider, GIT_FOLDER_SYNC_PROVIDER);
        let config: serde_json::Value = serde_json::from_str(
            configured
                .sync_config_json
                .as_deref()
                .expect("sync config json"),
        )
        .expect("parse config");
        assert_eq!(config["folder_path"], repo_path.to_string_lossy().as_ref());
    }
}
