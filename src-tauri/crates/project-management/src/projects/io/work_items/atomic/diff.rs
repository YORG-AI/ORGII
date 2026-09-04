//! Change detection for the atomic RMW: the sync-tracked field set, the
//! pre/post-mutation diff, the payload-tail fingerprint, and the outbox
//! payload projection.

use crate::projects::types::{WorkItemData, WorkItemFrontmatter, WorkItemPartialUpdate};

/// Sync-relevant fields whose mutations are tracked in
/// `workitem_extras.field_revisions`. The names match
/// [`crate::sync::adapter::EntityField::as_local_name`]
/// so the resolver and the stamper agree on identity. Fields outside
/// this set are local-only (e.g. `todos`, `comments`, `starred`) and
/// never compared against external watermarks.
///
/// This constant is currently consumed only as documentation —
/// [`SyncFieldSnapshot::diff`] inlines the same field set so the
/// per-field comparison can pull from the typed frontmatter instead
/// of going through string lookups. The list is kept here as the
/// canonical reference; if you add a field, update both.
#[allow(dead_code)]
pub(super) const SYNC_TRACKED_FIELDS: &[&str] = &[
    "title",
    "body",
    "status",
    "priority",
    "assignee",
    "milestone",
    "start_date",
    "target_date",
    "labels",
];

/// Serialized snapshot of every field that rides only in the collab
/// server's payload jsonb (design §16.3) — i.e. outside the
/// sync-tracked hot-field set — used to detect tail-only mutations in
/// the closure-form atomic path. `history` is deliberately excluded:
/// the history append accompanies every real change (and would make
/// no-op mutators look like changes once `append_mutation_event`
/// fires for the accompanying field).
pub(super) fn payload_tail_fingerprint(fm: &WorkItemFrontmatter) -> serde_json::Value {
    serde_json::json!({
        "project": fm.project,
        "parent": fm.parent,
        "stage": fm.stage,
        "assignee_type": fm.assignee_type,
        "starred": fm.starred,
        "created_by": fm.created_by,
        "origin_session": fm.origin_session,
        "todos": fm.todos,
        "comments": fm.comments,
        "handoff": fm.handoff,
        "linked_sessions": fm.linked_sessions,
        "proof_of_work": fm.proof_of_work,
        "orchestrator_config": fm.orchestrator_config,
        "orchestrator_state": fm.orchestrator_state,
        "schedule": fm.schedule,
        "execution_lock": fm.execution_lock,
        "close_out": fm.close_out,
        "work_products": fm.work_products,
    })
}

/// True when the patch touches any field that lives only in the server
/// payload jsonb (outside the sync-tracked field set).
pub(super) fn touches_payload_tail(updates: &WorkItemPartialUpdate) -> bool {
    updates.todos.is_some()
        || updates.comments.is_some()
        || updates.handoff.is_some()
        || updates.linked_sessions.is_some()
        || updates.orchestrator_config.is_some()
        || updates.orchestrator_state.is_some()
        || updates.schedule.is_some()
        || updates.execution_lock.is_some()
        || updates.close_out.is_some()
        || updates.work_products.is_some()
        || updates.starred.is_some()
        || updates.assignee_type.is_some()
        || updates.project.is_some()
        || updates.created_by.is_some()
        || updates.stage.is_some()
}

/// Build the JSON payload that gets persisted to
/// `outbox_entries.payload_json` for an `update` row. Includes every
/// changed sync-tracked field's post-mutation value so the adapter
/// doesn't have to round-trip the work item to push.
pub(super) fn changed_fields_payload(
    data: &WorkItemData,
    changed_fields: &[&'static str],
) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    for field in changed_fields {
        let value = match *field {
            "title" => serde_json::Value::String(data.frontmatter.title.clone()),
            "body" => serde_json::Value::String(data.body.clone()),
            "status" => serde_json::Value::String(data.frontmatter.status.clone()),
            "priority" => serde_json::Value::String(data.frontmatter.priority.clone()),
            "assignee" => match data.frontmatter.assignee.as_ref() {
                Some(value) => serde_json::Value::String(value.clone()),
                None => serde_json::Value::Null,
            },
            "milestone" => match data.frontmatter.milestone.as_ref() {
                Some(value) => serde_json::Value::String(value.clone()),
                None => serde_json::Value::Null,
            },
            "start_date" => match data.frontmatter.start_date.as_ref() {
                Some(value) => serde_json::Value::String(value.clone()),
                None => serde_json::Value::Null,
            },
            "target_date" => match data.frontmatter.target_date.as_ref() {
                Some(value) => serde_json::Value::String(value.clone()),
                None => serde_json::Value::Null,
            },
            "labels" => serde_json::Value::Array(
                data.frontmatter
                    .labels
                    .iter()
                    .map(|label| serde_json::Value::String(label.clone()))
                    .collect(),
            ),
            // Defensive — if a future field name lands in `changed_fields`
            // before the payload helper learns it, drop the field from
            // the payload rather than crash. The outbox row will still
            // record it via `field_path`.
            _ => continue,
        };
        object.insert((*field).to_string(), value);
    }
    serde_json::Value::Object(object)
}

// ---------------------------------------------------------------------
// Internal helpers (kept private to this file)
// ---------------------------------------------------------------------

/// Snapshot of every sync-tracked field's value before the mutator
/// runs. Used to compute the changed-fields list once the mutator
/// returns. We clone the values rather than holding references because
/// the frontmatter is itself mutated in place, and we want a stable
/// "before" view to diff against.
pub(super) struct SyncFieldSnapshot {
    title: String,
    body: String,
    status: String,
    priority: String,
    assignee: Option<String>,
    milestone: Option<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    labels: Vec<String>,
}

impl SyncFieldSnapshot {
    pub(super) fn capture(fm: &WorkItemFrontmatter, body: &str) -> Self {
        Self {
            title: fm.title.clone(),
            body: body.to_string(),
            status: fm.status.clone(),
            priority: fm.priority.clone(),
            assignee: fm.assignee.clone(),
            milestone: fm.milestone.clone(),
            start_date: fm.start_date.clone(),
            target_date: fm.target_date.clone(),
            labels: fm.labels.clone(),
        }
    }

    /// Returns the canonical names of every sync-tracked field whose
    /// post-mutation value differs from the captured value. Order
    /// matches [`SYNC_TRACKED_FIELDS`] so callers see a stable
    /// iteration sequence (useful in tests and outbox payload logs).
    pub(super) fn diff(&self, fm: &WorkItemFrontmatter, body: &str) -> Vec<&'static str> {
        let mut changed = Vec::new();
        if self.title != fm.title {
            changed.push("title");
        }
        if self.body != body {
            changed.push("body");
        }
        if self.status != fm.status {
            changed.push("status");
        }
        if self.priority != fm.priority {
            changed.push("priority");
        }
        if self.assignee != fm.assignee {
            changed.push("assignee");
        }
        if self.milestone != fm.milestone {
            changed.push("milestone");
        }
        if self.start_date != fm.start_date {
            changed.push("start_date");
        }
        if self.target_date != fm.target_date {
            changed.push("target_date");
        }
        if !slices_equal_unordered(&self.labels, &fm.labels) {
            changed.push("labels");
        }
        changed
    }
}

/// Compare two label slices ignoring order. Labels are persisted as a
/// set in `workitem_labels`, so a permutation isn't a real change.
fn slices_equal_unordered(left: &[String], right: &[String]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut left_sorted = left.to_vec();
    let mut right_sorted = right.to_vec();
    left_sorted.sort();
    right_sorted.sort();
    left_sorted == right_sorted
}
