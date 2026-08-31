use super::*;
use crate::projects::io::{FieldRevision, SyncMetadata};
use crate::projects::schema::init_outbox_conflicts_table;
use crate::sync::adapter::{EntityField, FieldMap, FieldMapping};
use chrono::{TimeZone, Utc};
use serde_json::json;

static TEST_FIELD_MAP: FieldMap = FieldMap {
    mappings: &[
        FieldMapping {
            local: EntityField::Title,
            remote: "title",
            writable: true,
        },
        FieldMapping {
            local: EntityField::Status,
            remote: "state",
            writable: true,
        },
        FieldMapping {
            local: EntityField::Assignee,
            remote: "assignee",
            writable: false, // read-only
        },
    ],
};

fn external_change(remote_mtime_ms: i64, fields: Value) -> super::super::adapter::ExternalChange {
    super::super::adapter::ExternalChange {
        entity_type: EntityType::WorkItem,
        external_id: "ext-1".to_string(),
        local_entity_id: None,
        fields,
        remote_updated_at: Utc.timestamp_millis_opt(remote_mtime_ms).unwrap(),
        deleted: false,
    }
}

fn metadata_with(revisions: &[(&str, i64, &str)]) -> SyncMetadata {
    let mut m = SyncMetadata::default();
    for (name, mtime, source) in revisions {
        m.field_revisions.insert(
            name.to_string(),
            FieldRevision {
                mtime: *mtime,
                source: source.to_string(),
            },
        );
    }
    m
}

fn local_values(pairs: &[(&str, Value)]) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    for (k, v) in pairs {
        map.insert(k.to_string(), v.clone());
    }
    map
}

fn open_in_memory_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-mem");
    init_outbox_conflicts_table(&conn).expect("init schema");
    conn
}

#[test]
fn detect_no_conflict_when_no_local_revision() {
    // First-sight branch: resolver adopts remote; no conflict to log.
    let metadata = SyncMetadata::default();
    let change = external_change(1_700_000_000_000, json!({ "title": "remote" }));
    let payload = detect_conflicts(
        &change,
        &metadata,
        &TEST_FIELD_MAP,
        &local_values(&[("title", json!("local"))]),
        "linear",
    );
    assert!(payload.fields.is_empty());
}

#[test]
fn detect_no_conflict_when_local_source_is_adapter() {
    // Local watermark exists but it came from a previous remote
    // merge — not a user edit. No conflict.
    let metadata = metadata_with(&[("title", 2_000_000_000_000, "linear")]);
    let change = external_change(1_700_000_000_000, json!({ "title": "remote" }));
    let payload = detect_conflicts(
        &change,
        &metadata,
        &TEST_FIELD_MAP,
        &local_values(&[("title", json!("local"))]),
        "linear",
    );
    assert!(payload.fields.is_empty());
}

#[test]
fn detect_no_conflict_when_remote_is_newer() {
    // Local user-edited at t1, remote even fresher at t2 — resolver
    // adopts remote; no conflict.
    let metadata = metadata_with(&[("title", 1_500_000_000_000, "local")]);
    let change = external_change(1_700_000_000_000, json!({ "title": "remote" }));
    let payload = detect_conflicts(
        &change,
        &metadata,
        &TEST_FIELD_MAP,
        &local_values(&[("title", json!("local"))]),
        "linear",
    );
    assert!(payload.fields.is_empty());
}

#[test]
fn detect_conflict_when_local_user_edit_beats_remote() {
    // Local user-edit at t2 beats remote at t1: resolver keeps
    // local; conflict logged with both sides + applied=Local.
    let metadata = metadata_with(&[("title", 2_000_000_000_000, "local")]);
    let change = external_change(1_700_000_000_000, json!({ "title": "remote-stale" }));
    let payload = detect_conflicts(
        &change,
        &metadata,
        &TEST_FIELD_MAP,
        &local_values(&[("title", json!("local-fresh"))]),
        "linear",
    );
    assert_eq!(payload.fields.len(), 1);
    let delta = payload.fields.get("title").expect("title delta");
    assert_eq!(delta.local_value, json!("local-fresh"));
    assert_eq!(delta.remote_value, json!("remote-stale"));
    assert_eq!(delta.local_mtime, 2_000_000_000_000);
    assert_eq!(delta.remote_mtime, 1_700_000_000_000);
    assert_eq!(delta.local_source, "local");
    assert_eq!(delta.remote_source, "linear");
    assert_eq!(delta.applied, AppliedSide::Local);
}

