use std::collections::HashMap;

use project_management::projects::io as pio;

use super::{guarded, mutation_actor};
use crate::context::ExecutionContext;
use crate::envelope::{emit_error, emit_success, CliError, ErrorCode};

pub fn dispatch_project(
    context: &ExecutionContext,
    positionals: &[String],
    flags: &HashMap<String, String>,
) -> i32 {
    match positionals.first().map(String::as_str) {
        Some("list") => cmd_project_list(context, flags),
        Some("show") => cmd_project_show(positionals.get(1)),
        Some("find") => cmd_project_find(positionals.get(1)),
        Some("members") => cmd_project_members(positionals.get(1)),
        Some("create") => cmd_project_create(context, flags),
        Some("update") => cmd_project_update(context, positionals.get(1), flags),
        other => emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Unknown project subcommand '{}'; expected list|show|find|members|create|update",
                other.unwrap_or("<none>")
            ),
        )),
    }
}

fn project_to_wire(
    project: &project_management::projects::types::ProjectData,
) -> serde_json::Value {
    serde_json::json!({
        "slug": project.slug,
        "name": project.meta.name,
        "orgId": project.meta.org_id,
        "status": project.meta.status,
        "priority": project.meta.priority,
        "lead": project.meta.lead,
        "labels": project.meta.labels,
        "workItemPrefix": project.meta.work_item_prefix,
        "createdAt": project.meta.created_at,
        "updatedAt": project.meta.updated_at,
    })
}

fn cmd_project_list(_context: &ExecutionContext, flags: &HashMap<String, String>) -> i32 {
    let org = flags.get("org").map(String::as_str);
    match pio::read_all_projects_scoped(org) {
        Ok(projects) => {
            let items: Vec<serde_json::Value> = projects.iter().map(project_to_wire).collect();
            emit_success(serde_json::json!({ "items": items }), None, None)
        }
        Err(err) => emit_error(CliError::from_service(err)),
    }
}

fn cmd_project_show(slug: Option<&String>) -> i32 {
    let Some(slug) = slug else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "Usage: org2 project show <slug>",
        ));
    };
    match pio::read_project(slug) {
        Ok(project) => {
            let mut wire = project_to_wire(&project);
            wire["description"] = serde_json::Value::String(project.description.clone());
            emit_success(wire, None, None)
        }
        Err(err) => emit_error(CliError::from_service(err)),
    }
}

fn cmd_project_find(query: Option<&String>) -> i32 {
    let Some(query) = query else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "Usage: org2 project find <query>",
        ));
    };
    let needle = query.to_lowercase();
    match pio::read_all_projects_scoped(None) {
        Ok(projects) => {
            let items: Vec<serde_json::Value> = projects
                .iter()
                .filter(|project| {
                    project.slug.to_lowercase().contains(&needle)
                        || project.meta.name.to_lowercase().contains(&needle)
                })
                .map(project_to_wire)
                .collect();
            emit_success(serde_json::json!({ "items": items }), None, None)
        }
        Err(err) => emit_error(CliError::from_service(err)),
    }
}

fn cmd_project_members(slug: Option<&String>) -> i32 {
    let Some(slug) = slug else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "Usage: org2 project members <slug>",
        ));
    };
    match pio::read_project(slug) {
        Ok(project) => emit_success(
            serde_json::json!({
                "lead": project.meta.lead,
                "members": project.meta.members,
            }),
            None,
            None,
        ),
        Err(err) => emit_error(CliError::from_service(err)),
    }
}

fn cmd_project_create(context: &ExecutionContext, flags: &HashMap<String, String>) -> i32 {
    if let Err(err) = context.require_project_mode("project.create") {
        return emit_error(err);
    }
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    let Some(name) = flags.get("name").filter(|value| !value.trim().is_empty()) else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "project create requires --name",
        ));
    };
    let request = project_management::project_service::CreateProjectRequest {
        name: name.clone(),
        description: flags.get("description").cloned().unwrap_or_default(),
        org_id: flags.get("org").cloned(),
        status: flags.get("status").cloned(),
        priority: flags.get("priority").cloned(),
        lead: flags.get("lead").cloned(),
        labels: vec![],
    };
    let canonical = serde_json::json!({
        "op": "project.create",
        "name": name,
        "org": flags.get("org"),
    });
    let result = guarded(
        &actor.id,
        "project.create",
        flags
            .get("org")
            .map(String::as_str)
            .unwrap_or("personal-org"),
        flags.get("idempotency-key"),
        canonical,
        move || {
            let project = project_management::project_service::create_project(&request)?;
            Ok(project_to_wire(&project))
        },
    );
    match result {
        Ok(wire) => emit_success(wire, None, None),
        Err(err) => emit_error(err),
    }
}

fn cmd_project_update(
    context: &ExecutionContext,
    slug: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("project.update") {
        return emit_error(err);
    }
    let Some(slug) = slug else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "Usage: org2 project update <slug> [--name ...] [--status ...]",
        ));
    };
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    let request = project_management::project_service::UpdateProjectRequest {
        name: flags.get("name").cloned(),
        description: flags.get("description").cloned(),
        status: flags.get("status").cloned(),
        priority: flags.get("priority").cloned(),
        lead: flags.get("lead").cloned(),
    };
    let canonical = serde_json::json!({
        "op": "project.update",
        "slug": slug,
        "name": flags.get("name"),
        "status": flags.get("status"),
    });
    let slug_owned = slug.clone();
    let result = guarded(
        &actor.id,
        "project.update",
        &slug_owned.clone(),
        flags.get("idempotency-key"),
        canonical,
        move || {
            let project =
                project_management::project_service::update_project(&slug_owned, &request)?;
            Ok(project_to_wire(&project))
        },
    );
    match result {
        Ok(wire) => emit_success(wire, None, None),
        Err(err) => emit_error(err),
    }
}
