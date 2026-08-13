//! Work Item CRUD operations.

use project_management::projects::{
    io,
    types::{OrchestratorConfig, TodoEntry, WorkItemSchedule},
};

use super::helpers::{now_iso, run_blocking, truncate_preview, OrchestratorConfigOverrides};

/// List all work items for a project.
///
/// Returns a formatted summary suitable for agent consumption.
pub async fn list_work_items(project_slug: &str) -> Result<String, String> {
    let slug = project_slug.to_string();
    run_blocking("list_work_items", move || {
        let items = io::read_all_work_items(&slug)?;
        if items.is_empty() {
            return Ok("No work items found.".to_string());
        }
        let mut output = format!("Found {} work item(s):\n", items.len());
        for item in &items {
            let fm = &item.frontmatter;
            output.push_str(&format!(
                "\n- **{}** [{}]\n  Status: {} | Priority: {}",
                fm.title, fm.short_id, fm.status, fm.priority,
            ));
            if fm.starred {
                output.push_str(" | Starred");
            }
            output.push('\n');
            if let Some(ref project) = fm.project {
                output.push_str(&format!("  Project: {}\n", project));
            }
            if let Some(ref assignee) = fm.assignee {
                output.push_str(&format!("  Assignee: {}\n", assignee));
            }
            if let Some(ref milestone) = fm.milestone {
                output.push_str(&format!("  Milestone: {}\n", milestone));
            }
            if let Some(ref parent) = fm.parent {
                output.push_str(&format!("  Parent: {}\n", parent));
            }
            if !fm.labels.is_empty() {
                output.push_str(&format!("  Labels: {}\n", fm.labels.join(", ")));
            }
            if let Some(ref start_date) = fm.start_date {
                output.push_str(&format!("  Start: {} ", start_date));
            }
            if let Some(ref target_date) = fm.target_date {
                output.push_str(&format!("  Target: {}\n", target_date));
            }
            if !fm.todos.is_empty() {
                let done = fm
                    .todos
                    .iter()
                    .filter(|t| t.status == super::helpers::TODO_STATUS_COMPLETED)
                    .count();
                output.push_str(&format!("  Todos: {}/{}\n", done, fm.todos.len()));
            }
            if !item.body.is_empty() {
                let desc = truncate_preview(&item.body, 120);
                output.push_str(&format!("  Description: {}\n", desc.trim()));
            }
        }
        Ok(output)
    })
    .await
}

