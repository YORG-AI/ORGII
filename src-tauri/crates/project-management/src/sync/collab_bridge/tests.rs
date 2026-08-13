#![allow(clippy::field_reassign_with_default)]
// Sync scenarios intentionally mutate one partial-update field at a time to
// mirror the sequence of local changes under test.

use super::outbox::store_remote_version;
use super::wire::now_ms;
use super::*;
use crate::projects::io::{
    acquire_execution_lock, configure_project_org_collab_sync, create_project_org, read_project,
    read_standalone_work_item, read_work_item, release_execution_lock,
    update_standalone_work_item_partial, update_work_item_partial, write_project, write_work_item,
};
use crate::projects::types::{
    CommentEntry, CreateProjectOrgRequest, ProjectData, ProjectMeta, WorkItemExecutionLockReason,
    WorkItemFrontmatter, WorkItemHandoffStatus, WorkItemPartialUpdate,
};
use crate::sync::io;
use crate::sync::types::OutboxStatus;
use crate::work_item_features::{
    PropertyConfig, PropertyType, SetWorkItemPropertyValueRequest, UpsertPropertyDefinitionRequest,
    WorkItemScope,
};
use rusqlite::params;
use serde_json::{json, Value};
use test_helpers::test_env;

const ORG: &str = "org-collab-test";

fn seed_collab_org() {
    create_project_org(&CreateProjectOrgRequest {
        name: "Collab Test Org".to_string(),
        id: Some(ORG.to_string()),
    })
    .expect("create org");
    configure_project_org_collab_sync(ORG, Some(ORG)).expect("configure collab sync");
}

fn project_meta(id: &str, name: &str) -> ProjectMeta {
    ProjectMeta {
        id: id.to_string(),
        name: name.to_string(),
        org_id: ORG.to_string(),
        status: "active".to_string(),
        priority: "none".to_string(),
        health: "on_track".to_string(),
        lead: None,
        members: vec![],
        labels: vec![],
        linked_repos: vec![],
        start_date: None,
        target_date: None,
        created_at: String::new(),
        updated_at: String::new(),
        next_work_item_id: 1,
        work_item_prefix: "AAA".to_string(),
        work_item_prefix_custom: true,
        agent_defaults: None,
    }
}

fn work_item_frontmatter(short_id: &str, title: &str) -> WorkItemFrontmatter {
    WorkItemFrontmatter {
        id: short_id.to_string(),
        short_id: short_id.to_string(),
        title: title.to_string(),
        project: None,
        status: "backlog".to_string(),
        priority: "none".to_string(),
        assignee: None,
        assignee_type: None,
        labels: vec![],
        milestone: None,
        parent: None,
        stage: None,
        start_date: None,
        target_date: None,
        created_by: None,
        origin_session: None,
        created_at: String::new(),
        updated_at: String::new(),
        deleted_at: None,
        starred: false,
        todos: vec![],
        comments: vec![],
        history: vec![],
        delegations: vec![],
        linked_sessions: vec![],
        handoff: None,
        proof_of_work: None,
        orchestrator_config: None,
        orchestrator_state: None,
        follow_up_items: vec![],
        schedule: None,
        routine_source: None,
        execution_lock: None,
        close_out: None,
        work_products: vec![],
    }
}

fn seed_project(slug: &str) -> ProjectData {
    write_project(slug, &project_meta(&format!("p-{slug}"), slug), "", true).expect("seed project");
    read_project(slug).expect("read seeded project")
}

fn pending_org_rows() -> i64 {
    let conn = io::conn().expect("conn");
    conn.query_row(
        "SELECT COUNT(*) FROM outbox_entries WHERE org_id = ?1 AND status = 'pending'",
        params![ORG],
        |row| row.get(0),
    )
    .expect("count")
}

#[test]
fn local_writes_enqueue_bridge_rows_the_worker_never_claims() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_project("alpha");
    write_work_item(
        "alpha",
        "AAA-0001",
        &work_item_frontmatter("AAA-0001", "T"),
        "b",
    )
    .expect("write item");

    assert!(pending_org_rows() >= 2, "project + work item rows expected");

    // The in-process worker must never claim bridge rows.
    let conn = io::conn().expect("conn");
    let claimed = io::claim_next_pending(&conn, now_ms() + 1).expect("claim");
    assert!(claimed.is_none(), "worker claimed a collab bridge row");
}

#[test]
fn non_collab_org_writes_enqueue_nothing() {
    let _sandbox = test_env::sandbox();
    // personal-org exists by default and is not collab-synced.
    let mut meta = project_meta("p-solo", "solo");
    meta.org_id = "personal-org".to_string();
    write_project("solo", &meta, "", true).expect("write");
    let conn = io::conn().expect("conn");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM outbox_entries", [], |row| row.get(0))
        .expect("count");
    assert_eq!(count, 0);
}

#[test]
fn drain_coalesces_per_entity_and_ack_success_stores_version() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_project("alpha");
    write_work_item(
        "alpha",
        "AAA-0001",
        &work_item_frontmatter("AAA-0001", "T1"),
        "b",
    )
    .expect("write item");
    // Two partial updates → extra rows for the same entity.
    let mut update = WorkItemPartialUpdate::default();
    update.title = Some("T2".to_string());
    update_work_item_partial("alpha", "AAA-0001", &update).expect("update 1");
    let mut update = WorkItemPartialUpdate::default();
    update.status = Some("in_progress".to_string());
    update_work_item_partial("alpha", "AAA-0001", &update).expect("update 2");

    let items = drain_outbox(ORG, 50).expect("drain");
    let work_items: Vec<_> = items
        .iter()
        .filter(|item| item.kind == KIND_WORK_ITEM)
        .collect();
    assert_eq!(work_items.len(), 1, "coalesced into one push item");
    let item = work_items[0];
    assert_eq!(item.op, OP_UPSERT);
    assert!(item.entry_ids.len() >= 2);
    assert_eq!(item.base_version, None, "never synced yet");
    let payload = item.payload.as_ref().expect("payload");
    assert_eq!(payload["title"], "T2");
    assert_eq!(payload["status"], "in_progress");
    assert_eq!(payload["shortId"], "AAA-0001");

    // Nothing pending while in flight.
    assert_eq!(pending_org_rows(), 0);

    let acks: Vec<CollabAckResult> = items
        .iter()
        .map(|item| CollabAckResult {
            entry_ids: item.entry_ids.clone(),
            kind: item.kind.clone(),
            entity_id: item.entity_id.clone(),
            ok: true,
            remote_version: Some(7),
            error: None,
        })
        .collect();
    ack_outbox(acks).expect("ack");

    let conn = io::conn().expect("conn");
    let version: Option<i64> = conn
        .query_row(
            "SELECT collab_remote_version FROM workitems WHERE id = 'AAA-0001'",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, Some(7));
    drop(conn);

    assert!(drain_outbox(ORG, 50).expect("drain again").is_empty());
}

