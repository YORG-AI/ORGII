//! Shared seeding helpers for sibling service test modules.

use crate::projects::io::write_project;
use crate::projects::types::ProjectMeta;

pub fn seed_project(slug: &str, id: &str) {
    let meta = ProjectMeta {
        id: id.to_string(),
        name: "Demo".to_string(),
        org_id: "personal-org".to_string(),
        status: "active".to_string(),
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
        work_item_prefix_custom: true,
        agent_defaults: None,
    };
    write_project(slug, &meta, "", true).expect("seed project");
}