#[test]
fn detect_skips_read_only_fields() {
    // Even a clear conflict on a read-only field doesn't surface —
    // the resolver never writes it, so there's no UI action.
    let metadata = metadata_with(&[("assignee", 2_000_000_000_000, "local")]);
    let change = external_change(
        1_700_000_000_000,
        json!({ "assignee": "alice", "title": "x" }),
    );
    let payload = detect_conflicts(
        &change,
        &metadata,
        &TEST_FIELD_MAP,
        &local_values(&[("assignee", json!("bob")), ("title", json!("x"))]),
        "linear",
    );
    assert!(!payload.fields.contains_key("assignee"));
}

#[test]
fn detect_no_conflict_for_tombstone() {
    let metadata = metadata_with(&[("title", 2_000_000_000_000, "local")]);
    let mut change = external_change(1_700_000_000_000, json!({}));
    change.deleted = true;
    let payload = detect_conflicts(
        &change,
        &metadata,
        &TEST_FIELD_MAP,
        &local_values(&[("title", json!("x"))]),
        "linear",
    );
    assert!(payload.fields.is_empty());
}

#[test]
fn record_and_read_round_trip() {
    let conn = open_in_memory_db();
    let mut payload = ConflictFieldsPayload::default();
    payload.fields.insert(
        "title".into(),
        ConflictFieldDelta {
            local_value: json!("local"),
            remote_value: json!("remote"),
            local_mtime: 2_000_000_000_000,
            remote_mtime: 1_700_000_000_000,
            local_source: "local".into(),
            remote_source: "linear".into(),
            applied: AppliedSide::Local,
        },
    );

    let id = record_detected(
        &conn,
        "alpha",
        "linear",
        EntityType::WorkItem,
        "WI-1",
        "ext-1",
        &payload,
        12345,
        Some(99),
    )
    .expect("record");
    let fetched = read_one(&conn, id).expect("read").expect("present");
    assert_eq!(fetched.id, id);
    assert_eq!(fetched.project_slug, "alpha");
    assert_eq!(fetched.entity_id, "WI-1");
    assert_eq!(fetched.external_id, "ext-1");
    assert_eq!(fetched.detected_at, 12345);
    assert!(fetched.resolved_at.is_none());
    assert!(fetched.resolution.is_none());
    assert_eq!(fetched.source_outbox_id, Some(99));
    assert_eq!(fetched.fields.fields.len(), 1);
}

#[test]
fn list_for_project_orders_open_first_then_resolved() {
    let conn = open_in_memory_db();
    let payload = ConflictFieldsPayload::default();

    // Three open + two resolved across two projects.
    record_detected(
        &conn,
        "alpha",
        "linear",
        EntityType::WorkItem,
        "WI-1",
        "e1",
        &payload,
        100,
        None,
    )
    .unwrap();
    let id_open_2 = record_detected(
        &conn,
        "alpha",
        "linear",
        EntityType::WorkItem,
        "WI-2",
        "e2",
        &payload,
        200,
        None,
    )
    .unwrap();
    record_detected(
        &conn,
        "alpha",
        "linear",
        EntityType::WorkItem,
        "WI-3",
        "e3",
        &payload,
        300,
        None,
    )
    .unwrap();
    // Resolved rows.
    let id_resolved_a = record_detected(
        &conn,
        "alpha",
        "linear",
        EntityType::WorkItem,
        "WI-4",
        "e4",
        &payload,
        50,
        None,
    )
    .unwrap();
    let id_resolved_b = record_detected(
        &conn,
        "alpha",
        "linear",
        EntityType::WorkItem,
        "WI-5",
        "e5",
        &payload,
        60,
        None,
    )
    .unwrap();
    mark_resolved(&conn, id_resolved_a, ConflictResolution::UseLocal, 1000).unwrap();
    mark_resolved(&conn, id_resolved_b, ConflictResolution::UseRemote, 2000).unwrap();
    // Sibling project: should not appear in alpha listing.
    record_detected(
        &conn,
        "beta",
        "linear",
        EntityType::WorkItem,
        "WB-1",
        "e6",
        &payload,
        400,
        None,
    )
    .unwrap();

    let listed = list_for_project(&conn, "alpha", 10).expect("list");
    // Order: 3 open (newest detected first), then 2 resolved (newest resolved first).
    assert_eq!(listed.len(), 5);
    assert_eq!(listed[0].entity_id, "WI-3");
    assert_eq!(listed[1].entity_id, "WI-2");
    assert_eq!(listed[1].id, id_open_2);
    assert_eq!(listed[2].entity_id, "WI-1");
    // Resolved tail: WI-5 resolved at 2000 first, WI-4 at 1000.
    assert_eq!(listed[3].entity_id, "WI-5");
    assert_eq!(listed[4].entity_id, "WI-4");
}