#[test]
fn drain_abandons_unsupported_entity_rows_instead_of_reclaiming_forever() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_project("alpha");
    let conn = io::conn().expect("conn");
    conn.execute(
        "INSERT INTO outbox_entries
                (project_slug, entity_type, entity_id, op, created_at, status, org_id)
             VALUES ('alpha', 'future_kind', 'future-1', 'update', 1, 'pending', ?1)",
        [ORG],
    )
    .expect("insert unsupported row");
    let row_id = conn.last_insert_rowid();
    drop(conn);

    let first_drain = drain_outbox(ORG, 50).expect("drain");
    assert!(
        first_drain.iter().all(|item| item.kind != "future_kind"),
        "unsupported rows must never reach the transport"
    );

    let conn = io::conn().expect("conn");
    let (status, error): (String, Option<String>) = conn
        .query_row(
            "SELECT status, last_error FROM outbox_entries WHERE id = ?1",
            [row_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("load terminal row");
    assert_eq!(status, OutboxStatus::Abandoned.as_db_str());
    assert_eq!(
        error.as_deref(),
        Some("unsupported collab entity_type: future_kind")
    );
    drop(conn);

    let second_drain = drain_outbox(ORG, 50).expect("drain again");
    assert!(
        second_drain.iter().all(|item| item.kind != "future_kind"),
        "abandoned rows must not be reclaimed"
    );
}

#[test]
fn outbox_pending_ids_reports_pending_and_in_flight_until_ack() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    let project = seed_project("alpha");
    write_work_item(
        "alpha",
        "AAA-0001",
        &work_item_frontmatter("AAA-0001", "T"),
        "b",
    )
    .expect("write item");

    let pending = outbox_pending_ids(ORG).expect("pending ids");
    assert!(pending.contains(&CollabPendingEntity {
        kind: KIND_PROJECT.to_string(),
        entity_id: project.meta.id.clone(),
    }));
    assert!(pending.contains(&CollabPendingEntity {
        kind: KIND_WORK_ITEM.to_string(),
        entity_id: "AAA-0001".to_string(),
    }));

    let items = drain_outbox(ORG, 50).expect("drain");
    assert_eq!(
        outbox_pending_ids(ORG).expect("in-flight ids").len(),
        2,
        "in-flight rows still count as pending for the UI"
    );

    let acks: Vec<CollabAckResult> = items
        .iter()
        .map(|item| CollabAckResult {
            entry_ids: item.entry_ids.clone(),
            kind: item.kind.clone(),
            entity_id: item.entity_id.clone(),
            ok: true,
            remote_version: Some(1),
            error: None,
        })
        .collect();
    ack_outbox(acks).expect("ack");
    assert!(outbox_pending_ids(ORG).expect("after ack").is_empty());

    assert!(outbox_pending_ids("personal-org")
        .expect("non-collab org")
        .is_empty());
}

#[test]
fn ack_conflict_requeues_for_immediate_retry() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_project("alpha");

    let items = drain_outbox(ORG, 50).expect("drain");
    assert_eq!(items.len(), 1);
    ack_outbox(vec![CollabAckResult {
        entry_ids: items[0].entry_ids.clone(),
        kind: items[0].kind.clone(),
        entity_id: items[0].entity_id.clone(),
        ok: false,
        remote_version: None,
        error: Some("ORGII_CONFLICT".to_string()),
    }])
    .expect("ack conflict");

    let retried = drain_outbox(ORG, 50).expect("drain retry");
    assert_eq!(retried.len(), 1, "conflicted row re-drained immediately");
    assert_eq!(retried[0].entity_id, items[0].entity_id);
}

