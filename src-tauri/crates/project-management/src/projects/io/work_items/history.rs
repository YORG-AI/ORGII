use serde::Serialize;
use serde_json::Value as JsonValue;

use crate::projects::types::{
    CommentEntry, WorkItemFrontmatter, WorkItemHistoryAction, WorkItemHistoryChange,
    WorkItemHistoryEvent, WorkItemMutationActor,
};

pub(super) fn ensure_created_event(frontmatter: &mut WorkItemFrontmatter, timestamp: &str) {
    if frontmatter
        .history
        .iter()
        .any(|event| event.action == WorkItemHistoryAction::Created)
    {
        return;
    }

    frontmatter.history.insert(
        0,
        WorkItemHistoryEvent {
            id: history_event_id(frontmatter, WorkItemHistoryAction::Created, timestamp),
            action: WorkItemHistoryAction::Created,
            timestamp: timestamp.to_string(),
            actor_id: frontmatter.created_by.clone(),
            actor_name: frontmatter.created_by.clone(),
            changes: Vec::new(),
            summary: Some("Created item".to_string()),
        },
    );
}

pub(super) fn append_deleted_event(frontmatter: &mut WorkItemFrontmatter, timestamp: &str) {
    frontmatter.history.push(WorkItemHistoryEvent {
        id: history_event_id(frontmatter, WorkItemHistoryAction::Deleted, timestamp),
        action: WorkItemHistoryAction::Deleted,
        timestamp: timestamp.to_string(),
        actor_id: None,
        actor_name: None,
        changes: Vec::new(),
        summary: Some("Deleted item".to_string()),
    });
}

pub(super) fn append_restored_event(frontmatter: &mut WorkItemFrontmatter, timestamp: &str) {
    frontmatter.history.push(WorkItemHistoryEvent {
        id: history_event_id(frontmatter, WorkItemHistoryAction::Restored, timestamp),
        action: WorkItemHistoryAction::Restored,
        timestamp: timestamp.to_string(),
        actor_id: None,
        actor_name: None,
        changes: Vec::new(),
        summary: Some("Restored item".to_string()),
    });
}

