//! Project CRUD operations.

use project_management::projects::{io, types::ProjectMeta};

use super::helpers::{now_iso, run_blocking, slugify, truncate_preview};

/// List all projects.
///
/// Returns a formatted summary suitable for agent consumption.
pub async fn list_projects() -> Result<String, String> {
    run_blocking("list_projects", move || {
        let projects = io::read_all_projects()?;
        if projects.is_empty() {
            return Ok("No projects found.".to_string());
        }
        let mut output = format!("Found {} project(s):\n", projects.len());
        for project in &projects {
            let meta = &project.meta;
            output.push_str(&format!(
                "\n- **{}** (slug: `{}`, id: `{}`)\n  Status: {} | Priority: {} | Health: {}\n",
                meta.name, project.slug, meta.id, meta.status, meta.priority, meta.health,
            ));
            if let Some(ref lead) = meta.lead {
                output.push_str(&format!("  Lead: {}\n", lead));
            }
            if !meta.members.is_empty() {
                output.push_str(&format!("  Members: {}\n", meta.members.join(", ")));
            }
            if let Some(ref start_date) = meta.start_date {
                output.push_str(&format!("  Start: {} ", start_date));
            }
            if let Some(ref target_date) = meta.target_date {
                output.push_str(&format!("  Target: {}\n", target_date));
            }
            if !project.description.is_empty() {
                let desc = truncate_preview(&project.description, 120);
                output.push_str(&format!("  Description: {}\n", desc.trim()));
            }
        }
        Ok(output)
    })
    .await
}

/// Read a single project by slug.
pub async fn read_project(slug: &str) -> Result<String, String> {
    let slug = slug.to_string();
    run_blocking("read_project", move || {
        let project = io::read_project(&slug)?;
        let meta = &project.meta;
        let mut output = format!(
            "Project: {}\nID: {}\nSlug: {}\nStatus: {}\nPriority: {}\nHealth: {}\nCreated: {}\nUpdated: {}\n",
            meta.name, meta.id, project.slug,
            meta.status, meta.priority, meta.health,
            meta.created_at, meta.updated_at,
        );
        if let Some(ref lead) = meta.lead {
            output.push_str(&format!("Lead: {}\n", lead));
        }
        if !meta.members.is_empty() {
            output.push_str(&format!("Members: {}\n", meta.members.join(", ")));
        }
        if !meta.labels.is_empty() {
            output.push_str(&format!("Labels: {}\n", meta.labels.join(", ")));
        }
        if !meta.linked_repos.is_empty() {
            output.push_str(&format!("Linked Repos: {}\n", meta.linked_repos.join(", ")));
        }
        if let Some(ref start_date) = meta.start_date {
            output.push_str(&format!("Start Date: {}\n", start_date));
        }
        if let Some(ref target_date) = meta.target_date {
            output.push_str(&format!("Target Date: {}\n", target_date));
        }
        if !project.description.is_empty() {
            output.push_str(&format!("\nDescription:\n{}\n", project.description));
        }
        Ok(output)
    })
    .await
}