#[test]
fn apply_remote_creates_entities_without_echo() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();

    let applied = apply_remote(
        ORG,
        Some("Collab Test Org"),
        vec![
            CollabRemoteEntity {
                kind: KIND_PROJECT.to_string(),
                payload: json!({
                    "id": "proj-remote",
                    "slug": "remote-project",
                    "name": "Remote Project",
                    "status": "active",
                    "priority": "high",
                    "health": "on_track",
                    "workItemPrefix": "REM",
                    "description": "from teammate",
                    "updatedAt": "2026-07-01T00:00:00Z",
                    "propertyDefinitions": [{
                        "id": "prop_remote_effort",
                        "orgId": ORG,
                        "name": "Remote effort",
                        "propertyType": "number",
                        "description": null,
                        "config": { "options": [] },
                        "position": 0,
                        "archivedAt": null,
                        "createdAt": "2026-07-01T00:00:00Z",
                        "updatedAt": "2026-07-01T00:00:00Z"
                    }],
                }),
                version: 3,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            },
            CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "REM-0001",
                    "projectId": "proj-remote",
                    "shortId": "REM-0001",
                    "title": "Remote item",
                    "body": "remote body",
                    "status": "backlog",
                    "priority": "none",
                    "labels": [],
                    "updatedAt": "2026-07-01T00:00:00Z",
                    "propertyDefinitions": [],
                    "propertyValues": [{
                        "propertyId": "prop_remote_effort",
                        "value": 5,
                        "updatedAt": "2026-07-01T00:00:00Z"
                    }],
                }),
                version: 2,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            },
        ],
    )
    .expect("apply");
    assert_eq!(applied, 2);

    let project = read_project("remote-project").expect("project exists");
    assert_eq!(project.meta.id, "proj-remote");
    assert_eq!(project.meta.priority, "high");
    assert_eq!(project.description, "from teammate");
    let item = read_work_item("remote-project", "REM-0001").expect("item exists");
    assert_eq!(item.frontmatter.title, "Remote item");
    assert_eq!(item.body, "remote body");
    let values = crate::work_item_features::properties::list_values(&WorkItemScope {
        project_slug: Some("remote-project".to_string()),
        org_id: ORG.to_string(),
        work_item_id: "REM-0001".to_string(),
    })
    .expect("remote typed property exists");
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].definition.name, "Remote effort");
    assert_eq!(values[0].value, json!(5));

    // No echo: remote application must not enqueue bridge rows.
    assert_eq!(pending_org_rows(), 0, "apply_remote echoed into the outbox");

    // Idempotence: same versions again → nothing applied.
    let reapplied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({
                "id": "REM-0001",
                "projectId": "proj-remote",
                "shortId": "REM-0001",
                "title": "Should not overwrite",
                "updatedAt": "2026-07-01T00:00:01Z",
            }),
            version: 2,
            updated_by: None,
            deleted_at: None,
        }],
    )
    .expect("reapply");
    assert_eq!(reapplied, 0);
    let item = read_work_item("remote-project", "REM-0001").expect("item");
    assert_eq!(item.frontmatter.title, "Remote item");
}

#[test]
fn standalone_pending_update_rebases_and_merges_remote_tail_without_conflict_loop() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();

    apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({
                "id": "standalone-row",
                "shortId": "ORG-0001",
                "title": "Original title",
                "body": "Original body",
                "status": "backlog",
                "priority": "none",
                "comments": [],
                "updatedAt": "2026-07-01T00:00:00Z",
            }),
            version: 1,
            updated_by: Some("member-a".to_string()),
            deleted_at: None,
        }],
    )
    .expect("seed remote standalone");

    let local_comment = CommentEntry {
        id: "comment-local".to_string(),
        author: "member-a".to_string(),
        content: "local pending comment".to_string(),
        created_at: "2026-07-29T01:00:00Z".to_string(),
        mentioned_user_ids: vec![],
        ..Default::default()
    };
    update_standalone_work_item_partial(
        Some(ORG),
        "ORG-0001",
        &WorkItemPartialUpdate {
            status: Some("in_progress".to_string()),
            comments: Some(vec![local_comment.clone()]),
            ..WorkItemPartialUpdate::default()
        },
    )
    .expect("local pending update");
    assert_eq!(pending_org_rows(), 1);

    let remote_comment = CommentEntry {
        id: "comment-remote".to_string(),
        author: "member-b".to_string(),
        content: "remote teammate comment".to_string(),
        created_at: "2026-07-29T01:00:01Z".to_string(),
        mentioned_user_ids: vec!["member-a".to_string()],
        ..Default::default()
    };
    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({
                "id": "standalone-row",
                "shortId": "ORG-0001",
                "title": "Remote title",
                "body": "Original body",
                "status": "backlog",
                "priority": "high",
                "comments": [remote_comment],
                "updatedAt": "2026-07-01T00:05:00Z",
            }),
            version: 2,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply conflicting remote standalone");
    assert_eq!(applied, 1);

    let item =
        read_standalone_work_item(Some(ORG), "ORG-0001").expect("read merged standalone item");
    assert_eq!(
        item.frontmatter.status, "in_progress",
        "the newer local status watermark survives the older remote row"
    );
    assert_eq!(item.frontmatter.title, "Remote title");
    assert_eq!(item.frontmatter.priority, "high");
    assert_eq!(
        item.frontmatter
            .comments
            .iter()
            .map(|comment| comment.id.as_str())
            .collect::<Vec<_>>(),
        vec!["comment-local", "comment-remote"],
        "stable-id union preserves both independently appended comments"
    );

    let retried = drain_outbox(ORG, 50).expect("drain rebased retry");
    assert_eq!(retried.len(), 1);
    assert_eq!(
        retried[0].base_version,
        Some(2),
        "the retry must use the pulled remote version instead of conflicting again"
    );
    let comments = retried[0]
        .payload
        .as_ref()
        .and_then(|payload| payload.get("comments"))
        .and_then(Value::as_array)
        .expect("merged comments in outgoing snapshot");
    assert_eq!(comments.len(), 2);
}

