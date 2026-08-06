//! Per-project milestone catalog.
//!
//! Per-project milestone IO.
//! Note: the wire-side `MilestoneEntry` uses `due_date`, but the schema
//! column is named `target_date` for consistency with the work-item
//! columns. We translate at the boundary so callers see the legacy field.

use rusqlite::params;

use super::helpers::{conn, map_db, now_ms};
use crate::projects::types::{MilestoneEntry, MilestonesFile};

const DEFAULT_MILESTONE_STATUS: &str = "open";

pub fn read_milestones(project_id: &str) -> Result<MilestonesFile, String> {
    let connection = conn()?;
    let mut stmt = map_db(connection.prepare(
        "SELECT id, name, description, target_date, status
         FROM milestones
         WHERE project_id = ?1
         ORDER BY name COLLATE NOCASE",
    ))?;
    let rows = map_db(stmt.query_map(params![project_id], |row| {
        Ok(MilestoneEntry {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            due_date: row.get(3)?,
            status: row
                .get::<_, Option<String>>(4)?
                .unwrap_or_else(|| DEFAULT_MILESTONE_STATUS.to_string()),
        })
    }))?;
    let mut milestones: Vec<MilestoneEntry> = Vec::new();
    for entry in rows {
        milestones.push(map_db(entry)?);
    }
    Ok(MilestonesFile { milestones })
}

pub fn write_milestones(project_id: &str, milestones: &MilestonesFile) -> Result<(), String> {
    let mut connection = conn()?;
    let tx = map_db(connection.transaction())?;

    map_db(tx.execute(
        "DELETE FROM milestones WHERE project_id = ?1",
        params![project_id],
    ))?;

    let timestamp = now_ms();
    for entry in &milestones.milestones {
        map_db(tx.execute(
            "INSERT INTO milestones (id, project_id, name, description, target_date, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                entry.id,
                project_id,
                entry.name,
                entry.description,
                entry.due_date,
                entry.status,
                timestamp,
            ],
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
    fn read_milestones_for_unknown_project_is_empty() {
        let _sandbox = test_env::sandbox();
        let milestones = read_milestones("nope").expect("read");
        assert!(milestones.milestones.is_empty());
    }

    #[test]
    fn write_then_read_preserves_optional_fields() {
        let _sandbox = test_env::sandbox();
        let meta = fixture_project("p1", "P1");
        write_project("p1", &meta, "", true).expect("create");

        let payload = MilestonesFile {
            milestones: vec![
                MilestoneEntry {
                    id: "m1".into(),
                    name: "Beta".into(),
                    description: Some("Public beta".into()),
                    due_date: Some("2026-06-01".into()),
                    status: "open".into(),
                },
                MilestoneEntry {
                    id: "m2".into(),
                    name: "GA".into(),
                    description: None,
                    due_date: None,
                    status: "open".into(),
                },
            ],
        };
        write_milestones("p1", &payload).expect("write");

        let back = read_milestones("p1").expect("read");
        assert_eq!(back.milestones.len(), 2);
        assert_eq!(back.milestones[0].name, "Beta");
        assert_eq!(
            back.milestones[0].description.as_deref(),
            Some("Public beta")
        );
        assert_eq!(back.milestones[1].description, None);
        assert_eq!(back.milestones[1].due_date, None);
    }
}