/// Read a single work item by short ID.
pub async fn read_work_item(project_slug: &str, short_id: &str) -> Result<String, String> {
    let slug = project_slug.to_string();
    let short_id = short_id.to_string();
    run_blocking("read_work_item", move || {
        let item = io::read_work_item(&slug, &short_id)?;
        let fm = &item.frontmatter;
        let mut output = format!(
            "Work Item: {} [{}]\nStatus: {}\nPriority: {}\nStarred: {}\nCreated: {}\nUpdated: {}\n",
            fm.title, fm.short_id, fm.status, fm.priority, fm.starred, fm.created_at, fm.updated_at,
        );
        if let Some(ref project) = fm.project {
            output.push_str(&format!("Project: {}\n", project));
        }
        if let Some(ref assignee) = fm.assignee {
            output.push_str(&format!("Assignee: {}\n", assignee));
        }
        if let Some(ref assignee_type) = fm.assignee_type {
            output.push_str(&format!("Assignee Type: {}\n", assignee_type));
        }
        if let Some(ref milestone) = fm.milestone {
            output.push_str(&format!("Milestone: {}\n", milestone));
        }
        if let Some(ref parent) = fm.parent {
            output.push_str(&format!("Parent: {}\n", parent));
        }
        if !fm.labels.is_empty() {
            output.push_str(&format!("Labels: {}\n", fm.labels.join(", ")));
        }
        if let Some(ref start_date) = fm.start_date {
            output.push_str(&format!("Start Date: {}\n", start_date));
        }
        if let Some(ref target_date) = fm.target_date {
            output.push_str(&format!("Target Date: {}\n", target_date));
        }
        if let Some(ref created_by) = fm.created_by {
            output.push_str(&format!("Created By: {}\n", created_by));
        }
        if !fm.todos.is_empty() {
            output.push_str(&format!("\nTodos ({}):\n", fm.todos.len()));
            for todo in &fm.todos {
                let marker = if todo.status == super::helpers::TODO_STATUS_COMPLETED {
                    "x"
                } else {
                    " "
                };
                output.push_str(&format!(
                    "  [{}] {} (id: {})\n",
                    marker, todo.content, todo.id
                ));
            }
        }
        if !fm.comments.is_empty() {
            output.push_str(&format!("\nComments ({}):\n", fm.comments.len()));
            for comment in &fm.comments {
                output.push_str(&format!(
                    "  [{}] {} — {}\n",
                    comment.created_at, comment.author, comment.content
                ));
            }
        }
        if !item.body.is_empty() {
            output.push_str(&format!("\nDescription:\n{}\n", item.body));
        }

        if let Some(ref pow) = fm.proof_of_work {
            output.push_str("\nProof of Work:\n");
            if let Some(ref branch) = pow.branch {
                output.push_str(&format!("  Branch: {}\n", branch));
            }
            if let Some(ref pr_url) = pow.pr_url {
                output.push_str(&format!("  PR: {}\n", pr_url));
            }
            if let Some(ref pr_status) = pow.pr_status {
                output.push_str(&format!("  PR Status: {:?}\n", pr_status));
            }
            if let Some(ref outcome) = pow.review_outcome {
                output.push_str(&format!("  Review Outcome: {:?}\n", outcome));
            }
            if let Some(ref feedback) = pow.review_feedback {
                output.push_str(&format!("  Review Summary: {}\n", feedback.summary));
                if !feedback.comments.is_empty() {
                    output.push_str(&format!(
                        "  Review Comments ({}):\n",
                        feedback.comments.len()
                    ));
                    for comment in &feedback.comments {
                        let location = match (&comment.file_path, comment.line) {
                            (Some(fp), Some(ln)) => format!("{}:{}", fp, ln),
                            (Some(fp), None) => fp.clone(),
                            _ => "general".to_string(),
                        };
                        output.push_str(&format!(
                            "    [{:?}] {}: {}\n",
                            comment.severity, location, comment.message
                        ));
                    }
                }
            }
            if !pow.review_history.is_empty() {
                output.push_str(&format!(
                    "  Review Rounds: {} (latest outcome above)\n",
                    pow.review_history.len() + 1
                ));
            }
            if let Some(ref diff) = pow.diff_stats {
                output.push_str(&format!(
                    "  Diff: {} files changed, +{} -{}\n",
                    diff.files_changed, diff.lines_added, diff.lines_removed
                ));
            }
            if let Some(ref tests) = pow.test_results {
                output.push_str(&format!(
                    "  Tests: {} passed, {} failed\n",
                    tests.passed, tests.failed
                ));
                if let Some(ref delta) = tests.coverage_delta {
                    output.push_str(&format!("  Coverage delta: {}\n", delta));
                }
            }
            if pow.total_tokens > 0 {
                output.push_str(&format!("  Total Tokens: {}\n", pow.total_tokens));
            }
            if pow.total_cost_usd > 0.0 {
                output.push_str(&format!("  Total Cost: ${:.4}\n", pow.total_cost_usd));
            }
        }

        if let Some(ref config) = fm.orchestrator_config {
            output.push_str("\nOrchestrator Config:\n");
            if let Some(ref account_id) = config.selected_account_id {
                output.push_str(&format!("  selected_account_id: {}\n", account_id));
            }
            if let Some(ref model_id) = config.selected_model_id {
                output.push_str(&format!("  selected_model_id: {}\n", model_id));
            }
            if let Some(ref agent_def_id) = config.agent_definition_id {
                output.push_str(&format!("  agent_definition_id: {}\n", agent_def_id));
            }
            if let Some(ref org_id) = config.org_id {
                output.push_str(&format!("  org_id: {}\n", org_id));
            }
            if !config.sub_agent_ids.is_empty() {
                output.push_str(&format!(
                    "  sub_agent_ids: {}\n",
                    config.sub_agent_ids.join(", ")
                ));
            }
        }

        if let Some(ref schedule) = fm.schedule {
            output.push_str("\nSchedule:\n");
            if let Some(ref at) = schedule.at {
                output.push_str(&format!("  at: {}\n", at));
            }
            if let Some(ref cron_expr) = schedule.cron {
                output.push_str(&format!("  cron: {}\n", cron_expr));
            }
            output.push_str(&format!("  enabled: {}\n", schedule.enabled));
        }

        if !fm.linked_sessions.is_empty() {
            output.push_str(&format!(
                "\nLinked Sessions ({}):\n",
                fm.linked_sessions.len()
            ));
            for ls in &fm.linked_sessions {
                output.push_str(&format!(
                    "  - {} (role: {:?}, status: {:?})\n",
                    ls.session_id, ls.agent_role, ls.status
                ));
            }
        }

        Ok(output)
    })
    .await
}