#[test]
fn apply_remote_updates_handoff_on_an_existing_project_work_item() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    apply_remote(
        ORG,
        None,
        vec![
            CollabRemoteEntity {
                kind: KIND_PROJECT.to_string(),
                payload: json!({
                    "id": "proj-remote",
                    "slug": "remote-project",
                    "name": "Remote Project",
                    "workItemPrefix": "REM",
                    "updatedAt": "2026-07-01T00:00:00Z",
                }),
                version: 1,
                updated_by: None,
                deleted_at: None,
            },
            CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "REM-0001",
                    "projectId": "proj-remote",
                    "shortId": "REM-0001",
                    "title": "Remote item",
                    "body": "",
                    "status": "planned",
                    "priority": "none",
                    "labels": [],
                    "handoff": {
                        "id": "handoff-1",
                        "status": "pending",
                        "senderMemberId": "member-a",
                        "senderName": "Ada",
                        "recipientMemberId": "member-b",
                        "recipientName": "Lin",
                        "requestedAt": "2026-07-01T00:00:00Z"
                    },
                    "updatedAt": "2026-07-01T00:00:00Z",
                }),
                version: 1,
                updated_by: Some("member-a".to_string()),
                deleted_at: None,
            },
        ],
    )
    .expect("seed remote handoff");

    let pending = read_work_item("remote-project", "REM-0001").expect("pending item");
    assert_eq!(
        pending
            .frontmatter
            .handoff
            .as_ref()
            .map(|handoff| &handoff.status),
        Some(&WorkItemHandoffStatus::Pending)
    );

    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({
                "id": "REM-0001",
                "projectId": "proj-remote",
                "shortId": "REM-0001",
                "title": "Remote item",
                "body": "",
                "status": "planned",
                "priority": "none",
                "labels": [],
                "handoff": {
                    "id": "handoff-1",
                    "status": "accepted",
                    "senderMemberId": "member-a",
                    "senderName": "Ada",
                    "recipientMemberId": "member-b",
                    "recipientName": "Lin",
                    "requestedAt": "2026-07-01T00:00:00Z",
                    "respondedAt": "2026-07-01T00:05:00Z"
                },
                "updatedAt": "2026-07-01T00:05:00Z",
            }),
            version: 2,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply accepted handoff");
    assert_eq!(applied, 1);

    let accepted = read_work_item("remote-project", "REM-0001").expect("accepted item");
    let handoff = accepted.frontmatter.handoff.expect("persisted handoff");
    assert_eq!(handoff.status, WorkItemHandoffStatus::Accepted);
    assert_eq!(
        handoff.responded_at.as_deref(),
        Some("2026-07-01T00:05:00Z")
    );
    assert_eq!(pending_org_rows(), 0, "remote handoff update echoed");
}

#[test]
fn apply_remote_merges_per_field_keeping_newer_local_edits() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    // Remote-created item so per-field watermarks are stamped at the
    // remote mtime.
    apply_remote(
        ORG,
        None,
        vec![
            CollabRemoteEntity {
                kind: KIND_PROJECT.to_string(),
                payload: json!({
                    "id": "proj-remote",
                    "slug": "remote-project",
                    "name": "Remote Project",
                    "workItemPrefix": "REM",
                    "updatedAt": "2026-07-01T00:00:00Z",
                }),
                version: 1,
                updated_by: None,
                deleted_at: None,
            },
            CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "REM-0001",
                    "projectId": "proj-remote",
                    "shortId": "REM-0001",
                    "title": "Original title",
                    "body": "original",
                    "status": "backlog",
                    "updatedAt": "2026-07-01T00:00:00Z",
                }),
                version: 1,
                updated_by: None,
                deleted_at: None,
            },
        ],
    )
    .expect("seed remote");

    // Local edit AFTER the remote row's mtime → local title watermark
    // is newer than the incoming remote change below.
    let mut update = WorkItemPartialUpdate::default();
    update.title = Some("Local newer title".to_string());
    update_work_item_partial("remote-project", "REM-0001", &update).expect("local edit");

    // Teammate's row (version 2) carries an OLDER title mtime but a
    // status change; per-field: title keeps local, status adopts remote.
    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({
                "id": "REM-0001",
                "projectId": "proj-remote",
                "shortId": "REM-0001",
                "title": "Teammate stale title",
                "body": "original",
                "status": "in_progress",
                "updatedAt": "2026-07-01T00:00:30Z",
            }),
            version: 2,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply merge");
    assert_eq!(applied, 1);

    let item = read_work_item("remote-project", "REM-0001").expect("item");
    assert_eq!(
        item.frontmatter.title, "Local newer title",
        "newer local field must survive the remote row"
    );
    assert_eq!(
        item.frontmatter.status, "in_progress",
        "untouched field adopts remote"
    );

    // The pending local push (title edit) is still queued for the
    // retry push; the remote apply must not have consumed it.
    assert!(pending_org_rows() >= 1);
}

/// End-to-end wire contract for the critical field-merge fix: a peer sends
/// a WHOLE-ROW snapshot with `_fieldRevisions` naming only the field it
/// changed. A locally-edited field the remote did NOT touch must survive
/// even though the remote's whole-row `updatedAt` is newer than the local
/// edit — the exact case the old whole-row-clock merge got wrong.
#[test]
fn apply_remote_whole_row_snapshot_preserves_untouched_local_field() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    apply_remote(
        ORG,
        None,
        vec![
            CollabRemoteEntity {
                kind: KIND_PROJECT.to_string(),
                payload: json!({
                    "id": "proj-remote",
                    "slug": "remote-project",
                    "name": "Remote Project",
                    "workItemPrefix": "REM",
                    "updatedAt": "2026-07-01T00:00:00Z",
                }),
                version: 1,
                updated_by: None,
                deleted_at: None,
            },
            CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "REM-0001",
                    "projectId": "proj-remote",
                    "shortId": "REM-0001",
                    "title": "Original title",
                    "status": "backlog",
                    "updatedAt": "2026-07-01T00:00:00Z",
                }),
                version: 1,
                updated_by: None,
                deleted_at: None,
            },
        ],
    )
    .expect("seed remote");

    // Local changes STATUS. Its per-field watermark is stamped at real now.
    let mut update = WorkItemPartialUpdate::default();
    update.status = Some("in_review".to_string());
    update_work_item_partial("remote-project", "REM-0001", &update).expect("local status edit");

    // Teammate pushes a WHOLE-ROW snapshot (v2): they changed only `title`.
    // `updatedAt` and title's mtime are far in the future (newer than the
    // local status edit), and `status` carries a STALE value the teammate
    // never touched — status is deliberately ABSENT from `_fieldRevisions`.
    let future_ms: i64 = 4_070_908_800_000; // 2099-01-01
    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({
                "id": "REM-0001",
                "projectId": "proj-remote",
                "shortId": "REM-0001",
                "title": "Teammate new title",
                "status": "backlog",
                "updatedAt": "2099-01-01T00:00:00Z",
                "_fieldRevisions": { "title": future_ms },
            }),
            version: 2,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply merge");
    assert_eq!(applied, 1);

    let item = read_work_item("remote-project", "REM-0001").expect("item");
    assert_eq!(
        item.frontmatter.status, "in_review",
        "a field the remote did not touch must not be reverted by its whole-row snapshot"
    );
    assert_eq!(
        item.frontmatter.title, "Teammate new title",
        "the field the remote genuinely changed is adopted"
    );
}

