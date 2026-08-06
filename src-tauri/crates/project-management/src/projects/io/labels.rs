//! Per-project label catalog.
//!
//! Per-project label IO:
//! scoped by `project_id` instead of `repo_path`. Returns the same
//! `LabelsFile` shape the frontend already consumes.

use rusqlite::params;

use super::helpers::{conn, map_db, now_ms};
use crate::projects::types::{LabelEntry, LabelsFile};

/// Read every label for a project, ordered by name.
pub fn read_labels(project_id: &str) -> Result<LabelsFile, String> {
    let connection = conn()?;
    let mut stmt = map_db(connection.prepare(
        "SELECT id, name, color FROM labels WHERE project_id = ?1 ORDER BY name COLLATE NOCASE",
    ))?;
    let rows = map_db(stmt.query_map(params![project_id], |row| {
        Ok(LabelEntry {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        })
    }))?;
    let mut labels: Vec<LabelEntry> = Vec::new();
    for entry in rows {
        labels.push(map_db(entry)?);
    }
    Ok(LabelsFile { labels })
}

/// Replace all labels for a project (full-set semantics).
///
/// Mirrors the file-layer behavior: writing `LabelsFile` overwrote the
/// whole `labels.yaml`. We replicate that with DELETE + INSERT inside a
/// transaction so callers never see an inconsistent partial state.
pub fn write_labels(project_id: &str, labels: &LabelsFile) -> Result<(), String> {
    let mut connection = conn()?;
    let tx = map_db(connection.transaction())?;

    map_db(tx.execute(
        "DELETE FROM labels WHERE project_id = ?1",
        params![project_id],
    ))?;

    let timestamp = now_ms();
    for entry in &labels.labels {
        map_db(tx.execute(
            "INSERT INTO labels (id, project_id, name, color, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![entry.id, project_id, entry.name, entry.color, timestamp],
        ))?;
    }

    map_db(tx.commit())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::io::projects::write_project;
    use crate::projects::types::ProjectMeta;
    use test_helpers::test_env;

    fn fixture_project(meta_id: &str, name: &str) -> ProjectMeta {
        ProjectMeta {
            id: meta_id.to_string(),
            name: name.to_string(),
            org_id: "personal-org".to_string(),
            workspace_id: None,
            status: String::new(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
            lead: None,
            members: vec![],
            labels: vec![],
            linked_repos: vec![],
            start_date: None,
            target_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            next_work_item_id: 1,
            work_item_prefix: "AAA".to_string(),
            work_item_prefix_custom: false,
            agent_defaults: None,
        }
    }

    #[test]
    fn read_labels_for_unknown_project_is_empty() {
        let _sandbox = test_env::sandbox();
        let labels = read_labels("does-not-exist").expect("read");
        assert!(labels.labels.is_empty());
    }

    #[test]
    fn write_then_read_round_trips() {
        let _sandbox = test_env::sandbox();
        let meta = fixture_project("p1", "Project One");
        write_project("p1", &meta, "", true).expect("create project");

        let payload = LabelsFile {
            labels: vec![
                LabelEntry {
                    id: "l1".into(),
                    name: "bug".into(),
                    color: "#ff0000".into(),
                },
                LabelEntry {
                    id: "l2".into(),
                    name: "feature".into(),
                    color: "#00ff00".into(),
                },
            ],
        };
        write_labels("p1", &payload).expect("write");

        let read_back = read_labels("p1").expect("read");
        assert_eq!(read_back.labels.len(), 2);
        // Ordered by name COLLATE NOCASE → 'bug' before 'feature'.
        assert_eq!(read_back.labels[0].name, "bug");
        assert_eq!(read_back.labels[1].name, "feature");
    }

    #[test]
    fn write_labels_replaces_whole_set() {
        let _sandbox = test_env::sandbox();
        let meta = fixture_project("p1", "Project One");
        write_project("p1", &meta, "", true).expect("create project");

        let first = LabelsFile {
            labels: vec![LabelEntry {
                id: "l1".into(),
                name: "bug".into(),
                color: "#ff0000".into(),
            }],
        };
        write_labels("p1", &first).expect("first write");

        let second = LabelsFile {
            labels: vec![LabelEntry {
                id: "l2".into(),
                name: "feature".into(),
                color: "#00ff00".into(),
            }],
        };
        write_labels("p1", &second).expect("second write");

        let read_back = read_labels("p1").expect("read");
        assert_eq!(read_back.labels.len(), 1, "old label should be gone");
        assert_eq!(read_back.labels[0].id, "l2");
    }
}
