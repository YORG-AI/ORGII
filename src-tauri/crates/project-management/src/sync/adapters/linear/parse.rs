//! Pure mapping helpers between Linear's GraphQL shape and the
//! adapter's canonical wire types ([`super::super::adapter::ExternalChange`]
//! and the `IssueUpdateInput` variables sent on push).
//!
//! Kept in its own module so it's testable without spinning up an HTTP
//! server: every function is `Value -> Value` or `Value -> ExternalChange`.

use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};

use crate::sync::adapter::ExternalChange;
use crate::sync::types::{EntityType, OutboxEntry, OutboxOp};

/// GraphQL query used by the pull cycle. Asks for issues the
/// `(project_slug, adapter)` config is bound to, sorted oldest-first
/// so the adapter can advance its cursor monotonically.
///
/// Pagination uses `first: 50` + `after: $cursor`; the worker fans
/// the loop until `pageInfo.hasNextPage` is false.
pub const LINEAR_PULL_QUERY: &str = r#"
query OrgiiPull($filter: IssueFilter, $cursor: String) {
  issues(first: 50, after: $cursor, filter: $filter, orderBy: updatedAt) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      title
      description
      priority
      estimate
      startedAt
      dueDate
      updatedAt
      archivedAt
      state { id name type }
      assignee { id name }
      labels { nodes { id name } }
    }
  }
}
"#;

/// GraphQL mutation used by `push` for `OutboxOp::Update` rows.
pub const LINEAR_UPDATE_MUTATION: &str = r#"
mutation OrgiiUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id identifier updatedAt }
  }
}
"#;

/// GraphQL mutation used by `push` for `OutboxOp::Create` rows.
pub const LINEAR_CREATE_MUTATION: &str = r#"
mutation OrgiiCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier updatedAt }
  }
}
"#;

/// GraphQL mutation used by `push` for `OutboxOp::Delete` rows.
///
/// Linear archives rather than hard-deletes; that matches the framework
/// rule "adapters that don't support delete archive".
pub const LINEAR_ARCHIVE_MUTATION: &str = r#"
mutation OrgiiArchive($id: String!) {
  issueArchive(id: $id) { success }
}
"#;

/// Translate one Linear `Issue` JSON node into an [`ExternalChange`].
///
/// Returns `Err` when the node is shaped wrong (missing `id`,
/// `updatedAt`, …) — caller should classify that as `SyncError::Permanent`
/// so the worker abandons the row instead of retrying forever.
fn normalize_linear_status(
    state_name: Option<&str>,
    state_type: Option<&str>,
) -> Option<&'static str> {
    if state_name
        .map(|name| name.trim().eq_ignore_ascii_case("duplicate"))
        .unwrap_or(false)
    {
        return Some("duplicate");
    }

    match state_type {
        Some("backlog") => Some("backlog"),
        Some("unstarted") => Some("planned"),
        Some("started") => Some("in_progress"),
        Some("completed") => Some("completed"),
        Some("canceled") | Some("cancelled") => Some("cancelled"),
        _ => None,
    }
}

