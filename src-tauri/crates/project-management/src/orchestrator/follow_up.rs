//! Follow-up work item creation when review requests changes.

use crate::projects::io;
use crate::projects::types::{FollowUpRef, WorkItemFrontmatter};

/// Create a follow-up work item from review feedback.
///
/// 1. Allocates a new short ID
/// 2. Creates a new work item with parent = original short_id
/// 3. Copies orchestrator_config from parent
/// 4. Adds FollowUpRef to the parent's follow_up_items
///
/// Returns the new short ID.
pub fn create_follow_up(
    project_slug: &str,
    parent_short_id: &str,
    review_feedback: &str,
) -> Result<String, String> {
    let parent_data = io::read_work_item(project_slug, parent_short_id)?;
    let parent = &parent_data.frontmatter;

    let new_short_id = io::allocate_short_id(project_slug)?;
    let now = chrono::Utc::now().to_rfc3339();

    let title = format!("Follow-up: {} — address review feedback", parent.title);

    let new_frontmatter = WorkItemFrontmatter {
        id: new_short_id.clone(),
        short_id: new_short_id.clone(),
        title,
        project: parent.project.clone(),
        status: "backlog".to_string(),
        priority: parent.priority.clone(),
        assignee: parent.assignee.clone(),
        assignee_type: parent.assignee_type.clone(),
        labels: parent.labels.clone(),
        milestone: parent.milestone.clone(),
        parent: Some(parent_short_id.to_string()),
        stage: None,
        start_date: None,
        target_date: parent.target_date.clone(),
        created_by: Some("orchestrator".to_string()),
        origin_session: None,
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
        starred: false,
        todos: vec![],
        comments: vec![],
        history: vec![],
        delegations: vec![],
        handoff: None,
        linked_sessions: vec![],
        proof_of_work: None,
        orchestrator_config: parent.orchestrator_config.clone(),
        orchestrator_state: None,
        follow_up_items: vec![],
        schedule: None,
        routine_source: parent.routine_source.clone(),
        execution_lock: None,
        close_out: None,
        work_products: vec![],
    };

    let body = format!(
        "## Review Feedback\n\n{}\n\n---\n\nParent work item: {}\n",
        review_feedback, parent_short_id
    );

    io::write_work_item(project_slug, &new_short_id, &new_frontmatter, &body)?;

    // Add follow-up reference to the parent
    let mut parent_fm = parent_data.frontmatter.clone();
    parent_fm.follow_up_items.push(FollowUpRef {
        short_id: new_short_id.clone(),
        reason: Some("Review requested changes".to_string()),
    });
    parent_fm.updated_at = chrono::Utc::now().to_rfc3339();
    io::write_work_item(project_slug, parent_short_id, &parent_fm, &parent_data.body)?;

    Ok(new_short_id)
}
