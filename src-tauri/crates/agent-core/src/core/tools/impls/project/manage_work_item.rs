//! Work item tool: manage project-scoped and standalone work items.
//!
//! Thin wrapper over `tool_infra::project` and `project_management::projects::io` —
//! shared implementations used by agent tools and Tauri work-item commands.

use async_trait::async_trait;
use serde_json::{Map, Value};

use crate::tool_infra::OrchestratorConfigOverrides;
use crate::tools::names as tool_names;
use crate::tools::traits::{optional_bool, optional_string, required_string, Tool, ToolError};
use core_types::workflow::{
    AgentRole, LinkedSession, LinkedSessionStatus, LinkedSessionType, WorkItemSchedule,
};
use project_management::projects::{
    io,
    types::{OrchestratorConfig, TodoEntry, WorkItemData, WorkItemFrontmatter},
};

async fn run_blocking<F, T>(label: &str, func: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let label = label.to_string();
    tokio::task::spawn_blocking(func)
        .await
        .map_err(|err| format!("{label} task failed: {err}"))?
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WorkItemScope {
    Project(String),
    Standalone,
}

/// Work item (task/issue) management tool.
pub struct WorkItemTool {
    session_id: String,
    app_handle: Option<tauri::AppHandle>,
    session_account_id: Option<String>,
    agent_model: String,
}

impl WorkItemTool {
    pub fn new(session_id: String) -> Self {
        Self {
            session_id,
            app_handle: None,
            session_account_id: None,
            agent_model: String::new(),
        }
    }

    pub fn with_launch_context(
        session_id: String,
        app_handle: Option<tauri::AppHandle>,
        session_account_id: Option<String>,
        agent_model: String,
    ) -> Self {
        Self {
            session_id,
            app_handle,
            session_account_id,
            agent_model,
        }
    }

    fn resolve_scope(params: &Value) -> Result<WorkItemScope, ToolError> {
        match optional_string(params, "project_slug") {
            Some(raw) if !raw.trim().is_empty() => crate::tool_infra::resolve_slug(&raw)
                .map(WorkItemScope::Project)
                .map_err(ToolError::ExecutionFailed),
            _ => Ok(WorkItemScope::Standalone),
        }
    }

    fn optional_string_array(params: &Value, key: &str) -> Option<Vec<String>> {
        params.get(key).and_then(|val| {
            val.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str().map(String::from))
                    .collect()
            })
        })
    }

    fn optional_todos(params: &Value) -> Option<Vec<(String, String)>> {
        params.get("todos").and_then(|val| {
            val.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let content = item.get("content")?.as_str()?.to_string();
                        let status = item
                            .get("status")
                            .and_then(|s| s.as_str())
                            .unwrap_or("pending")
                            .to_string();
                        Some((content, status))
                    })
                    .collect()
            })
        })
    }

    fn parse_schedule(params: &Value) -> Option<WorkItemSchedule> {
        let obj = params.get("schedule")?;
        if obj.is_null() {
            return None;
        }
        let at = obj.get("at").and_then(|v| v.as_str()).map(String::from);
        let cron = obj.get("cron").and_then(|v| v.as_str()).map(String::from);
        let enabled = obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        Some(WorkItemSchedule {
            at,
            cron,
            enabled,
            last_run: None,
        })
    }

    fn batch_items(params: &Value) -> Result<Vec<Value>, ToolError> {
        let Some(items) = params.get("items") else {
            return Err(ToolError::InvalidParams(
                "items array is required for batch".to_string(),
            ));
        };
        let items = items.as_array().ok_or_else(|| {
            ToolError::InvalidParams("items must be an array for batch".to_string())
        })?;
        if items.is_empty() {
            return Err(ToolError::InvalidParams(
                "items must contain at least one operation".to_string(),
            ));
        }

        let mut merged_items = Vec::with_capacity(items.len());
        for (idx, item) in items.iter().enumerate() {
            let item_obj = item.as_object().ok_or_else(|| {
                ToolError::InvalidParams(format!("items[{idx}] must be an object"))
            })?;
            let mut merged = Map::new();
            if let Some(project_slug) = params.get("project_slug") {
                merged.insert("project_slug".to_string(), project_slug.clone());
            }
            if let Some(session_status) = params.get("session_status") {
                merged.insert("session_status".to_string(), session_status.clone());
            }
            if let Some(agent_role) = params.get("agent_role") {
                merged.insert("agent_role".to_string(), agent_role.clone());
            }
            for (key, value) in item_obj {
                merged.insert(key.clone(), value.clone());
            }
            if !merged.contains_key("action") {
                return Err(ToolError::InvalidParams(format!(
                    "items[{idx}].action is required"
                )));
            }
            merged_items.push(Value::Object(merged));
        }
        Ok(merged_items)
    }

    async fn execute_batch(
        &self,
        params: &Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let items = Self::batch_items(params)?;
        let mut lines = vec![format!("Batch completed: {} operation(s)", items.len())];
        for (idx, item) in items.into_iter().enumerate() {
            let tool = WorkItemTool::new(self.session_id.clone());
            let result = Box::pin(tool.execute_text(item, ctx)).await;
            match result {
                Ok(text) => lines.push(format!("{}. OK: {}", idx + 1, text)),
                Err(err) => lines.push(format!("{}. ERROR: {}", idx + 1, err)),
            }
        }
        Ok(lines.join("\n"))
    }

    fn orchestrator_overrides_from_params(params: &Value) -> Option<OrchestratorConfigOverrides> {
        let account = optional_string(params, "selected_account_id");
        let model = optional_string(params, "selected_model_id");
        let sub_agents = Self::optional_string_array(params, "sub_agent_ids");
        let org_id = optional_string(params, "org_id");
        let agent_definition_id = optional_string(params, "agent_definition_id");
        let worktree_path = optional_string(params, "worktree_path");
        let review_config = params.get("review_config").and_then(|rc| {
            serde_json::from_value::<core_types::workflow::ReviewConfig>(rc.clone()).ok()
        });
        if account.is_some()
            || model.is_some()
            || sub_agents.as_ref().is_some_and(|v| !v.is_empty())
            || org_id.is_some()
            || agent_definition_id.is_some()
            || worktree_path.is_some()
            || review_config.is_some()
        {
            Some(OrchestratorConfigOverrides {
                selected_account_id: account,
                selected_model_id: model,
                sub_agent_ids: sub_agents.unwrap_or_default(),
                org_id,
                agent_definition_id,
                worktree_path,
                review_config,
            })
        } else {
            None
        }
    }

    fn todos_to_entries(todos: Vec<(String, String)>, existing: &[TodoEntry]) -> Vec<TodoEntry> {
        todos
            .into_iter()
            .enumerate()
            .map(|(idx, (content, status))| TodoEntry {
                id: existing
                    .get(idx)
                    .map(|todo| todo.id.clone())
                    .unwrap_or_else(|| format!("todo-{}", idx + 1)),
                content,
                status,
            })
            .collect()
    }

    fn config_from_overrides(overrides: OrchestratorConfigOverrides) -> OrchestratorConfig {
        let mut config = OrchestratorConfig::default();
        if let Some(id) = overrides.selected_account_id.filter(|s| !s.is_empty()) {
            config.selected_account_id = Some(id);
        }
        if let Some(id) = overrides.selected_model_id.filter(|s| !s.is_empty()) {
            config.selected_model_id = Some(id);
        }
        if !overrides.sub_agent_ids.is_empty() {
            config.sub_agent_ids = overrides.sub_agent_ids;
        }
        config.org_id = overrides.org_id;
        config.agent_definition_id = overrides.agent_definition_id;
        config.worktree_path = overrides.worktree_path;
        config.review_config = overrides.review_config;
        config
    }

    fn apply_updates(
        fm: &mut WorkItemFrontmatter,
        body: &mut String,
        params: &Value,
    ) -> Result<(), ToolError> {
        if let Some(title) = optional_string(params, "title") {
            fm.title = title;
        }
        if let Some(description) = optional_string(params, "description") {
            *body = description;
        }
        if let Some(project) = optional_string(params, "project") {
            fm.project = if project.is_empty() {
                None
            } else {
                Some(project)
            };
        }
        if let Some(status) = optional_string(params, "status") {
            fm.status = status;
        }
        if let Some(priority) = optional_string(params, "priority") {
            fm.priority = priority;
        }
        if let Some(assignee) = optional_string(params, "assignee") {
            fm.assignee = if assignee.is_empty() {
                None
            } else {
                Some(assignee)
            };
        }
        if let Some(labels) = Self::optional_string_array(params, "labels") {
            fm.labels = labels;
        }
        if let Some(milestone) = optional_string(params, "milestone") {
            fm.milestone = if milestone.is_empty() {
                None
            } else {
                Some(milestone)
            };
        }
        if let Some(parent) = optional_string(params, "parent") {
            fm.parent = if parent.is_empty() {
                None
            } else {
                Some(parent)
            };
        }
        if let Some(start_date) = optional_string(params, "start_date") {
            fm.start_date = if start_date.is_empty() {
                None
            } else {
                Some(start_date)
            };
        }
        if let Some(target_date) = optional_string(params, "target_date") {
            fm.target_date = if target_date.is_empty() {
                None
            } else {
                Some(target_date)
            };
        }
        if let Some(starred) = optional_bool(params, "starred") {
            fm.starred = starred;
        }
        if let Some(todos) = Self::optional_todos(params) {
            fm.todos = Self::todos_to_entries(todos, &fm.todos);
        }
        if let Some(overrides) = Self::orchestrator_overrides_from_params(params) {
            fm.orchestrator_config = Some(Self::config_from_overrides(overrides));
        }
        if let Some(schedule) = Self::parse_schedule(params) {
            fm.schedule = Some(schedule);
        }
        fm.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(())
    }

    fn parse_linked_session_status(raw: Option<String>) -> Result<LinkedSessionStatus, ToolError> {
        match raw.as_deref().unwrap_or("running") {
            "running" => Ok(LinkedSessionStatus::Running),
            "completed" => Ok(LinkedSessionStatus::Completed),
            "failed" => Ok(LinkedSessionStatus::Failed),
            "cancelled" => Ok(LinkedSessionStatus::Cancelled),
            other => Err(ToolError::InvalidParams(format!(
                "Unknown linked session status '{other}'"
            ))),
        }
    }

    fn parse_agent_role(raw: Option<String>) -> Result<AgentRole, ToolError> {
        match raw.as_deref().unwrap_or("custom") {
            "coding" | "sde" => Ok(AgentRole::Coding),
            "review" => Ok(AgentRole::Review),
            "orchestrator" => Ok(AgentRole::Orchestrator),
            "custom" => Ok(AgentRole::Custom),
            "sub_agent" => Ok(AgentRole::SubAgent),
            other => Err(ToolError::InvalidParams(format!(
                "Unknown linked session agent_role '{other}'"
            ))),
        }
    }

    fn link_session_to_frontmatter(
        &self,
        fm: &mut WorkItemFrontmatter,
        params: &Value,
    ) -> Result<String, ToolError> {
        let session_id =
            optional_string(params, "session_id").unwrap_or_else(|| self.session_id.clone());
        let status = Self::parse_linked_session_status(optional_string(params, "session_status"))?;
        let agent_role = Self::parse_agent_role(optional_string(params, "agent_role"))?;
        let now = chrono::Utc::now().to_rfc3339();

        if let Some(existing) = fm
            .linked_sessions
            .iter_mut()
            .find(|linked| linked.session_id == session_id)
        {
            existing.status = status;
            existing.agent_role = agent_role;
            if existing.completed_at.is_none()
                && matches!(
                    existing.status,
                    LinkedSessionStatus::Completed
                        | LinkedSessionStatus::Failed
                        | LinkedSessionStatus::Cancelled
                )
            {
                existing.completed_at = Some(now.clone());
            }
        } else {
            fm.linked_sessions.push(LinkedSession {
                session_id: session_id.clone(),
                session_type: LinkedSessionType::Native,
                agent_role,
                started_at: now.clone(),
                completed_at: None,
                status,
                cost_usd: 0.0,
                total_tokens: 0,
                parent_session_id: None,
                sub_agent_name: None,
                sub_agent_instance: None,
                result_preview: None,
            });
        }
        fm.updated_at = now;
        Ok(session_id)
    }

    fn unlink_session_from_frontmatter(
        &self,
        fm: &mut WorkItemFrontmatter,
        params: &Value,
    ) -> String {
        let session_id =
            optional_string(params, "session_id").unwrap_or_else(|| self.session_id.clone());
        fm.linked_sessions
            .retain(|linked| linked.session_id != session_id);
        fm.updated_at = chrono::Utc::now().to_rfc3339();
        session_id
    }

    fn format_item(item: &WorkItemData) -> String {
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
        if !fm.labels.is_empty() {
            output.push_str(&format!("Labels: {}\n", fm.labels.join(", ")));
        }
        if !item.body.is_empty() {
            output.push_str(&format!("\nDescription:\n{}\n", item.body));
        }
        if !fm.linked_sessions.is_empty() {
            output.push_str(&format!(
                "\nLinked Sessions ({}):\n",
                fm.linked_sessions.len()
            ));
            for linked in &fm.linked_sessions {
                output.push_str(&format!(
                    "  - {} (role: {:?}, status: {:?})\n",
                    linked.session_id, linked.agent_role, linked.status
                ));
            }
        }
        output
    }

    async fn list_standalone_work_items() -> Result<String, ToolError> {
        run_blocking("list_standalone_work_items", move || {
            let items = io::read_standalone_work_items(None)?;
            if items.is_empty() {
                return Ok("No standalone work items found.".to_string());
            }
            let mut output = format!("Found {} standalone work item(s):\n", items.len());
            for item in &items {
                let fm = &item.frontmatter;
                output.push_str(&format!(
                    "\n- **{}** [{}]\n  Status: {} | Priority: {}\n",
                    fm.title, fm.short_id, fm.status, fm.priority,
                ));
            }
            Ok(output)
        })
        .await
        .map_err(ToolError::ExecutionFailed)
    }

    async fn read_standalone_work_item(short_id: String) -> Result<String, ToolError> {
        run_blocking("read_standalone_work_item", move || {
            let item = io::read_standalone_work_item(None, &short_id)?;
            Ok(Self::format_item(&item))
        })
        .await
        .map_err(ToolError::ExecutionFailed)
    }

    async fn create_standalone_work_item(params: Value) -> Result<String, ToolError> {
        let title = required_string(&params, "title")?;
        let body = optional_string(&params, "description").unwrap_or_default();
        let project = optional_string(&params, "project");
        let status = optional_string(&params, "status").unwrap_or_else(|| "backlog".to_string());
        let priority = optional_string(&params, "priority").unwrap_or_else(|| "none".to_string());
        let assignee = optional_string(&params, "assignee");
        let labels = Self::optional_string_array(&params, "labels").unwrap_or_default();
        let milestone = optional_string(&params, "milestone");
        let parent = optional_string(&params, "parent");
        let start_date = optional_string(&params, "start_date");
        let target_date = optional_string(&params, "target_date");
        let starred = optional_bool(&params, "starred").unwrap_or(false);
        let todos = Self::optional_todos(&params).unwrap_or_default();
        let orchestrator_config =
            Self::orchestrator_overrides_from_params(&params).map(Self::config_from_overrides);
        let schedule = Self::parse_schedule(&params);

        run_blocking("create_standalone_work_item", move || {
            let short_id = io::allocate_standalone_short_id(None)?;
            let now = chrono::Utc::now().to_rfc3339();
            let frontmatter = WorkItemFrontmatter {
                id: short_id.clone(),
                short_id: short_id.clone(),
                title: title.clone(),
                project,
                status,
                priority,
                assignee,
                assignee_type: None,
                labels,
                milestone,
                parent,
                start_date,
                target_date,
                created_by: Some("agent".to_string()),
                created_at: now.clone(),
                updated_at: now,
                deleted_at: None,
                starred,
                todos: Self::todos_to_entries(todos, &[]),
                comments: vec![],
                history: vec![],
                delegations: vec![],
                linked_sessions: vec![],
                proof_of_work: None,
                orchestrator_config,
                orchestrator_state: None,
                follow_up_items: vec![],
                schedule,
                routine_source: None,
                execution_lock: None,
                close_out: None,
                work_products: vec![],
            };
            io::write_standalone_work_item(None, &short_id, &frontmatter, &body)?;
            Ok(format!(
                "Created standalone work item '{}' [{}]",
                title, short_id
            ))
        })
        .await
        .map_err(ToolError::ExecutionFailed)
    }

    async fn update_standalone_work_item(
        short_id: String,
        params: Value,
    ) -> Result<String, ToolError> {
        run_blocking("update_standalone_work_item", move || {
            let mut item = io::read_standalone_work_item(None, &short_id)?;
            Self::apply_updates(&mut item.frontmatter, &mut item.body, &params)
                .map_err(|err| err.to_string())?;
            io::write_standalone_work_item(None, &short_id, &item.frontmatter, &item.body)?;
            Ok(format!(
                "Updated standalone work item '{}' [{}]",
                item.frontmatter.title, short_id
            ))
        })
        .await
        .map_err(ToolError::ExecutionFailed)
    }

    async fn delete_standalone_work_item(short_id: String) -> Result<String, ToolError> {
        run_blocking("delete_standalone_work_item", move || {
            let mut item = io::read_standalone_work_item(None, &short_id)?;
            let now = chrono::Utc::now().to_rfc3339();
            item.frontmatter.deleted_at = Some(now.clone());
            item.frontmatter.updated_at = now;
            io::write_standalone_work_item(None, &short_id, &item.frontmatter, &item.body)?;
            Ok(format!("Deleted standalone work item [{}]", short_id))
        })
        .await
        .map_err(ToolError::ExecutionFailed)
    }

    async fn link_session(
        &self,
        scope: WorkItemScope,
        short_id: String,
        params: Value,
    ) -> Result<String, ToolError> {
        match scope {
            WorkItemScope::Project(project_slug) => {
                let session_id = self.session_id.clone();
                run_blocking("link_project_work_item_session", move || {
                    let mut linked_session_id = String::new();
                    io::update_work_item_atomic(&project_slug, &short_id, |fm, _body| {
                        let tool = WorkItemTool::new(session_id.clone());
                        linked_session_id = tool
                            .link_session_to_frontmatter(fm, &params)
                            .map_err(|err| err.to_string())?;
                        Ok(())
                    })?;
                    Ok(format!(
                        "Linked session {} to work item [{}]",
                        linked_session_id, short_id
                    ))
                })
                .await
                .map_err(ToolError::ExecutionFailed)
            }
            WorkItemScope::Standalone => {
                let session_id = self.session_id.clone();
                run_blocking("link_standalone_work_item_session", move || {
                    let mut item = io::read_standalone_work_item(None, &short_id)?;
                    let tool = WorkItemTool::new(session_id);
                    let linked_session_id = tool
                        .link_session_to_frontmatter(&mut item.frontmatter, &params)
                        .map_err(|err| err.to_string())?;
                    io::write_standalone_work_item(None, &short_id, &item.frontmatter, &item.body)?;
                    Ok(format!(
                        "Linked session {} to standalone work item [{}]",
                        linked_session_id, short_id
                    ))
                })
                .await
                .map_err(ToolError::ExecutionFailed)
            }
        }
    }

    async fn unlink_session(
        &self,
        scope: WorkItemScope,
        short_id: String,
        params: Value,
    ) -> Result<String, ToolError> {
        match scope {
            WorkItemScope::Project(project_slug) => {
                let session_id = self.session_id.clone();
                run_blocking("unlink_project_work_item_session", move || {
                    let mut unlinked_session_id = String::new();
                    io::update_work_item_atomic(&project_slug, &short_id, |fm, _body| {
                        let tool = WorkItemTool::new(session_id.clone());
                        unlinked_session_id = tool.unlink_session_from_frontmatter(fm, &params);
                        Ok(())
                    })?;
                    Ok(format!(
                        "Unlinked session {} from work item [{}]",
                        unlinked_session_id, short_id
                    ))
                })
                .await
                .map_err(ToolError::ExecutionFailed)
            }
            WorkItemScope::Standalone => {
                let session_id = self.session_id.clone();
                run_blocking("unlink_standalone_work_item_session", move || {
                    let mut item = io::read_standalone_work_item(None, &short_id)?;
                    let tool = WorkItemTool::new(session_id);
                    let unlinked_session_id =
                        tool.unlink_session_from_frontmatter(&mut item.frontmatter, &params);
                    io::write_standalone_work_item(None, &short_id, &item.frontmatter, &item.body)?;
                    Ok(format!(
                        "Unlinked session {} from standalone work item [{}]",
                        unlinked_session_id, short_id
                    ))
                })
                .await
                .map_err(ToolError::ExecutionFailed)
            }
        }
    }
}