/// Seed a remote-owned project + one work item (both version 1,
/// mtime 2026-07-01T00:00:00Z) via `apply_remote`, so no local
/// outbox rows exist afterwards.
fn seed_remote_project_and_item(item_payload_extra: Value) {
    let mut item_payload = json!({
        "id": "REM-0001",
        "projectId": "proj-remote",
        "shortId": "REM-0001",
        "title": "Original title",
        "body": "original",
        "status": "backlog",
        "updatedAt": "2026-07-01T00:00:00Z",
    });
    if let (Some(base), Some(extra)) =
        (item_payload.as_object_mut(), item_payload_extra.as_object())
    {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    apply_remote(
        ORG,
        None,
        vec![
            CollabRemoteEntity {
                kind: KIND_PROJECT.to_string(),
                payload: json!({
                    "id": "proj-remote",
                    "slug": "remote-project",
                    "name": "Remote Project",
                    "workItemPrefix": "REM",
                    "updatedAt": "2026-07-01T00:00:00Z",
                }),
                version: 1,
                updated_by: None,
                deleted_at: None,
            },
            CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: item_payload,
                version: 1,
                updated_by: None,
                deleted_at: None,
            },
        ],
    )
    .expect("seed remote");
    assert_eq!(pending_org_rows(), 0, "seeding must not echo");
}

/// Finding: a pending local push must gate the whole-row tail apply
/// by PRESENCE, not by comparing the local row's wall clock against
/// the remote machine's `updatedAt`. Here the remote clock is far in
/// the future — the old cross-clock gate would have judged the local
/// pending comment "older" and clobbered it.
#[test]
fn pending_local_push_blocks_remote_tail_clobber_and_unions_lists() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_remote_project_and_item(json!({}));

    // Local un-pushed comment → pending outbox row.
    let mut update = WorkItemPartialUpdate::default();
    update.comments = Some(vec![CommentEntry {
        id: "local-c1".to_string(),
        author: "me".to_string(),
        content: "local pending comment".to_string(),
        created_at: "2026-07-01T00:01:00Z".to_string(),
        mentioned_user_ids: Vec::new(),
        ..Default::default()
    }]);
    update_work_item_partial("remote-project", "REM-0001", &update).expect("local comment");
    assert!(pending_org_rows() >= 1, "local comment should be pending");

    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({
                "id": "REM-0001",
                "projectId": "proj-remote",
                "shortId": "REM-0001",
                "title": "Original title",
                "status": "backlog",
                "updatedAt": "2099-01-01T00:00:00Z",
                "starred": true,
                "comments": [{
                    "id": "remote-c1",
                    "author": "member-b",
                    "content": "remote comment",
                    "created_at": "2099-01-01T00:00:00Z",
                }],
            }),
            version: 2,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply");
    assert_eq!(applied, 1);

    let item = read_work_item("remote-project", "REM-0001").expect("item");
    let comment_ids: Vec<&str> = item
        .frontmatter
        .comments
        .iter()
        .map(|comment| comment.id.as_str())
        .collect();
    assert!(
        comment_ids.contains(&"local-c1"),
        "pending local comment must survive the remote whole-row tail"
    );
    assert!(
        comment_ids.contains(&"remote-c1"),
        "remote list addition still lands via the id union"
    );
    assert!(
        !item.frontmatter.starred,
        "scalar tail fields are not whole-row-applied while a push is pending"
    );
    assert!(
        pending_org_rows() >= 1,
        "the pending local push must not be consumed by the apply"
    );
}

/// Finding: one bad entity (here a `(project_id, short_id)` unique
/// violation against an unrelated local row) must not abort the
/// whole pulled batch.
#[test]
fn apply_remote_skips_bad_entity_and_applies_the_rest() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_PROJECT.to_string(),
            payload: json!({
                "id": "proj-remote",
                "slug": "remote-project",
                "name": "Remote Project",
                "workItemPrefix": "REM",
                "updatedAt": "2026-07-01T00:00:00Z",
            }),
            version: 1,
            updated_by: None,
            deleted_at: None,
        }],
    )
    .expect("seed project");

    // Unrelated local row already owns short id REM-0001.
    let mut local = work_item_frontmatter("REM-0001", "Local item");
    local.id = "local-wi".to_string();
    write_work_item("remote-project", "REM-0001", &local, "").expect("local item");

    let bad_then_good = vec![
        CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({
                "id": "wi-remote-dupe",
                "projectId": "proj-remote",
                "shortId": "REM-0001", // collides with the local row
                "title": "Bad",
                "updatedAt": "2026-07-01T00:00:10Z",
            }),
            version: 1,
            updated_by: None,
            deleted_at: None,
        },
        CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({
                "id": "wi-remote-ok",
                "projectId": "proj-remote",
                "shortId": "REM-0002",
                "title": "Good",
                "updatedAt": "2026-07-01T00:00:10Z",
            }),
            version: 1,
            updated_by: None,
            deleted_at: None,
        },
    ];
    let applied =
        apply_remote(ORG, None, bad_then_good).expect("batch must not abort on one bad row");
    assert_eq!(applied, 1, "only the good entity counts as applied");

    let good = read_work_item("remote-project", "REM-0002").expect("good entity applied");
    assert_eq!(good.frontmatter.title, "Good");
    let untouched = read_work_item("remote-project", "REM-0001").expect("local row");
    assert_eq!(untouched.frontmatter.title, "Local item");
    assert_eq!(untouched.frontmatter.id, "local-wi");
}

