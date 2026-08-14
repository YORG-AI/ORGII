//! System prompt section builders for agent sessions.
//!
//! Each `build_*_context()` function produces a markdown section
//! (code accounts, agents, teams, etc.) that is injected into the
//! agent's system prompt.
//!
//! `ids` lists every recognised builder id — the strings stored in
//! `DelegationConfig.context_builders` and matched in the `agent` tool's
//! dispatch switch. Builtin agent definitions (sde, os, specialists, …)
//! reference these constants instead of hand-writing the literal strings.

use tracing::warn;

use project_management::projects::io as projects_io;

/// Canonical context-builder ids.
///
/// These are the only values `agent::resolve_context_sections` will
/// dispatch on. Any other value triggers a `warn!` and is skipped.
pub mod ids {
    /// Code accounts (credentials) with their active models.
    pub const CODE_ACCOUNTS: &str = "code_accounts";
    /// Team members (people listed in the project).
    pub const TEAM_MEMBERS: &str = "team_members";
    /// Available agent definitions (built-in + user-defined).
    pub const AGENT_DEFINITIONS: &str = "agent_definitions";
    /// Agent orgs (groupings of agents into teams).
    pub const AGENT_ORGS: &str = "agent_orgs";
    /// Environment summary (active repo + personal workspace paths).
    pub const ENVIRONMENT: &str = "environment";
}

/// Build a section listing available code accounts (credentials) with their
/// active models plus account assignment rules.
pub fn build_code_accounts_context() -> Option<String> {
    use key_vault::key_store::KEY_SERVICE;

    let creds = KEY_SERVICE.list_keys();
    if creds.is_empty() {
        return None;
    }

    let mut out = String::from("## Available Code Accounts\n\n");
    for cred in &creds {
        let name = cred.name.as_deref().unwrap_or("unnamed");
        let models_display = if cred.enabled_models.is_empty() {
            "no active models".to_string()
        } else {
            cred.enabled_models
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        };
        out.push_str(&format!(
            "- [{}] {} (provider: {:?})\n  models: {}\n",
            cred.id, name, cred.model_type, models_display
        ));
    }
    out.push_str(
        "\n### Account Assignment Rules\n\n\
         - When creating or starting work items, ALWAYS set BOTH \
         `selected_account_id` AND `selected_model_id` in orchestrator_config.\n\
         - `selected_model_id` MUST be one of the models listed above for that account. \
         Never leave it empty.\n\
         - When assigning an agent (`assignee_type: \"agent\"`), also set \
         `agent_definition_id` in orchestrator config.\n\
         - **Project repos**: When creating a project, set `linked_repos` to all \
         associated code repositories. These define the project's linked repos.\n\
         - **Work item repo**: Set `worktree_path` on `create_item`/`update_item` to \
         specify which repo the coding agent works in. Resolution order: work item \
         `worktree_path` → project `linked_repos[0]` → personal workspace.\n\
         - If `start_item` fails due to account auth errors or insufficient quota, try \
         another account: `update_item` to change `selected_account_id` and \
         `selected_model_id`, then `start_item` again.\n\
         - You can assign tasks to humans (`assignee_type: \"member\"`) for work that \
         requires manual action (e.g., creating cloud accounts, reviewing UI designs).\n",
    );
    Some(out)
}

/// Build a compact listing of custom agent definitions.
///
/// I/O and parse failures are *not* fatal to the agent launch — the
/// section is dropped from the prompt and a `warn!` records the
/// reason so operators can correct the on-disk file. (Surfacing as
/// `ToolError` would otherwise abort every subagent dispatch on a
/// stray syntax error in `agents.json`.)
pub fn build_agent_definitions_context() -> Option<String> {
    let defs_path = app_paths::agent_definitions();
    if !defs_path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&defs_path)
        .map_err(|err| {
            warn!(
                "[agent] read agent definitions context from {}: {}; section skipped",
                defs_path.display(),
                err
            );
        })
        .ok()?;
    let agents: Vec<crate::definitions::AgentDefinition> = serde_json::from_str(&content)
        .map_err(|err| {
            warn!(
                "[agent] parse agent definitions context from {}: {}; section skipped",
                defs_path.display(),
                err
            );
        })
        .ok()?;
    if agents.is_empty() {
        return None;
    }

    let mut out = String::from("## Custom Agents\n\n");
    for agent in &agents {
        let mut line = format!("- **{}** (`{}`)", agent.name, agent.id);
        if let Some(ref desc) = agent.description {
            let preview: String = crate::utils::safe_truncate_chars_to_string(&desc, 80);
            let suffix = if desc.chars().count() > 80 { "…" } else { "" };
            line.push_str(&format!(": {}{}", preview, suffix));
        }
        out.push('\n');
        out.push_str(&line);
    }
    Some(out)
}

/// Build a compact listing of agent organizations.
///
/// Uses the canonical process store so prompt assembly observes exactly the
/// same versioned definitions and fail-closed validation as settings, launch,
/// Work Items, and Routines.
pub fn build_agent_orgs_context() -> Option<String> {
    let orgs = crate::definitions::orgs::orgs_store()
        .list()
        .map_err(|err| {
            warn!("[agent] load canonical Agent Org context: {err}; section skipped");
        })
        .ok()?;
    if orgs.is_empty() {
        return None;
    }

    let mut out = String::from("## Agent Organizations\n\n");
    for org in &orgs {
        let mut line = format!(
            "- **{}** (`{}`, {} participants)",
            org.name,
            org.id,
            org.participant_count()
        );
        if let Some(ref desc) = org.description {
            let preview: String = crate::utils::safe_truncate_chars_to_string(&desc, 60);
            let suffix = if desc.chars().count() > 60 { "…" } else { "" };
            line.push_str(&format!(": {}{}", preview, suffix));
        }
        out.push('\n');
        out.push_str(&line);
    }
    Some(out)
}

/// Build a section listing team members for projects linked to `repo_path`.
///
/// Members live in the global project store, scoped to a `project_id`.
/// To preserve the previous "repo → members" convenience, we union members
/// across every project whose `linked_repos` contains this repo path.
/// Members are de-duplicated by `MemberEntry::id`.
pub fn build_members_context(repo_path: &str) -> Option<String> {
    let projects = projects_io::read_all_projects()
        .map_err(|err| {
            warn!(
                "[agent] read projects for team-member context: {}; section skipped",
                err
            );
        })
        .ok()?;

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut roster: Vec<project_management::projects::types::MemberEntry> = Vec::new();
    for project in &projects {
        if !project
            .meta
            .linked_repos
            .iter()
            .any(|repo| repo == repo_path)
        {
            continue;
        }
        let members_file = match projects_io::read_members(&project.meta.id) {
            Ok(file) => file,
            Err(err) => {
                warn!(
                    "[agent] read members for project {}: {}; project skipped in team-member context",
                    project.meta.id, err
                );
                continue;
            }
        };
        for member in members_file.members {
            if !member.active {
                continue;
            }
            if seen.insert(member.id.clone()) {
                roster.push(member);
            }
        }
    }

    if roster.is_empty() {
        return None;
    }

    let mut out = String::from("## Team Members\n\n");
    for member in &roster {
        let mut line = format!("- **{}** (`{}`)", member.name, member.id);
        if let Some(ref email) = member.email {
            line.push_str(&format!(" <{}>", email));
        }
        if let Some(ref gh) = member.github_username {
            line.push_str(&format!(" @{}", gh));
        }
        if let Some(ref date) = member.last_commit_date {
            line.push_str(&format!(" (last commit: {})", date));
        }
        out.push('\n');
        out.push_str(&line);
    }
    Some(out)
}