#[async_trait]
impl Tool for WorkItemTool {
    fn name(&self) -> &str {
        tool_names::MANAGE_WORK_ITEM
    }

    fn category(&self) -> &str {
        crate::tools::categories::PROJECT
    }

    fn description(&self) -> &str {
        "Manage standalone or project-scoped work items, including linking the current chat session."
    }

    fn llm_description(&self) -> Option<String> {
        Some(
            "Manage work items (tasks, issues, bugs) in the global project store. Omit project_slug for standalone work items. \
             Supports: list, read, create, update, delete, start, add_delegation, link_session, unlink_session, batch. \
             Use batch for multiple Work Items and put project_slug on each item when operations target different Projects. \
             Use link_session to attach the current chat/session to an existing work item; create may be used first."
                .to_string(),
        )
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "The operation to perform.",
                    "enum": ["list", "read", "create", "update", "delete", "start", "add_delegation", "link_session", "unlink_session", "batch"]
                },
                "project_slug": {
                    "type": "string",
                    "description": "Optional project identifier. Omit for standalone Work Items that are not bound to a Project."
                },
                "short_id": {
                    "type": "string",
                    "description": "Work item short ID, e.g. 'ORG-0001' or project-prefixed ID (for read, update, delete, link_session, unlink_session). Use list first to discover IDs."
                },
                "session_id": {
                    "type": "string",
                    "description": "Session ID to link/unlink. Defaults to the current chat/session."
                },
                "session_status": {
                    "type": "string",
                    "enum": ["running", "completed", "failed", "cancelled"],
                    "description": "Status for link_session. Defaults to running."
                },
                "agent_role": {
                    "type": "string",
                    "enum": ["coding", "review", "orchestrator", "custom", "sub_agent"],
                    "description": "Role for the linked session. Defaults to custom for chat-panel links."
                },
                "title": { "type": "string", "description": "Work item title (required for create, optional for update)" },
                "description": { "type": "string", "description": "Work item body/description (markdown)" },
                "project": { "type": "string", "description": "Project reference stored in frontmatter metadata." },
                "status": { "type": "string", "enum": ["backlog", "planned", "in_progress", "in_review", "completed", "cancelled"] },
                "priority": { "type": "string", "enum": ["urgent", "high", "medium", "low", "none"] },
                "assignee": { "type": "string", "description": "Member ID to assign this work item to. Pass empty string to unassign." },
                "labels": { "type": "array", "items": { "type": "string" } },
                "milestone": { "type": "string", "description": "Milestone ID. Pass empty string to clear." },
                "parent": { "type": "string", "description": "Parent work item short ID. Pass empty string to clear." },
                "start_date": { "type": "string", "description": "Start date (ISO 8601). Pass empty string to clear." },
                "target_date": { "type": "string", "description": "Target/due date (ISO 8601). Pass empty string to clear." },
                "starred": { "type": "boolean" },
                "todos": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": { "type": "string" },
                            "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
                        },
                        "required": ["content"]
                    }
                },
                "selected_account_id": { "type": "string" },
                "selected_model_id": { "type": "string" },
                "sub_agent_ids": { "type": "array", "items": { "type": "string" } },
                "org_id": { "type": "string" },
                "agent_definition_id": { "type": "string" },
                "delegation": {
                    "type": "object",
                    "properties": {
                        "task_id": { "type": "string" },
                        "agent_app_id": { "type": "string" },
                        "agent_app_name": { "type": "string" },
                        "skill_id": { "type": "string" },
                        "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "failed", "cancelled"] },
                        "cost_usd": { "type": "number" }
                    }
                },
                "schedule": {
                    "type": "object",
                    "properties": {
                        "at": { "type": "string" },
                        "cron": { "type": "string" },
                        "enabled": { "type": "boolean" }
                    }
                },
                "items": {
                    "type": "array",
                    "description": "Batch operations. Each item is a manage_work_item parameter object with its own action. Parent project_slug/session_status/agent_role are inherited when omitted; item project_slug overrides parent for multi-project batches.",
                    "items": { "type": "object" }
                }
            },
            "required": ["action"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let action = required_string(&params, "action")?;
        if action == "batch" {
            return self.execute_batch(&params, _ctx).await;
        }
        let scope = Self::resolve_scope(&params)?;

        match action.as_str() {
            "list" => match scope {
                WorkItemScope::Project(project_slug) => crate::tool_infra::list_work_items(&project_slug)
                    .await
                    .map_err(ToolError::ExecutionFailed),
                WorkItemScope::Standalone => Self::list_standalone_work_items().await,
            },
            "read" => {
                let short_id = required_string(&params, "short_id")?;
                match scope {
                    WorkItemScope::Project(project_slug) => {
                        crate::tool_infra::read_work_item(&project_slug, &short_id)
                            .await
                            .map_err(ToolError::ExecutionFailed)
                    }
                    WorkItemScope::Standalone => Self::read_standalone_work_item(short_id).await,
                }
            }
            "create" => match scope {
                WorkItemScope::Project(project_slug) => {
                    let title = required_string(&params, "title")?;
                    crate::tool_infra::create_work_item(
                        &project_slug,
                        &title,
                        optional_string(&params, "description").unwrap_or_default().as_str(),
                        optional_string(&params, "project")
                            .as_deref()
                            .or(Some(project_slug.as_str())),
                        optional_string(&params, "status").as_deref(),
                        optional_string(&params, "priority").as_deref(),
                        optional_string(&params, "assignee").as_deref(),
                        None,
                        Self::optional_string_array(&params, "labels"),
                        optional_string(&params, "milestone").as_deref(),
                        optional_string(&params, "parent").as_deref(),
                        optional_string(&params, "start_date").as_deref(),
                        optional_string(&params, "target_date").as_deref(),
                        optional_bool(&params, "starred"),
                        Self::optional_todos(&params),
                        Self::orchestrator_overrides_from_params(&params),
                        Self::parse_schedule(&params),
                    )
                    .await
                    .map_err(ToolError::ExecutionFailed)
                }
                WorkItemScope::Standalone => Self::create_standalone_work_item(params).await,
            },
            "update" => {
                let short_id = required_string(&params, "short_id")?;
                match scope {
                    WorkItemScope::Project(project_slug) => {
                        crate::tool_infra::update_work_item(
                            &project_slug,
                            &short_id,
                            optional_string(&params, "title").as_deref(),
                            optional_string(&params, "description").as_deref(),
                            optional_string(&params, "project").as_deref(),
                            optional_string(&params, "status").as_deref(),
                            optional_string(&params, "priority").as_deref(),
                            optional_string(&params, "assignee").as_deref(),
                            None,
                            Self::optional_string_array(&params, "labels"),
                            optional_string(&params, "milestone").as_deref(),
                            optional_string(&params, "parent").as_deref(),
                            optional_string(&params, "start_date").as_deref(),
                            optional_string(&params, "target_date").as_deref(),
                            optional_bool(&params, "starred"),
                            Self::optional_todos(&params),
                            Self::orchestrator_overrides_from_params(&params),
                            Self::parse_schedule(&params),
                        )
                        .await
                        .map_err(ToolError::ExecutionFailed)
                    }
                    WorkItemScope::Standalone => Self::update_standalone_work_item(short_id, params).await,
                }
            }
            "delete" => {
                let short_id = required_string(&params, "short_id")?;
                match scope {
                    WorkItemScope::Project(project_slug) => {
                        crate::tool_infra::delete_work_item(&project_slug, &short_id)
                            .await
                            .map_err(ToolError::ExecutionFailed)
                    }
                    WorkItemScope::Standalone => Self::delete_standalone_work_item(short_id).await,
                }
            }
            "start" => {
                let short_id = required_string(&params, "short_id")?;
                match scope {
                    WorkItemScope::Project(project_slug) => {
                        let app = self.app_handle.as_ref().ok_or_else(|| {
                            ToolError::ExecutionFailed(
                                "start requires app_handle (not available in this context)".to_string(),
                            )
                        })?;
                        crate::tool_infra::start_work_item(
                            &project_slug,
                            &short_id,
                            app,
                            self.session_account_id.as_deref().filter(|s| !s.is_empty()),
                            Some(self.agent_model.as_str()).filter(|s| !s.trim().is_empty()),
                        )
                        .await
                        .map_err(ToolError::ExecutionFailed)
                    }
                    WorkItemScope::Standalone => Err(ToolError::InvalidParams(
                        "start currently requires project_slug; bind or move the standalone Work Item into a Project first".to_string(),
                    )),
                }
            }
            "link_session" => {
                let short_id = required_string(&params, "short_id")?;
                self.link_session(scope, short_id, params).await
            }
            "unlink_session" => {
                let short_id = required_string(&params, "short_id")?;
                self.unlink_session(scope, short_id, params).await
            }
            "add_delegation" => {
                let WorkItemScope::Project(project_slug) = scope else {
                    return Err(ToolError::InvalidParams(
                        "add_delegation currently requires project_slug because delegation history is project-scoped"
                            .to_string(),
                    ));
                };
                let short_id = required_string(&params, "short_id")?;
                let delegation_params = params.get("delegation").ok_or_else(|| {
                    ToolError::InvalidParams("delegation object is required for add_delegation".to_string())
                })?;
                let task_id = delegation_params["task_id"].as_str().ok_or_else(|| {
                    ToolError::InvalidParams("delegation.task_id is required".to_string())
                })?;
                let agent_app_id = delegation_params["agent_app_id"].as_str().ok_or_else(|| {
                    ToolError::InvalidParams("delegation.agent_app_id is required".to_string())
                })?;
                let agent_app_name = delegation_params["agent_app_name"]
                    .as_str()
                    .unwrap_or("Unknown Agent");
                let skill_id = delegation_params["skill_id"].as_str().ok_or_else(|| {
                    ToolError::InvalidParams("delegation.skill_id is required".to_string())
                })?;
                let status = delegation_params["status"].as_str().unwrap_or("pending");
                let cost_usd = delegation_params["cost_usd"].as_f64().unwrap_or(0.0);

                io::update_work_item_atomic(&project_slug, &short_id, |frontmatter, _body| {
                    let entry = project_management::projects::types::DelegationEntry {
                        task_id: task_id.to_string(),
                        agent_app_id: agent_app_id.to_string(),
                        agent_app_name: agent_app_name.to_string(),
                        skill_id: skill_id.to_string(),
                        status: status.to_string(),
                        cost_usd,
                        created_at: chrono::Utc::now().to_rfc3339(),
                        completed_at: None,
                    };
                    frontmatter.delegations.push(entry);
                    frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
                    Ok(())
                })
                .map_err(ToolError::ExecutionFailed)?;

                Ok(format!(
                    "Delegation added to work item {}: task_id={}, agent={} ({}), skill={}, status={}",
                    short_id, task_id, agent_app_name, agent_app_id, skill_id, status
                ))
            }
            _ => Err(ToolError::InvalidParams(format!(
                "Unknown work_item action: '{}'. Valid actions: list, read, create, update, delete, start, add_delegation, link_session, unlink_session, batch",
                action
            ))),
        }
    }
}