/// Finding: a local lock acquire/release runs through the
/// closure-form `update_work_item_atomic` and touches only
/// payload-tail fields — it must still enqueue a push, and the wire
/// snapshot must carry `executionLock` as an explicit null (never a
/// missing key) after release.
#[test]
fn lock_acquire_and_release_propagate_through_the_outbox() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_project("alpha");
    write_work_item(
        "alpha",
        "AAA-0001",
        &work_item_frontmatter("AAA-0001", "T"),
        "",
    )
    .expect("write item");

    let ack_all_ok = |items: &[CollabPushItem], version: i64| {
        ack_outbox(
            items
                .iter()
                .map(|item| CollabAckResult {
                    entry_ids: item.entry_ids.clone(),
                    kind: item.kind.clone(),
                    entity_id: item.entity_id.clone(),
                    ok: true,
                    remote_version: Some(version),
                    error: None,
                })
                .collect(),
        )
        .expect("ack");
    };

    // Flush the create traffic so the asserts below isolate the lock.
    let items = drain_outbox(ORG, 50).expect("drain create");
    ack_all_ok(&items, 1);
    assert_eq!(pending_org_rows(), 0);

    acquire_execution_lock(
        "alpha",
        "AAA-0001",
        "sess-1",
        Some("coding"),
        WorkItemExecutionLockReason::ManualStart,
    )
    .expect("acquire");
    assert!(pending_org_rows() >= 1, "acquire must enqueue a push");
    let items = drain_outbox(ORG, 50).expect("drain acquire");
    let item = items
        .iter()
        .find(|item| item.kind == KIND_WORK_ITEM)
        .expect("work item push");
    let payload = item.payload.as_ref().expect("payload");
    assert_eq!(payload["executionLock"]["activeSessionId"], "sess-1");
    ack_all_ok(&items, 2);
    assert_eq!(pending_org_rows(), 0);

    release_execution_lock("alpha", "AAA-0001", "sess-1").expect("release");
    assert!(pending_org_rows() >= 1, "release must enqueue a push");
    let items = drain_outbox(ORG, 50).expect("drain release");
    let item = items
        .iter()
        .find(|item| item.kind == KIND_WORK_ITEM)
        .expect("work item push");
    let payload = item.payload.as_ref().expect("payload");
    assert_eq!(
        payload.get("executionLock"),
        Some(&Value::Null),
        "released lock rides the wire as an explicit null, never a missing key"
    );
}

/// Finding: the pull side must APPLY an explicitly-null
/// `executionLock` (teammate released) rather than ignore it.
#[test]
fn apply_remote_explicit_null_execution_lock_clears_local_lock() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_remote_project_and_item(json!({
        "executionLock": {
            "activeSessionId": "sess-remote",
            "lockedByMemberId": "member-b",
        },
    }));

    let item = read_work_item("remote-project", "REM-0001").expect("item");
    assert_eq!(
        item.frontmatter
            .execution_lock
            .as_ref()
            .and_then(|lock| lock.active_session_id.as_deref()),
        Some("sess-remote"),
        "remote lock landed locally"
    );

    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({
                "id": "REM-0001",
                "projectId": "proj-remote",
                "shortId": "REM-0001",
                "title": "Original title",
                "status": "backlog",
                "updatedAt": "2026-07-01T00:05:00Z",
                "executionLock": null,
            }),
            version: 2,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply release");
    assert_eq!(applied, 1);

    let item = read_work_item("remote-project", "REM-0001").expect("item");
    assert!(
        item.frontmatter.execution_lock.is_none(),
        "an explicitly-null executionLock must clear the local lock"
    );
}

/// Finding: an EMPTY `_fieldRevisions` object (wiped / never-stamped
/// pusher) must degrade to the whole-row clock, not to "remote
/// touched nothing" — otherwise such a peer could never propagate a
/// change at all.
#[test]
fn empty_field_revisions_map_falls_back_to_whole_row_clock() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_remote_project_and_item(json!({}));

    // Local edit stamps a "local" watermark at real now.
    let mut update = WorkItemPartialUpdate::default();
    update.status = Some("in_review".to_string());
    update_work_item_partial("remote-project", "REM-0001", &update).expect("local edit");

    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({
                "id": "REM-0001",
                "projectId": "proj-remote",
                "shortId": "REM-0001",
                "title": "Teammate new title",
                "status": "backlog",
                "updatedAt": "2099-01-01T00:00:00Z",
                "_fieldRevisions": {},
            }),
            version: 2,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply");
    assert_eq!(applied, 1);

    let item = read_work_item("remote-project", "REM-0001").expect("item");
    assert_eq!(
        item.frontmatter.title, "Teammate new title",
        "with the whole-row fallback the newer remote row must win"
    );
    assert_eq!(
        item.frontmatter.status, "backlog",
        "pre-fix whole-row semantics: every field follows the row clock"
    );
}

/// Seed a remote-owned project (version 1, mtime
/// 2026-07-01T00:00:00Z) via `apply_remote`, so no local outbox
/// rows exist afterwards.
fn seed_remote_project() {
    apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_PROJECT.to_string(),
            payload: json!({
                "id": "proj-remote",
                "slug": "remote-project",
                "name": "Remote Project",
                "status": "active",
                "priority": "none",
                "health": "on_track",
                "workItemPrefix": "REM",
                "description": "original description",
                "updatedAt": "2026-07-01T00:00:00Z",
            }),
            version: 1,
            updated_by: None,
            deleted_at: None,
        }],
    )
    .expect("seed remote project");
    assert_eq!(pending_org_rows(), 0, "seeding must not echo");
}

/// Locally edit one field of `remote-project` through the normal
/// local write path (stamps a `("local", now)` watermark and
/// enqueues a bridge push).
fn edit_remote_project_locally(mutate: impl FnOnce(&mut ProjectMeta)) {
    let mut data = read_project("remote-project").expect("read project");
    // Keep the stored prefix explicit so the write path doesn't
    // re-derive it from the name (reads surface custom=false).
    data.meta.work_item_prefix_custom = true;
    mutate(&mut data.meta);
    write_project("remote-project", &data.meta, &data.description, false)
        .expect("local project edit");
}