#[test]
fn list_for_project_with_zero_limit_skips_resolved() {
    let conn = open_in_memory_db();
    let payload = ConflictFieldsPayload::default();
    let id = record_detected(
        &conn,
        "alpha",
        "linear",
        EntityType::WorkItem,
        "WI-1",
        "e1",
        &payload,
        100,
        None,
    )
    .unwrap();
    mark_resolved(&conn, id, ConflictResolution::Dismissed, 1000).unwrap();
    let listed = list_for_project(&conn, "alpha", 0).expect("list");
    assert!(listed.is_empty());
}

#[test]
fn mark_resolved_is_idempotent_returns_false_on_second_call() {
    let conn = open_in_memory_db();
    let payload = ConflictFieldsPayload::default();
    let id = record_detected(
        &conn,
        "alpha",
        "linear",
        EntityType::WorkItem,
        "WI-1",
        "e1",
        &payload,
        100,
        None,
    )
    .unwrap();
    let first = mark_resolved(&conn, id, ConflictResolution::UseLocal, 1000).expect("first");
    assert!(first);
    let second = mark_resolved(&conn, id, ConflictResolution::UseRemote, 2000).expect("second");
    assert!(!second);
    // Resolution + resolved_at do NOT change on the second call.
    let row = read_one(&conn, id).unwrap().unwrap();
    assert_eq!(row.resolution, Some(ConflictResolution::UseLocal));
    assert_eq!(row.resolved_at, Some(1000));
}

#[test]
fn mark_resolved_unknown_id_errors() {
    let conn = open_in_memory_db();
    let result = mark_resolved(&conn, 9999, ConflictResolution::UseLocal, 1000);
    assert!(result.is_err());
}

#[test]
fn count_open_only_counts_open_rows() {
    let conn = open_in_memory_db();
    let payload = ConflictFieldsPayload::default();
    let a = record_detected(
        &conn,
        "alpha",
        "linear",
        EntityType::WorkItem,
        "WI-1",
        "e1",
        &payload,
        100,
        None,
    )
    .unwrap();
    record_detected(
        &conn,
        "alpha",
        "linear",
        EntityType::WorkItem,
        "WI-2",
        "e2",
        &payload,
        200,
        None,
    )
    .unwrap();
    record_detected(
        &conn,
        "beta",
        "linear",
        EntityType::WorkItem,
        "WB-1",
        "e3",
        &payload,
        300,
        None,
    )
    .unwrap();
    mark_resolved(&conn, a, ConflictResolution::Dismissed, 1000).unwrap();
    assert_eq!(count_open(&conn, "alpha").unwrap(), 1);
    assert_eq!(count_open(&conn, "beta").unwrap(), 1);
    assert_eq!(count_open(&conn, "gamma").unwrap(), 0);
}

#[test]
fn use_local_and_use_remote_payloads_extract_correct_sides() {
    let mut payload = ConflictFieldsPayload::default();
    payload.fields.insert(
        "title".into(),
        ConflictFieldDelta {
            local_value: json!("local-T"),
            remote_value: json!("remote-T"),
            local_mtime: 200,
            remote_mtime: 100,
            local_source: "local".into(),
            remote_source: "linear".into(),
            applied: AppliedSide::Local,
        },
    );
    payload.fields.insert(
        "status".into(),
        ConflictFieldDelta {
            local_value: json!("in_progress"),
            remote_value: json!("done"),
            local_mtime: 200,
            remote_mtime: 100,
            local_source: "local".into(),
            remote_source: "linear".into(),
            applied: AppliedSide::Local,
        },
    );
    let row = ConflictRow {
        id: 1,
        project_slug: "alpha".into(),
        adapter_id: "linear".into(),
        entity_type: EntityType::WorkItem,
        entity_id: "WI-1".into(),
        external_id: "ext-1".into(),
        fields: payload,
        detected_at: 12345,
        resolved_at: None,
        resolution: None,
        source_outbox_id: None,
    };
    let local = use_local_payload(&row);
    assert_eq!(local["title"], json!("local-T"));
    assert_eq!(local["status"], json!("in_progress"));

    let remote = use_remote_payload(&row);
    assert_eq!(remote["title"], json!("remote-T"));
    assert_eq!(remote["status"], json!("done"));

    let revs = use_remote_revisions(&row);
    assert_eq!(revs["title"].mtime, 100);
    assert_eq!(revs["title"].source, "linear");
    assert_eq!(revs["status"].mtime, 100);
}

#[test]
fn resolution_db_string_round_trip() {
    for r in [
        ConflictResolution::UseLocal,
        ConflictResolution::UseRemote,
        ConflictResolution::Dismissed,
    ] {
        assert_eq!(ConflictResolution::from_db_str(r.as_db_str()).unwrap(), r);
    }
    assert!(ConflictResolution::from_db_str("nope").is_err());
}