pub(super) fn append_mutation_event(
    before: &WorkItemHistorySnapshot,
    frontmatter: &mut WorkItemFrontmatter,
    body: &str,
    timestamp: &str,
    actor: Option<&WorkItemMutationActor>,
) {
    let mut changes = before.diff(frontmatter, body);
    if changes.is_empty() {
        return;
    }

    let action = if changes.len() == 1 && changes[0].field == "comments" {
        match appended_comment(&before.comments, &frontmatter.comments) {
            Some(comment) => {
                changes = vec![WorkItemHistoryChange {
                    field: "comments".to_string(),
                    old_value: JsonValue::Null,
                    new_value: to_json_value(comment),
                }];
                WorkItemHistoryAction::Commented
            }
            None => WorkItemHistoryAction::Updated,
        }
    } else if changes.len() == 1 && changes[0].field == "project" {
        WorkItemHistoryAction::Moved
    } else {
        WorkItemHistoryAction::Updated
    };

    let summary = match &action {
        WorkItemHistoryAction::Commented => Some("Commented".to_string()),
        WorkItemHistoryAction::Moved => Some("Moved project".to_string()),
        WorkItemHistoryAction::Updated => Some(format!("Updated {} fields", changes.len())),
        WorkItemHistoryAction::Created
        | WorkItemHistoryAction::Deleted
        | WorkItemHistoryAction::Restored => None,
    };

    let actor_id = actor
        .map(|value| value.id.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let actor_name = actor
        .map(|value| value.name.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    frontmatter.history.push(WorkItemHistoryEvent {
        id: history_event_id(frontmatter, action.clone(), timestamp),
        action,
        timestamp: timestamp.to_string(),
        actor_id,
        actor_name,
        changes,
        summary,
    });
}

#[derive(Debug, Clone)]
pub(super) struct WorkItemHistorySnapshot {
    title: String,
    body: String,
    status: String,
    priority: String,
    project: Option<String>,
    assignee: Option<String>,
    assignee_type: Option<String>,
    labels: Vec<String>,
    milestone: Option<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    todos: Vec<crate::projects::types::TodoEntry>,
    comments: Vec<CommentEntry>,
    handoff: Option<crate::projects::types::WorkItemHandoff>,
    schedule: Option<crate::projects::types::WorkItemSchedule>,
    orchestrator_config: Option<crate::projects::types::OrchestratorConfig>,
}

impl WorkItemHistorySnapshot {
    pub(super) fn capture(frontmatter: &WorkItemFrontmatter, body: &str) -> Self {
        Self {
            title: frontmatter.title.clone(),
            body: body.to_string(),
            status: frontmatter.status.clone(),
            priority: frontmatter.priority.clone(),
            project: frontmatter.project.clone(),
            assignee: frontmatter.assignee.clone(),
            assignee_type: frontmatter.assignee_type.clone(),
            labels: normalized_strings(&frontmatter.labels),
            milestone: frontmatter.milestone.clone(),
            start_date: frontmatter.start_date.clone(),
            target_date: frontmatter.target_date.clone(),
            todos: frontmatter.todos.clone(),
            comments: frontmatter.comments.clone(),
            handoff: frontmatter.handoff.clone(),
            schedule: frontmatter.schedule.clone(),
            orchestrator_config: frontmatter.orchestrator_config.clone(),
        }
    }

    fn diff(&self, frontmatter: &WorkItemFrontmatter, body: &str) -> Vec<WorkItemHistoryChange> {
        let mut changes = Vec::new();
        push_change(&mut changes, "title", &self.title, &frontmatter.title);
        push_change(&mut changes, "body", &self.body, &body.to_string());
        push_change(&mut changes, "status", &self.status, &frontmatter.status);
        push_change(
            &mut changes,
            "priority",
            &self.priority,
            &frontmatter.priority,
        );
        push_change(&mut changes, "project", &self.project, &frontmatter.project);
        push_change(
            &mut changes,
            "assignee",
            &self.assignee,
            &frontmatter.assignee,
        );
        push_change(
            &mut changes,
            "assigneeType",
            &self.assignee_type,
            &frontmatter.assignee_type,
        );

        let next_labels = normalized_strings(&frontmatter.labels);
        push_change(&mut changes, "labels", &self.labels, &next_labels);
        push_change(
            &mut changes,
            "milestone",
            &self.milestone,
            &frontmatter.milestone,
        );
        push_change(
            &mut changes,
            "startDate",
            &self.start_date,
            &frontmatter.start_date,
        );
        push_change(
            &mut changes,
            "targetDate",
            &self.target_date,
            &frontmatter.target_date,
        );
        push_change(&mut changes, "todos", &self.todos, &frontmatter.todos);
        push_change(
            &mut changes,
            "comments",
            &self.comments,
            &frontmatter.comments,
        );
        push_change(&mut changes, "handoff", &self.handoff, &frontmatter.handoff);
        push_change(
            &mut changes,
            "schedule",
            &self.schedule,
            &frontmatter.schedule,
        );
        push_change(
            &mut changes,
            "orchestratorConfig",
            &self.orchestrator_config,
            &frontmatter.orchestrator_config,
        );
        changes
    }
}

fn push_change<T: Serialize + PartialEq>(
    changes: &mut Vec<WorkItemHistoryChange>,
    field: &str,
    old_value: &T,
    new_value: &T,
) {
    if old_value == new_value {
        return;
    }

    changes.push(WorkItemHistoryChange {
        field: field.to_string(),
        old_value: to_json_value(old_value),
        new_value: to_json_value(new_value),
    });
}

fn appended_comment<'a>(
    before: &[CommentEntry],
    after: &'a [CommentEntry],
) -> Option<&'a CommentEntry> {
    if after.len() != before.len().saturating_add(1) {
        return None;
    }
    if before
        .iter()
        .zip(after.iter())
        .all(|(left, right)| left == right)
    {
        after.last()
    } else {
        None
    }
}

fn normalized_strings(values: &[String]) -> Vec<String> {
    let mut next = values.to_vec();
    next.sort();
    next
}

fn to_json_value<T: Serialize>(value: &T) -> JsonValue {
    serde_json::to_value(value).expect("work item history values must serialize")
}

fn history_event_id(
    frontmatter: &WorkItemFrontmatter,
    action: WorkItemHistoryAction,
    timestamp: &str,
) -> String {
    format!(
        "{}-{:?}-{}-{}",
        frontmatter.short_id,
        action,
        timestamp.replace([':', '.', 'Z'], ""),
        frontmatter.history.len().saturating_add(1)
    )
}