/// Project parity with the work-item field-merge fix: a peer sends
/// a WHOLE-ROW project snapshot with `_fieldRevisions` naming only
/// the field it changed. A locally-edited field the remote did NOT
/// touch must survive even though the remote's whole-row
/// `updatedAt` is newer than the local edit — the exact case the
/// old whole-row-clock project merge got wrong (including after
/// the local edit was already pushed and acked).
#[test]
fn apply_remote_whole_row_project_snapshot_preserves_untouched_local_field() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_remote_project();

    // Local changes STATUS; its watermark is stamped at real now.
    edit_remote_project_locally(|meta| meta.status = "paused".to_string());
    assert!(pending_org_rows() >= 1, "local edit should be pending");

    // Teammate pushes a WHOLE-ROW snapshot (v2): they renamed the
    // project. `updatedAt` and name's mtime are far in the future
    // (newer than the local status edit), and `status` carries a
    // STALE value the teammate never touched — status is
    // deliberately ABSENT from `_fieldRevisions`.
    let future_ms: i64 = 4_070_908_800_000; // 2099-01-01
    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_PROJECT.to_string(),
            payload: json!({
                "id": "proj-remote",
                "slug": "remote-project",
                "name": "Teammate rename",
                "status": "active",
                "workItemPrefix": "REM",
                "updatedAt": "2099-01-01T00:00:00Z",
                "_fieldRevisions": { "name": future_ms },
            }),
            version: 2,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply merge");
    assert_eq!(applied, 1);

    let project = read_project("remote-project").expect("project");
    assert_eq!(
        project.meta.status, "paused",
        "a project field the remote did not touch must not be reverted by its whole-row snapshot"
    );
    assert_eq!(
        project.meta.name, "Teammate rename",
        "the field the remote genuinely changed is adopted"
    );
    assert!(
        pending_org_rows() >= 1,
        "the pending local push must not be consumed by the apply"
    );
}

/// Same-field latest-wins still holds under per-field project
/// mtimes: an OLDER remote watermark for a locally-edited field
/// keeps local, a NEWER one adopts remote.
#[test]
fn apply_remote_project_same_field_resolves_by_per_field_mtime() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_remote_project();

    // Local rename stamps `name` at real now.
    edit_remote_project_locally(|meta| meta.name = "Local rename".to_string());

    // v2: teammate's name mtime is OLDER than the local edit → keep local.
    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_PROJECT.to_string(),
            payload: json!({
                "id": "proj-remote",
                "slug": "remote-project",
                "name": "Stale teammate rename",
                "workItemPrefix": "REM",
                "updatedAt": "2026-07-01T00:00:30Z",
                "_fieldRevisions": { "name": 1_000_000_000_000_i64 }, // 2001
            }),
            version: 2,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply stale");
    assert_eq!(applied, 1);
    let project = read_project("remote-project").expect("project");
    assert_eq!(
        project.meta.name, "Local rename",
        "an older remote watermark must not beat the newer local edit"
    );

    // v3: teammate edits the SAME field with a NEWER mtime → adopt remote.
    let future_ms: i64 = 4_070_908_800_000; // 2099-01-01
    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_PROJECT.to_string(),
            payload: json!({
                "id": "proj-remote",
                "slug": "remote-project",
                "name": "Future teammate rename",
                "workItemPrefix": "REM",
                "updatedAt": "2099-01-01T00:00:00Z",
                "_fieldRevisions": { "name": future_ms },
            }),
            version: 3,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply newer");
    assert_eq!(applied, 1);
    let project = read_project("remote-project").expect("project");
    assert_eq!(
        project.meta.name, "Future teammate rename",
        "same-field latest-wins: the newer remote edit is adopted"
    );
}

/// An EMPTY `_fieldRevisions` object on a project row (wiped /
/// never-stamped pusher) must degrade to the pre-fix whole-row
/// clock, not to "remote touched nothing" — otherwise such a peer
/// could never propagate a project change at all.
#[test]
fn empty_project_field_revisions_falls_back_to_whole_row() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_remote_project();

    // Local edit stamps a "local" watermark at real now.
    edit_remote_project_locally(|meta| meta.status = "paused".to_string());

    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_PROJECT.to_string(),
            payload: json!({
                "id": "proj-remote",
                "slug": "remote-project",
                "name": "Teammate rename",
                "status": "active",
                "workItemPrefix": "REM",
                "updatedAt": "2099-01-01T00:00:00Z",
                "_fieldRevisions": {},
            }),
            version: 2,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply");
    assert_eq!(applied, 1);

    let project = read_project("remote-project").expect("project");
    assert_eq!(
        project.meta.name, "Teammate rename",
        "with the whole-row fallback the newer remote row must win"
    );
    assert_eq!(
        project.meta.status, "active",
        "pre-fix whole-row semantics: every field follows the row clock"
    );
}

/// Wire-builder side of the project parity fix: a drained project
/// push carries `_fieldRevisions` naming exactly the locally-edited
/// fields (untouched fields stay absent so peers keep their local
/// values).
#[test]
fn drain_project_carries_per_field_revisions() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_project("alpha");

    let mut data = read_project("alpha").expect("read project");
    data.meta.work_item_prefix_custom = true;
    data.meta.priority = "high".to_string();
    write_project("alpha", &data.meta, &data.description, false).expect("local edit");

    let items = drain_outbox(ORG, 50).expect("drain");
    let project = items
        .iter()
        .find(|item| item.kind == KIND_PROJECT)
        .expect("project push");
    let payload = project.payload.as_ref().expect("payload");
    let revisions = payload["_fieldRevisions"]
        .as_object()
        .expect("_fieldRevisions map");
    assert!(
        revisions.get("priority").and_then(Value::as_i64).is_some(),
        "the locally-edited field must carry its watermark: {:?}",
        revisions
    );
    assert!(
        !revisions.contains_key("name"),
        "untouched fields must stay absent from the wire map: {:?}",
        revisions
    );
}