pub fn parse_linear_issue(node: &Value) -> Result<ExternalChange, String> {
    let external_id = node
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Linear issue missing id".to_string())?
        .to_string();

    let updated_at_str = node
        .get("updatedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| "Linear issue missing updatedAt".to_string())?;
    let remote_updated_at: DateTime<Utc> = updated_at_str
        .parse()
        .map_err(|err| format!("Linear updatedAt unparseable ({}): {}", updated_at_str, err))?;

    let deleted = node
        .get("archivedAt")
        .map(|value| !value.is_null())
        .unwrap_or(false);

    let mut fields = Map::new();
    if let Some(title) = node.get("title").and_then(Value::as_str) {
        fields.insert("title".to_string(), json!(title));
    }
    if let Some(body) = node.get("description") {
        fields.insert("body".to_string(), body.clone());
    }
    if let Some(status) = normalize_linear_status(
        node.pointer("/state/name").and_then(Value::as_str),
        node.pointer("/state/type").and_then(Value::as_str),
    ) {
        fields.insert("status".to_string(), json!(status));
    }
    if let Some(prio) = node.get("priority").and_then(Value::as_f64) {
        // Linear documents priority as Float (0.0–4.0) but the
        // values are conceptually integer. Coerce here so the local
        // schema stays integer-typed.
        fields.insert("priority".to_string(), json!(prio as i64));
    }
    if let Some(estimate) = node.get("estimate").and_then(Value::as_f64) {
        fields.insert("estimate".to_string(), json!(estimate));
    }
    if let Some(start_date) = node.get("startedAt") {
        if !start_date.is_null() {
            fields.insert("start_date".to_string(), start_date.clone());
        }
    }
    if let Some(due_date) = node.get("dueDate") {
        if !due_date.is_null() {
            fields.insert("target_date".to_string(), due_date.clone());
        }
    }
    if let Some(assignee_name) = node.pointer("/assignee/name").and_then(Value::as_str) {
        fields.insert("assignee".to_string(), json!(assignee_name));
    }
    if let Some(label_nodes) = node.pointer("/labels/nodes").and_then(Value::as_array) {
        let labels: Vec<Value> = label_nodes
            .iter()
            .filter_map(|n| n.get("name").and_then(Value::as_str))
            .map(|name| json!(name))
            .collect();
        fields.insert("labels".to_string(), Value::Array(labels));
    }

    Ok(ExternalChange {
        entity_type: EntityType::WorkItem,
        external_id,
        // Identity-mapping is the resolver's job; pull rows surface
        // here and the resolver matches by external_id ↔
        // workitem_extras mapping at apply time.
        local_entity_id: None,
        fields: Value::Object(fields),
        remote_updated_at,
        deleted,
    })
}

/// Build the `IssueUpdateInput` GraphQL variable from a local
/// `WorkItemFrontmatter`-shaped JSON. Only fields the framework knows
/// how to map are written; unknown keys in `local` are dropped so we
/// never accidentally PATCH untracked Linear-side fields.
///
/// Works for both per-field outbox rows (where `local` is the single
/// changed field's value, keyed by [`OutboxEntry::field_path`]) and
/// whole-entity sync (where `local` is the full WorkItem snapshot).
pub fn build_issue_update_input(local: &Value) -> Value {
    let mut input = Map::new();
    // Symmetric with `parse_linear_issue`: skip `null` entries so we
    // never accidentally clear a remote field just because the local
    // payload omitted (or null'd) it. Callers who want to clear a
    // field send an explicit "" / 0 / false instead.
    if let Some(title) = local.get("title").and_then(Value::as_str) {
        input.insert("title".to_string(), json!(title));
    }
    if let Some(body) = local.get("body") {
        if !body.is_null() {
            input.insert("description".to_string(), body.clone());
        }
    }
    if let Some(prio) = local.get("priority").and_then(Value::as_i64) {
        input.insert("priority".to_string(), json!(prio));
    }
    if let Some(estimate) = local.get("estimate").and_then(Value::as_f64) {
        input.insert("estimate".to_string(), json!(estimate));
    }
    if let Some(start_date) = local.get("start_date") {
        if !start_date.is_null() {
            input.insert("startedAt".to_string(), start_date.clone());
        }
    }
    if let Some(target_date) = local.get("target_date") {
        if !target_date.is_null() {
            input.insert("dueDate".to_string(), target_date.clone());
        }
    }
    Value::Object(input)
}

/// Parse a Linear webhook envelope into a list of [`ExternalChange`]
/// rows.
///
/// Envelope shape (Linear v1):
/// ```json
/// {
///   "action": "create" | "update" | "remove",
///   "type": "Issue" | "Comment" | ...,
///   "data": { ...issue node... },
///   "url": "...",
///   "createdAt": "..."
/// }
/// ```
///
/// We currently handle `type == "Issue"` and ignore the rest so new
/// event categories Linear adds don't crash the listener. Issues
/// pass through [`parse_linear_issue`] for shape parity with the
/// pull path; the only extra wrinkle is `action == "remove"`, which
/// flips `deleted = true` even when the issue body has no
/// `archivedAt`.
pub fn parse_linear_webhook_payload(value: &Value) -> Result<Vec<ExternalChange>, String> {
    let envelope_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    if envelope_type != "Issue" {
        return Ok(Vec::new());
    }
    let action = value.get("action").and_then(Value::as_str).unwrap_or("");
    let data = value
        .get("data")
        .ok_or_else(|| "Linear webhook missing data".to_string())?;
    let mut change = parse_linear_issue(data)?;
    if action == "remove" {
        change.deleted = true;
    }
    Ok(vec![change])
}

/// Pull the JSON payload off one outbox row, defaulting to an empty
/// object so callers don't have to repeat the unwrap dance. Errors
/// when the row's `payload_json` is malformed JSON — that's a
/// permanent corruption, not a transient one.
pub fn payload_value(entry: &OutboxEntry) -> Result<Value, String> {
    if entry.payload_json.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(&entry.payload_json)
        .map_err(|err| format!("outbox payload not valid JSON: {}", err))
}

/// Discriminator used by `LinearAdapter::push` to pick the right
/// mutation. Kept as a free function so the adapter stays small.
pub fn op_to_mutation(op: OutboxOp) -> Result<&'static str, String> {
    match op {
        OutboxOp::Create => Ok(LINEAR_CREATE_MUTATION),
        OutboxOp::Update => Ok(LINEAR_UPDATE_MUTATION),
        OutboxOp::Delete => Ok(LINEAR_ARCHIVE_MUTATION),
        // `merge_external` rows are produced by the pull cycle; they
        // never hit the Linear adapter on the push path.
        OutboxOp::MergeExternal => {
            Err("merge_external rows are pull-side artifacts and must not be pushed".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue_node() -> Value {
        json!({
            "id": "lin-uuid-1",
            "identifier": "ENG-42",
            "title": "Implement Linear adapter",
            "description": "**body**",
            "priority": 2,
            "estimate": 3.0,
            "startedAt": "2026-04-29T00:00:00Z",
            "dueDate": "2026-05-15",
            "updatedAt": "2026-04-29T01:23:45.000Z",
            "archivedAt": null,
            "state": { "id": "st-1", "name": "In Progress", "type": "started" },
            "assignee": { "id": "u-1", "name": "Alice" },
            "labels": { "nodes": [
                { "id": "l-1", "name": "backend" },
                { "id": "l-2", "name": "p1" },
            ] }
        })
    }

    #[test]
    fn parse_full_issue_round_trip() {
        let change = parse_linear_issue(&issue_node()).unwrap();
        assert_eq!(change.external_id, "lin-uuid-1");
        assert_eq!(change.entity_type, EntityType::WorkItem);
        assert!(!change.deleted);
        assert_eq!(change.fields["title"], "Implement Linear adapter");
        assert_eq!(change.fields["status"], "in_progress");
        assert_eq!(change.fields["priority"], 2);
        assert_eq!(change.fields["estimate"], 3.0);
        assert_eq!(change.fields["assignee"], "Alice");
        assert_eq!(change.fields["labels"], json!(["backend", "p1"]));
    }

    #[test]
    fn parse_archived_issue_marks_deleted() {
        let mut node = issue_node();
        node["archivedAt"] = json!("2026-04-29T02:00:00Z");
        let change = parse_linear_issue(&node).unwrap();
        assert!(change.deleted);
    }

    #[test]
    fn parse_missing_id_errors() {
        let mut node = issue_node();
        node.as_object_mut().unwrap().remove("id");
        assert!(parse_linear_issue(&node).is_err());
    }

    #[test]
    fn parse_missing_updated_at_errors() {
        let mut node = issue_node();
        node.as_object_mut().unwrap().remove("updatedAt");
        assert!(parse_linear_issue(&node).is_err());
    }

    #[test]
    fn parse_skips_null_optional_fields() {
        let node = json!({
            "id": "lin-2",
            "title": "minimal",
            "updatedAt": "2026-04-29T00:00:00Z",
            "archivedAt": null,
        });
        let change = parse_linear_issue(&node).unwrap();
        assert_eq!(change.fields.get("status"), None);
        assert_eq!(change.fields.get("assignee"), None);
        assert_eq!(change.fields.get("labels"), None);
    }

    #[test]
    fn build_input_drops_unknown_keys() {
        let local = json!({
            "title": "T",
            "body": "B",
            "priority": 1,
            "ghost_field": "ignored",
        });
        let input = build_issue_update_input(&local);
        let obj = input.as_object().unwrap();
        assert_eq!(obj["title"], "T");
        assert_eq!(obj["description"], "B");
        assert_eq!(obj["priority"], 1);
        assert!(!obj.contains_key("ghost_field"));
    }

    #[test]
    fn op_to_mutation_rejects_merge_external() {
        assert!(op_to_mutation(OutboxOp::Create).is_ok());
        assert!(op_to_mutation(OutboxOp::Update).is_ok());
        assert!(op_to_mutation(OutboxOp::Delete).is_ok());
        assert!(op_to_mutation(OutboxOp::MergeExternal).is_err());
    }

    #[test]
    fn webhook_create_event_returns_one_change() {
        let envelope = json!({
            "action": "create",
            "type": "Issue",
            "data": issue_node(),
            "url": "https://linear.app/.../ENG-42",
            "createdAt": "2026-04-29T01:23:45.000Z",
        });
        let changes = parse_linear_webhook_payload(&envelope).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].external_id, "lin-uuid-1");
        assert!(!changes[0].deleted);
    }

    #[test]
    fn webhook_remove_event_marks_deleted() {
        let envelope = json!({
            "action": "remove",
            "type": "Issue",
            "data": issue_node(),
        });
        let changes = parse_linear_webhook_payload(&envelope).unwrap();
        assert_eq!(changes.len(), 1);
        assert!(changes[0].deleted);
    }

    #[test]
    fn webhook_non_issue_event_is_ignored() {
        let envelope = json!({
            "action": "create",
            "type": "Comment",
            "data": { "id": "c-1", "body": "hi" },
        });
        let changes = parse_linear_webhook_payload(&envelope).unwrap();
        assert!(changes.is_empty());
    }

    #[test]
    fn webhook_missing_data_errors() {
        let envelope = json!({ "action": "create", "type": "Issue" });
        assert!(parse_linear_webhook_payload(&envelope).is_err());
    }

    #[test]
    fn payload_value_handles_empty_string() {
        let entry = OutboxEntry {
            id: Some(1),
            project_slug: "alpha".into(),
            entity_type: EntityType::WorkItem,
            entity_id: "WI-1".into(),
            op: OutboxOp::Update,
            field_path: None,
            payload_json: String::new(),
            created_at: 0,
            retry_count: 0,
            last_attempted_at: None,
            last_error: None,
            status: crate::sync::types::OutboxStatus::InFlight,
        };
        assert_eq!(payload_value(&entry).unwrap(), json!({}));
    }
}