/// Create a new project. Generates slug from name.
/// Returns a success message with the created slug.
#[allow(clippy::too_many_arguments)]
pub async fn create_project(
    name: &str,
    description: &str,
    org_id: Option<&str>,
    status: Option<&str>,
    priority: Option<&str>,
    health: Option<&str>,
    lead: Option<&str>,
    members: Option<Vec<String>>,
    labels: Option<Vec<String>>,
    linked_repos: Option<Vec<String>>,
    start_date: Option<&str>,
    target_date: Option<&str>,
) -> Result<String, String> {
    let name = name.to_string();
    let org_id = org_id
        .filter(|value| !value.trim().is_empty())
        .map(String::from);
    let description = description.to_string();
    let status = status.unwrap_or("backlog").to_string();
    let priority = priority.unwrap_or("none").to_string();
    let health = health.unwrap_or("no_updates").to_string();
    let lead = lead.map(String::from);
    let members = members.unwrap_or_default();
    let labels = labels.unwrap_or_default();
    let linked_repos = linked_repos.unwrap_or_default();
    let start_date = start_date.map(String::from);
    let target_date = target_date.map(String::from);

    run_blocking("create_project", move || {
        let slug = slugify(&name);
        if slug.is_empty() {
            return Err("Cannot create project: name produces empty slug".to_string());
        }

        let org_id = match org_id {
            Some(requested) if requested != "personal-org" => {
                let orgs = io::read_project_orgs()?;
                if !orgs.iter().any(|org| org.id == requested) {
                    return Err(format!(
                        "Unknown org_id '{}'. Available orgs: {}",
                        requested,
                        orgs.iter()
                            .map(|org| format!("{} ({})", org.id, org.name))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                requested
            }
            _ => "personal-org".to_string(),
        };

        let now = now_iso();
        let meta = ProjectMeta {
            id: format!("project-{}", slug),
            name: name.clone(),
            org_id,
            status,
            priority,
            health,
            lead,
            members,
            labels,
            linked_repos,
            start_date,
            target_date,
            created_at: now.clone(),
            updated_at: now,
            next_work_item_id: 1,
            work_item_prefix: "STO".to_string(),
            work_item_prefix_custom: false,
            agent_defaults: None,
        };

        // expect_new=true rejects duplicate slugs at the DB layer.
        io::write_project(&slug, &meta, &description, true)?;

        Ok(format!(
            "Created project '{}' (slug: {}, id: {})",
            name, slug, meta.id
        ))
    })
    .await
}

/// Update an existing project.
///
/// Only the fields that are `Some` will be updated; others are left unchanged.
/// Pass an empty string for `lead` to clear it. Pass an empty vec for
/// `members`/`labels`/`linked_repos` to clear them.
#[allow(clippy::too_many_arguments)]
pub async fn update_project(
    slug: &str,
    name: Option<&str>,
    description: Option<&str>,
    status: Option<&str>,
    priority: Option<&str>,
    health: Option<&str>,
    lead: Option<&str>,
    members: Option<Vec<String>>,
    labels: Option<Vec<String>>,
    linked_repos: Option<Vec<String>>,
    start_date: Option<&str>,
    target_date: Option<&str>,
) -> Result<String, String> {
    let slug = slug.to_string();
    let name = name.map(String::from);
    let description = description.map(String::from);
    let status = status.map(String::from);
    let priority = priority.map(String::from);
    let health = health.map(String::from);
    let lead = lead.map(String::from);
    let start_date = start_date.map(String::from);
    let target_date = target_date.map(String::from);

    run_blocking("update_project", move || {
        let existing = io::read_project(&slug)?;
        let mut meta = existing.meta;
        let mut desc = existing.description;

        if let Some(new_name) = name {
            meta.name = new_name;
        }
        if let Some(new_desc) = description {
            desc = new_desc;
        }
        if let Some(new_status) = status {
            meta.status = new_status;
        }
        if let Some(new_priority) = priority {
            meta.priority = new_priority;
        }
        if let Some(new_health) = health {
            meta.health = new_health;
        }
        if let Some(new_lead) = lead {
            meta.lead = if new_lead.is_empty() {
                None
            } else {
                Some(new_lead)
            };
        }
        if let Some(new_members) = members {
            meta.members = new_members;
        }
        if let Some(new_labels) = labels {
            meta.labels = new_labels;
        }
        if let Some(new_linked_repos) = linked_repos {
            meta.linked_repos = new_linked_repos;
        }
        if let Some(new_start_date) = start_date {
            meta.start_date = if new_start_date.is_empty() {
                None
            } else {
                Some(new_start_date)
            };
        }
        if let Some(new_target_date) = target_date {
            meta.target_date = if new_target_date.is_empty() {
                None
            } else {
                Some(new_target_date)
            };
        }
        meta.updated_at = now_iso();

        io::write_project(&slug, &meta, &desc, false)?;

        Ok(format!("Updated project '{}' (slug: {})", meta.name, slug))
    })
    .await
}

/// Delete a project by slug.
pub async fn delete_project(slug: &str) -> Result<String, String> {
    let slug = slug.to_string();
    run_blocking("delete_project", move || {
        io::delete_project(&slug)?;
        Ok(serde_json::json!({
            "action": "delete",
            "resource": "project",
            "deleted": true,
            "project_slug": slug,
            "message": "Project deleted"
        })
        .to_string())
    })
    .await
}