#[test]
fn typed_properties_round_trip_and_preserve_pending_local_value() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_project("alpha");
    write_work_item(
        "alpha",
        "AAA-0001",
        &work_item_frontmatter("AAA-0001", "Typed properties"),
        "",
    )
    .expect("write item");
    let scope = WorkItemScope {
        project_slug: Some("alpha".to_string()),
        org_id: ORG.to_string(),
        work_item_id: "AAA-0001".to_string(),
    };
    crate::work_item_features::properties::upsert_definition(UpsertPropertyDefinitionRequest {
        id: Some("prop_effort".to_string()),
        org_id: ORG.to_string(),
        name: "Effort".to_string(),
        property_type: PropertyType::Number,
        description: None,
        config: PropertyConfig::default(),
        position: 0,
    })
    .expect("create property");
    crate::work_item_features::properties::set_value(SetWorkItemPropertyValueRequest {
        scope: scope.clone(),
        property_id: "prop_effort".to_string(),
        value: Some(json!(8)),
    })
    .expect("set value");

    let pushed = drain_outbox(ORG, 50).expect("drain typed property snapshot");
    let work_item = pushed
        .iter()
        .find(|item| item.kind == KIND_WORK_ITEM)
        .expect("work item push");
    let project = pushed
        .iter()
        .find(|item| item.kind == KIND_PROJECT)
        .expect("project definition carrier");
    let mut remote_payload = work_item.payload.clone().expect("work item payload");
    assert_eq!(
        project.payload.as_ref().unwrap()["propertyDefinitions"][0]["id"],
        "prop_effort"
    );
    assert_eq!(remote_payload["propertyDefinitions"], json!([]));
    assert_eq!(remote_payload["propertyValues"][0]["value"], json!(8));
    ack_outbox(
        pushed
            .iter()
            .map(|item| CollabAckResult {
                entry_ids: item.entry_ids.clone(),
                kind: item.kind.clone(),
                entity_id: item.entity_id.clone(),
                ok: true,
                remote_version: Some(1),
                error: None,
            })
            .collect(),
    )
    .expect("ack initial snapshot");

    remote_payload["propertyValues"][0]["value"] = json!(13);
    remote_payload["propertyValues"][0]["updatedAt"] = json!("2099-01-01T00:00:00Z");
    assert_eq!(
        apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: remote_payload.clone(),
                version: 2,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            }],
        )
        .expect("apply remote value"),
        1
    );
    let values = crate::work_item_features::properties::list_values(&scope)
        .expect("list remote property value");
    assert_eq!(values[0].value, json!(13));

    crate::work_item_features::properties::set_value(SetWorkItemPropertyValueRequest {
        scope: scope.clone(),
        property_id: "prop_effort".to_string(),
        value: Some(json!(21)),
    })
    .expect("set pending local value");
    remote_payload["propertyValues"][0]["value"] = json!(7);
    remote_payload["propertyValues"][0]["updatedAt"] = json!("2100-01-01T00:00:00Z");
    apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: remote_payload.clone(),
            version: 3,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply conflicting remote value");
    let values = crate::work_item_features::properties::list_values(&scope)
        .expect("list protected property value");
    assert_eq!(
        values[0].value,
        json!(21),
        "a pending local edit wins the OCC rebase for the same property"
    );
    let retry = drain_outbox(ORG, 50).expect("drain rebased property value");
    let retry_item = retry
        .iter()
        .find(|item| item.kind == KIND_WORK_ITEM)
        .expect("rebased work item");
    assert_eq!(retry_item.base_version, Some(3));
    assert_eq!(
        retry_item.payload.as_ref().unwrap()["propertyValues"][0]["value"],
        json!(21)
    );
    ack_outbox(
        retry
            .iter()
            .map(|item| CollabAckResult {
                entry_ids: item.entry_ids.clone(),
                kind: item.kind.clone(),
                entity_id: item.entity_id.clone(),
                ok: true,
                remote_version: Some(4),
                error: None,
            })
            .collect(),
    )
    .expect("ack rebased value");

    remote_payload["propertyValues"][0]["value"] = Value::Null;
    remote_payload["propertyValues"][0]["updatedAt"] = json!("2101-01-01T00:00:00Z");
    apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: remote_payload,
            version: 5,
            updated_by: Some("member-b".to_string()),
            deleted_at: None,
        }],
    )
    .expect("apply clear tombstone");
    assert!(
        crate::work_item_features::properties::list_values(&scope)
            .expect("list after clear")
            .is_empty(),
        "a remote null tombstone clears the visible value"
    );
}

#[test]
fn apply_remote_tombstone_soft_deletes() {
    let _sandbox = test_env::sandbox();
    seed_collab_org();
    seed_project("alpha");
    write_work_item(
        "alpha",
        "AAA-0001",
        &work_item_frontmatter("AAA-0001", "T"),
        "",
    )
    .expect("write item");
    // Simulate a prior sync so the tombstone version is newer.
    {
        let conn = io::conn().expect("conn");
        store_remote_version(&conn, KIND_WORK_ITEM, "AAA-0001", 1).expect("stamp");
    }

    let applied = apply_remote(
        ORG,
        None,
        vec![CollabRemoteEntity {
            kind: KIND_WORK_ITEM.to_string(),
            payload: json!({ "id": "AAA-0001" }),
            version: 2,
            updated_by: None,
            deleted_at: Some("2026-07-01T01:00:00Z".to_string()),
        }],
    )
    .expect("apply tombstone");
    assert_eq!(applied, 1);

    let item = read_work_item("alpha", "AAA-0001").expect("item");
    assert!(
        item.frontmatter.deleted_at.is_some(),
        "soft-deleted locally"
    );
}