/// Create a new work item.
///
/// Automatically allocates the next short ID from the project counter.
/// Returns a success message with the allocated short ID.
#[allow(clippy::too_many_arguments)]
pub async fn create_work_item(
    project_slug: &str,
    title: &str,
    body: &str,
    project: Option<&str>,
    status: Option<&str>,
    priority: Option<&str>,
    assignee: Option<&str>,
    assignee_type: Option<&str>,
    labels: Option<Vec<String>>,
    milestone: Option<&str>,
    parent: Option<&str>,
    start_date: Option<&str>,
    target_date: Option<&str>,
    starred: Option<bool>,
    todos: Option<Vec<(String, String)>>,
    orchestrator_overrides: Option<OrchestratorConfigOverrides>,
    schedule: Option<WorkItemSchedule>,
) -> Result<String, String> {
    let slug = project_slug.to_string();
    let title = title.to_string();
    let body = body.to_string();
    let project = project.map(String::from);
    let status = status.unwrap_or("backlog").to_string();
    let priority = priority.unwrap_or("none").to_string();
    let assignee = assignee.map(String::from);
    let assignee_type = assignee_type.map(String::from);
    let labels = labels.unwrap_or_default();
    let milestone = milestone.map(String::from);
    let parent = parent.map(String::from);
    let start_date = start_date.map(String::from);
    let target_date = target_date.map(String::from);
    let starred = starred.unwrap_or(false);
    let todos = todos.unwrap_or_default();

    run_blocking("create_work_item", move || {
        let short_id = io::allocate_short_id(&slug)?;

        let todo_entries: Vec<TodoEntry> = todos
            .into_iter()
            .enumerate()
            .map(|(idx, (content, status))| TodoEntry {
                id: format!("todo-{}", idx + 1),
                content,
                status,
            })
            .collect();

        let orchestrator_config = orchestrator_overrides.map(|o| {
            let mut config = OrchestratorConfig::default();
            if let Some(id) = o.selected_account_id.filter(|s| !s.is_empty()) {
                config.selected_account_id = Some(id);
            }
            if let Some(id) = o.selected_model_id.filter(|s| !s.is_empty()) {
                config.selected_model_id = Some(id);
            }
            if !o.sub_agent_ids.is_empty() {
                config.sub_agent_ids = o.sub_agent_ids;
            }
            if o.org_id.is_some() {
                config.org_id = o.org_id;
            }
            if o.agent_definition_id.is_some() {
                config.agent_definition_id = o.agent_definition_id;
            }
            if o.worktree_path.is_some() {
                config.worktree_path = o.worktree_path;
            }
            if o.review_config.is_some() {
                config.review_config = o.review_config;
            }
            config
        });

        // Canonical work.create: the application service owns row
        // construction and audits the creation.
        let request = project_management::work_service::CreateWorkItemRequest {
            stage: None,
            title: title.clone(),
            body: body.clone(),
            project_id: project,
            status: Some(status),
            priority: Some(priority),
            assignee,
            assignee_type,
            labels,
            milestone,
            parent,
            start_date,
            target_date,
            created_by: Some("agent".to_string()),
            origin_session: None,
            starred,
            schedule,
            orchestrator_config,
            todos: todo_entries,
            handoff: None,
            linked_sessions: vec![],
        };
        let created = project_management::work_service::create_project_work_item(
            &slug, &short_id, &request, None,
        )?;

        let schedule_info = if let Some(sched) = created.frontmatter.schedule.as_ref() {
            if let Some(ref at) = sched.at {
                format!(" (scheduled at {})", at)
            } else if let Some(ref cron_expr) = sched.cron {
                format!(" (recurring: {})", cron_expr)
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        Ok(format!(
            "Created work item '{}' [{}]{}",
            title, short_id, schedule_info
        ))
    })
    .await
}

/// Update an existing work item.
///
/// Only the fields that are `Some` will be updated; others are left unchanged.
/// Pass an empty string for optional string fields to clear them.
/// Pass an empty vec for `labels` to clear them.
#[allow(clippy::too_many_arguments)]
pub async fn update_work_item(
    project_slug: &str,
    short_id: &str,
    title: Option<&str>,
    body: Option<&str>,
    project: Option<&str>,
    status: Option<&str>,
    priority: Option<&str>,
    assignee: Option<&str>,
    assignee_type: Option<&str>,
    labels: Option<Vec<String>>,
    milestone: Option<&str>,
    parent: Option<&str>,
    start_date: Option<&str>,
    target_date: Option<&str>,
    starred: Option<bool>,
    todos: Option<Vec<(String, String)>>,
    orchestrator_overrides: Option<OrchestratorConfigOverrides>,
    schedule: Option<WorkItemSchedule>,
) -> Result<String, String> {
    let slug = project_slug.to_string();
    let short_id = short_id.to_string();
    let title = title.map(String::from);
    let body = body.map(String::from);
    let project = project.map(String::from);
    let status = status.map(String::from);
    let priority = priority.map(String::from);
    let assignee = assignee.map(String::from);
    let assignee_type = assignee_type.map(String::from);
    let milestone = milestone.map(String::from);
    let parent = parent.map(String::from);
    let start_date = start_date.map(String::from);
    let target_date = target_date.map(String::from);

    run_blocking("update_work_item", move || {
        let updated_title = io::update_work_item_atomic(&slug, &short_id, |fm, existing_body| {
            if let Some(new_title) = title {
                fm.title = new_title;
            }
            if let Some(new_body) = body {
                *existing_body = new_body;
            }
            if let Some(new_project) = project {
                fm.project = if new_project.is_empty() {
                    None
                } else {
                    Some(new_project)
                };
            }
            if let Some(new_status) = status {
                fm.status = new_status;
            }
            if let Some(new_priority) = priority {
                fm.priority = new_priority;
            }
            if let Some(new_assignee) = assignee {
                fm.assignee = if new_assignee.is_empty() {
                    None
                } else {
                    Some(new_assignee)
                };
            }
            if let Some(new_assignee_type) = assignee_type {
                fm.assignee_type = if new_assignee_type.is_empty() {
                    None
                } else {
                    Some(new_assignee_type)
                };
            }
            if let Some(new_labels) = labels {
                fm.labels = new_labels;
            }
            if let Some(new_milestone) = milestone {
                fm.milestone = if new_milestone.is_empty() {
                    None
                } else {
                    Some(new_milestone)
                };
            }
            if let Some(new_parent) = parent {
                fm.parent = if new_parent.is_empty() {
                    None
                } else {
                    Some(new_parent)
                };
            }
            if let Some(new_start_date) = start_date {
                fm.start_date = if new_start_date.is_empty() {
                    None
                } else {
                    Some(new_start_date)
                };
            }
            if let Some(new_target_date) = target_date {
                fm.target_date = if new_target_date.is_empty() {
                    None
                } else {
                    Some(new_target_date)
                };
            }
            if let Some(new_starred) = starred {
                fm.starred = new_starred;
            }
            if let Some(new_todos) = todos {
                fm.todos = new_todos
                    .into_iter()
                    .enumerate()
                    .map(|(idx, (content, status))| {
                        let todo_id = fm
                            .todos
                            .get(idx)
                            .map(|existing| existing.id.clone())
                            .unwrap_or_else(|| format!("todo-{}", idx + 1));
                        TodoEntry {
                            id: todo_id,
                            content,
                            status,
                        }
                    })
                    .collect();
            }
            if let Some(ref overrides) = orchestrator_overrides {
                let mut config = fm.orchestrator_config.clone().unwrap_or_default();
                if let Some(id) = overrides
                    .selected_account_id
                    .as_ref()
                    .filter(|s| !s.is_empty())
                {
                    config.selected_account_id = Some(id.to_string());
                }
                if let Some(id) = overrides
                    .selected_model_id
                    .as_ref()
                    .filter(|s| !s.is_empty())
                {
                    config.selected_model_id = Some(id.to_string());
                }
                if !overrides.sub_agent_ids.is_empty() {
                    config.sub_agent_ids = overrides.sub_agent_ids.clone();
                }
                if overrides.org_id.is_some() {
                    config.org_id = overrides.org_id.clone();
                }
                if overrides.agent_definition_id.is_some() {
                    config.agent_definition_id = overrides.agent_definition_id.clone();
                }
                if overrides.worktree_path.is_some() {
                    config.worktree_path = overrides.worktree_path.clone();
                }
                if overrides.review_config.is_some() {
                    config.review_config = overrides.review_config.clone();
                }
                fm.orchestrator_config = Some(config);
            }
            if let Some(new_schedule) = schedule {
                fm.schedule = Some(new_schedule);
            }
            fm.updated_at = now_iso();
            Ok(fm.title.clone())
        })?;

        Ok(format!(
            "Updated work item '{}' [{}]",
            updated_title, short_id
        ))
    })
    .await
}

/// Delete a work item by short ID.
pub async fn delete_work_item(project_slug: &str, short_id: &str) -> Result<String, String> {
    let slug = project_slug.to_string();
    let short_id = short_id.to_string();
    run_blocking("delete_work_item", move || {
        io::delete_work_item(&slug, &short_id)?;
        Ok(serde_json::json!({
            "action": "delete_item",
            "resource": "work_item",
            "deleted": true,
            "project_slug": slug,
            "short_id": short_id,
            "message": "Work item deleted"
        })
        .to_string())
    })
    .await
}
