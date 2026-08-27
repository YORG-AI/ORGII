use crate::projects::io as project_io;
use crate::projects::types::WorkItemFrontmatter;

/// Result of projecting a successful execution episode onto the human-owned
/// Work Item lifecycle. A successful Run is ready for verification, not
/// automatically accepted as completed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunSuccessReviewProjection {
    Transitioned,
    AlreadyInReview,
    PreservedStatus,
    Superseded,
}

const RUN_REVIEW_ALREADY: &str = "PM_RUN_REVIEW:ALREADY_IN_REVIEW";
const RUN_REVIEW_PRESERVE: &str = "PM_RUN_REVIEW:PRESERVE_STATUS";
const RUN_REVIEW_SUPERSEDED: &str = "PM_RUN_REVIEW:SUPERSEDED";

fn apply_run_success_review_projection(
    frontmatter: &mut WorkItemFrontmatter,
    terminal_session_id: Option<&str>,
) -> Result<(), String> {
    if let Some(lock) = frontmatter.execution_lock.as_ref() {
        match (lock.active_session_id.as_deref(), terminal_session_id) {
            (Some(active), Some(terminal)) if active == terminal => {}
            // A newer Session or an Agent Org still owns execution. A stale
            // terminal must not move the Work Item out from under it.
            _ => return Err(RUN_REVIEW_SUPERSEDED.to_string()),
        }
    }

    match frontmatter.status.as_str() {
        "backlog" | "planned" | "in_progress" => {
            frontmatter.status = "in_review".to_string();
            frontmatter.execution_lock = None;
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        }
        "in_review" => Err(RUN_REVIEW_ALREADY.to_string()),
        // Completed/cancelled items are explicit human decisions. Provider
        // statuses and custom workflow states retain their native semantics.
        _ => Err(RUN_REVIEW_PRESERVE.to_string()),
    }
}

fn review_projection_outcome(error: String) -> Result<RunSuccessReviewProjection, String> {
    match error.as_str() {
        RUN_REVIEW_ALREADY => Ok(RunSuccessReviewProjection::AlreadyInReview),
        RUN_REVIEW_PRESERVE => Ok(RunSuccessReviewProjection::PreservedStatus),
        RUN_REVIEW_SUPERSEDED => Ok(RunSuccessReviewProjection::Superseded),
        _ => Err(error),
    }
}

/// Move a successfully executed native Work Item into `in_review` through
/// the canonical atomic mutation path.
pub fn project_run_success_to_review(
    project_slug: Option<&str>,
    org_id: &str,
    short_id: &str,
    terminal_session_id: Option<&str>,
) -> Result<RunSuccessReviewProjection, String> {
    let terminal_session_id = terminal_session_id.map(str::to_string);
    let mutation = match project_slug {
        Some(project_slug) => project_io::update_work_item_atomic_serviced(
            project_slug,
            short_id,
            None,
            project_io::AtomicServiceOptions {
                operation: Some("work.run_succeeded"),
                strict_fsm: true,
                reason: Some("execution succeeded; awaiting review".to_string()),
                ..Default::default()
            },
            move |frontmatter, _body| {
                apply_run_success_review_projection(frontmatter, terminal_session_id.as_deref())
            },
        ),
        None => project_io::update_standalone_work_item_atomic_serviced(
            Some(org_id),
            None,
            project_io::AtomicServiceOptions {
                operation: Some("work.run_succeeded"),
                strict_fsm: true,
                reason: Some("execution succeeded; awaiting review".to_string()),
                ..Default::default()
            },
            short_id,
            move |frontmatter, _body| {
                apply_run_success_review_projection(frontmatter, terminal_session_id.as_deref())
            },
        ),
    };

    match mutation {
        Ok(()) => {
            crate::projects::events::notify_data_changed();
            Ok(RunSuccessReviewProjection::Transitioned)
        }
        Err(error) => review_projection_outcome(error),
    }
}
