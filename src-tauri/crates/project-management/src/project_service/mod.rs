//! Project application service: the single boundary for Project
//! creation and mutation. Slug allocation, org validation, audit and
//! the `pm_change_seq` watermark live here — callers (CLI, agent
//! tools, Tauri) describe the project; the service owns row
//! construction.

use crate::projects::io as project_io;
use crate::projects::types::{ProjectData, ProjectMeta};
use crate::work_service;

pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if (ch == ' ' || ch == '-' || ch == '_') && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_matches('-').to_string()
}

fn derive_prefix(name: &str) -> String {
    let letters: String = name
        .chars()
        .filter(|ch| ch.is_ascii_alphabetic())
        .take(3)
        .collect::<String>()
        .to_ascii_uppercase();
    if letters.len() >= 2 {
        letters
    } else {
        "PRJ".to_string()
    }
}

fn audit_project(operation: &'static str, slug: &str, org_id: Option<&str>) -> Result<(), String> {
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction()
        .map_err(|err| format!("project audit tx: {err}"))?;
    let seq = work_service::audit::bump_change_seq(&tx)?;
    work_service::audit::append_audit_event(
        &tx,
        &work_service::audit::AuditEventRow {
            operation,
            entity_type: "project",
            entity_id: slug,
            project_slug: Some(slug),
            org_id,
            actor: None,
            revision: 0,
            seq,
            payload: serde_json::json!({}),
        },
    )?;
    tx.commit()
        .map_err(|err| format!("project audit commit: {err}"))
}

pub struct CreateProjectRequest {
    pub name: String,
    pub description: String,
    pub org_id: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub lead: Option<String>,
    pub labels: Vec<String>,
}

pub fn create_project(request: &CreateProjectRequest) -> Result<ProjectData, String> {
    let slug = slugify(&request.name);
    if slug.is_empty() {
        return Err("Cannot create project: name produces empty slug".to_string());
    }
    if project_io::read_project(&slug).is_ok() {
        return Err(work_service::error::already_exists(&slug));
    }
    let org_id = match request.org_id.as_deref() {
        Some(requested) if requested != "personal-org" => {
            let orgs = project_io::read_project_orgs()?;
            if !orgs.iter().any(|org| org.id == requested) {
                return Err(format!("Unknown org_id '{requested}'"));
            }
            requested.to_string()
        }
        _ => "personal-org".to_string(),
    };
    let now = chrono::Utc::now().to_rfc3339();
    let meta = ProjectMeta {
        id: format!("proj-{slug}"),
        name: request.name.clone(),
        org_id: org_id.clone(),
        status: request
            .status
            .clone()
            .unwrap_or_else(|| "backlog".to_string()),
        priority: request
            .priority
            .clone()
            .unwrap_or_else(|| "none".to_string()),
        health: "no_updates".to_string(),
        lead: request.lead.clone(),
        members: vec![],
        labels: request.labels.clone(),
        linked_repos: vec![],
        start_date: None,
        target_date: None,
        created_at: now.clone(),
        updated_at: now,
        next_work_item_id: 1,
        work_item_prefix: derive_prefix(&request.name),
        work_item_prefix_custom: false,
        agent_defaults: None,
    };
    project_io::write_project(&slug, &meta, &request.description, true)?;
    audit_project("project.create", &slug, Some(&org_id))?;
    project_io::read_project(&slug)
}

pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub lead: Option<String>,
}

pub fn update_project(slug: &str, request: &UpdateProjectRequest) -> Result<ProjectData, String> {
    let existing = project_io::read_project(slug)?;
    let mut meta = existing.meta.clone();
    if let Some(name) = &request.name {
        meta.name = name.clone();
    }
    if let Some(status) = &request.status {
        meta.status = status.clone();
    }
    if let Some(priority) = &request.priority {
        meta.priority = priority.clone();
    }
    if let Some(lead) = &request.lead {
        meta.lead = Some(lead.clone());
    }
    meta.updated_at = chrono::Utc::now().to_rfc3339();
    let readme = request
        .description
        .clone()
        .unwrap_or_else(|| existing.description.clone());
    let org_id = meta.org_id.clone();
    project_io::write_project(slug, &meta, &readme, false)?;
    audit_project("project.update", slug, Some(&org_id))?;
    project_io::read_project(slug)
}
