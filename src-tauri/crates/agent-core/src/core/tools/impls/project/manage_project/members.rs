//! Team-member action handlers (`list_members`, `list_contributors`).
//!
//! Members live in the global project store and are scoped to a project
//! id. `list_contributors` runs `git shortlog` against every repo listed
//! in the project's `linked_repos`, merges the result with existing
//! rows, and returns the updated roster.

use crate::tools::traits::ToolError;
use project_management::projects::io as projects_io;
use project_management::projects::types::{MemberEntry, ProjectData};

pub(super) fn list_members(slug: Option<&str>) -> Result<String, ToolError> {
    let projects = projects_for_optional_slug(slug)?;
    if projects.is_empty() {
        return Ok("No projects found.".to_string());
    }

    let mut output = String::new();
    for project in projects {
        let members_file =
            projects_io::read_members(&project.meta.id).map_err(ToolError::ExecutionFailed)?;
        if members_file.members.is_empty() {
            output.push_str(&format!(
                "No team members found for `{}`. Use `list_contributors` to discover contributors from the project's linked git repositories.\n\n",
                project.slug
            ));
            continue;
        }

        output.push_str(&format!(
            "Team members for `{}` ({}):\n\n",
            project.slug,
            members_file.members.len()
        ));
        for member in &members_file.members {
            append_member_line(&mut output, member);
        }
        output.push('\n');
    }

    Ok(output.trim_end().to_string())
}

pub(super) fn list_contributors(slug: Option<&str>) -> Result<String, ToolError> {
    let projects = projects_for_optional_slug(slug)?;
    if projects.is_empty() {
        return Ok("No projects found.".to_string());
    }

    let mut output = String::new();
    for project in projects {
        let sync_result = projects_io::sync_members_from_git(&project.slug)
            .map_err(ToolError::ExecutionFailed)?;
        let members_file =
            projects_io::read_members(&project.meta.id).map_err(ToolError::ExecutionFailed)?;
        output.push_str(&format!(
            "Synced git contributors for `{}`: {} added, {} updated.\nTeam members ({}):\n\n",
            project.slug,
            sync_result.added,
            sync_result.updated,
            members_file.members.len()
        ));
        for member in &members_file.members {
            append_member_line(&mut output, member);
        }
        output.push('\n');
    }

    Ok(output.trim_end().to_string())
}

fn projects_for_optional_slug(slug: Option<&str>) -> Result<Vec<ProjectData>, ToolError> {
    match slug {
        Some(project_slug) => projects_io::read_project(project_slug)
            .map(|project| vec![project])
            .map_err(ToolError::ExecutionFailed),
        None => projects_io::read_all_projects().map_err(ToolError::ExecutionFailed),
    }
}

fn append_member_line(output: &mut String, member: &MemberEntry) {
    let status = if member.active { "" } else { " [inactive]" };
    output.push_str(&format!("- {} (`{}`)", member.name, member.id));
    if let Some(ref email) = member.email {
        output.push_str(&format!(" <{}>", email));
    }
    if let Some(ref gh) = member.github_username {
        output.push_str(&format!(" @{}", gh));
    }
    if let Some(ref date) = member.last_commit_date {
        output.push_str(&format!(" (last commit: {})", date));
    }
    output.push_str(status);
    output.push('\n');
}
