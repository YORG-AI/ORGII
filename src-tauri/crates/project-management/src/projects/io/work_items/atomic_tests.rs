//! Tests for the atomic RMW and partial-update wrappers in `super`.

#![allow(clippy::field_reassign_with_default)]
// These tests intentionally build partial updates one field at a time so each
// mutation remains adjacent to the behavior it exercises.

use super::*;
use crate::projects::io::projects::write_project;
use crate::projects::io::work_items::{
    read_standalone_work_item, read_work_item, write_standalone_work_item, write_work_item,
};
use crate::projects::io::{
    create_project_org, transition_standalone_work_item_handoff, transition_work_item_handoff,
    update_standalone_work_item_partial,
};
use crate::projects::types::{
    CommentEntry, CreateProjectOrgRequest, ProjectMeta, TodoEntry, WorkItemHandoff,
    WorkItemHandoffAction, WorkItemHandoffStatus, WorkItemHandoffTransition, WorkItemHistoryAction,
    WorkItemMutationActor, WorkItemPartialUpdate, WorkItemSchedule,
};
use test_helpers::test_env;

fn project_fixture(id: &str, name: &str) -> ProjectMeta {
    ProjectMeta {
        id: id.to_string(),
        name: name.to_string(),
        org_id: "personal-org".to_string(),
        status: "active".to_string(),
        priority: "none".to_string(),
        health: "no_updates".to_string(),
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

fn work_item_fixture(id: &str, short_id: &str, title: &str) -> WorkItemFrontmatter {
    WorkItemFrontmatter {
        id: id.to_string(),
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

fn seed(slug: &str, project_id: &str) {
    write_project(slug, &project_fixture(project_id, "Demo"), "", true).expect("project");
    let fm = work_item_fixture("w1", "AAA-0001", "Initial");
    write_work_item(slug, "AAA-0001", &fm, "body v1").expect("seed work item");
}

fn seed_standalone(org_id: &str) {
    create_project_org(&CreateProjectOrgRequest {
        name: "Team Org".to_string(),
        id: Some(org_id.to_string()),
    })
    .expect("create standalone org");
    let fm = work_item_fixture("standalone-w1", "ORG-0001", "Standalone");
    write_standalone_work_item(Some(org_id), "ORG-0001", &fm, "standalone body")
        .expect("seed standalone work item");
}

fn current_local_version(work_item_id: &str) -> i64 {
    let connection = conn().expect("conn");
    connection
        .query_row(
            "SELECT local_version FROM workitems WHERE id = ?1",
            [work_item_id],
            |row| row.get::<_, i64>(0),
        )
        .expect("local_version row")
}

#[test]
fn atomic_persists_closure_mutations_and_bumps_version() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");
    assert_eq!(current_local_version("w1"), 0);

    update_work_item_atomic("demo", "AAA-0001", |fm, body| {
        fm.title = "Renamed".to_string();
        fm.priority = "high".to_string();
        *body = "body v2".to_string();
        Ok::<(), String>(())
    })
    .expect("atomic");

    let after = read_work_item("demo", "AAA-0001").expect("read");
    assert_eq!(after.frontmatter.title, "Renamed");
    assert_eq!(after.frontmatter.priority, "high");
    assert_eq!(after.body, "body v2");
    assert_eq!(current_local_version("w1"), 1, "version must bump");
}

#[test]
fn partial_update_records_property_and_body_history() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let updates = WorkItemPartialUpdate {
        title: Some("Renamed".to_string()),
        body: Some("body v2".to_string()),
        priority: Some("high".to_string()),
        ..Default::default()
    };
    update_work_item_partial("demo", "AAA-0001", &updates).expect("update");

    let after = read_work_item("demo", "AAA-0001").expect("read");
    let event = after.frontmatter.history.last().expect("history event");
    assert_eq!(event.action, WorkItemHistoryAction::Updated);
    assert!(event.changes.iter().any(|change| change.field == "title"));
    assert!(event.changes.iter().any(|change| change.field == "body"));
    assert!(event
        .changes
        .iter()
        .any(|change| change.field == "priority"));
    assert_eq!(event.actor_id, None);
    assert_eq!(event.actor_name, None);
}

#[test]
fn partial_update_records_comment_history_event() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let updates = WorkItemPartialUpdate {
        comments: Some(vec![CommentEntry {
            id: "c1".to_string(),
            author: "member-1".to_string(),
            content: "Looks good".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            mentioned_user_ids: Vec::new(),
            ..Default::default()
        }]),
        actor: Some(WorkItemMutationActor {
            id: "member-1".to_string(),
            name: "Ada".to_string(),
        }),
        ..Default::default()
    };
    update_work_item_partial("demo", "AAA-0001", &updates).expect("update");

    let after = read_work_item("demo", "AAA-0001").expect("read");
    let event = after.frontmatter.history.last().expect("history event");
    assert_eq!(event.action, WorkItemHistoryAction::Commented);
    assert_eq!(event.actor_id.as_deref(), Some("member-1"));
    assert_eq!(event.actor_name.as_deref(), Some("Ada"));
    assert_eq!(event.changes.len(), 1);
    assert_eq!(event.changes[0].field, "comments");
}

#[test]
fn partial_update_records_project_move_history_event() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");
    write_project("dest", &project_fixture("p2", "Dest"), "", true).expect("project");

    let updates = WorkItemPartialUpdate {
        project: Some(Some("p2".to_string())),
        ..Default::default()
    };
    update_work_item_partial("demo", "AAA-0001", &updates).expect("move");

    let after = read_work_item("dest", "AAA-0001").expect("read moved");
    let event = after.frontmatter.history.last().expect("history event");
    assert_eq!(event.action, WorkItemHistoryAction::Moved);
    assert_eq!(event.changes[0].field, "project");
}

#[test]
fn atomic_returns_closure_value() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let returned: i32 = update_work_item_atomic("demo", "AAA-0001", |fm, _body| {
        fm.starred = true;
        Ok(42)
    })
    .expect("atomic");
    assert_eq!(returned, 42);
}

#[test]
fn atomic_rolls_back_on_closure_error() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let err: Result<(), String> = update_work_item_atomic("demo", "AAA-0001", |fm, body| {
        fm.title = "Should never persist".to_string();
        *body = "lost".to_string();
        Err("boom".to_string())
    });
    assert_eq!(err.as_ref().unwrap_err(), "boom");

    let after = read_work_item("demo", "AAA-0001").expect("read");
    assert_eq!(after.frontmatter.title, "Initial", "title untouched");
    assert_eq!(after.body, "body v1", "body untouched");
    assert_eq!(current_local_version("w1"), 0, "version not bumped");
}

#[test]
fn atomic_unknown_work_item_errors() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");
    let err = update_work_item_atomic::<(), _>("demo", "AAA-9999", |_, _| Ok(())).unwrap_err();
    assert!(err.contains("AAA-9999"));
}

#[test]
fn atomic_unknown_project_errors() {
    let _sandbox = test_env::sandbox();
    let err = update_work_item_atomic::<(), _>("ghost", "AAA-0001", |_, _| Ok(())).unwrap_err();
    assert!(err.contains("ghost"));
}

#[test]
fn atomic_can_mutate_extras_round_trip() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    update_work_item_atomic("demo", "AAA-0001", |fm, _body| {
        fm.todos.push(TodoEntry {
            id: "t1".into(),
            content: "wash dog".into(),
            status: "pending".into(),
        });
        fm.starred = true;
        Ok::<(), String>(())
    })
    .expect("atomic");

    let after = read_work_item("demo", "AAA-0001").expect("read");
    assert!(after.frontmatter.starred);
    assert_eq!(after.frontmatter.todos.len(), 1);
    assert_eq!(after.frontmatter.todos[0].content, "wash dog");
}

#[test]
fn atomic_replaces_label_set() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    update_work_item_atomic("demo", "AAA-0001", |fm, _body| {
        fm.labels = vec!["bug".into(), "urgent".into()];
        Ok::<(), String>(())
    })
    .expect("v1");

    let v1 = read_work_item("demo", "AAA-0001").expect("read v1");
    assert_eq!(v1.frontmatter.labels.len(), 2);

    update_work_item_atomic("demo", "AAA-0001", |fm, _body| {
        fm.labels = vec!["urgent".into()];
        Ok::<(), String>(())
    })
    .expect("v2");

    let v2 = read_work_item("demo", "AAA-0001").expect("read v2");
    assert_eq!(v2.frontmatter.labels, vec!["urgent".to_string()]);
}

#[test]
fn partial_title_only_preserves_other_fields() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let mut updates = WorkItemPartialUpdate::default();
    updates.title = Some("Patched".to_string());

    let result = update_work_item_partial("demo", "AAA-0001", &updates).expect("partial");
    assert_eq!(result.frontmatter.title, "Patched");
    assert_eq!(
        result.frontmatter.status, "backlog",
        "untouched fields kept"
    );
    assert_eq!(result.body, "body v1", "body kept");

    let on_disk = read_work_item("demo", "AAA-0001").expect("read");
    assert_eq!(on_disk.frontmatter.title, "Patched");
}

#[test]
fn partial_body_only_does_not_touch_frontmatter() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let mut updates = WorkItemPartialUpdate::default();
    updates.body = Some("rewritten body".to_string());

    let result = update_work_item_partial("demo", "AAA-0001", &updates).expect("partial");
    assert_eq!(result.body, "rewritten body");
    assert_eq!(result.frontmatter.title, "Initial");
}

#[test]
fn partial_clears_assignee_with_some_none() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let mut populate = WorkItemPartialUpdate::default();
    populate.assignee = Some(Some("alice".to_string()));
    update_work_item_partial("demo", "AAA-0001", &populate).expect("set assignee");

    let mut clear = WorkItemPartialUpdate::default();
    clear.assignee = Some(None);
    let result = update_work_item_partial("demo", "AAA-0001", &clear).expect("clear");
    assert!(result.frontmatter.assignee.is_none(), "assignee cleared");
}

#[test]
fn assignee_change_atomically_resets_team_inbox_receipts() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let mut assign_alice = WorkItemPartialUpdate::default();
    assign_alice.assignee = Some(Some("member-alice".to_string()));
    assign_alice.assignee_type = Some(Some("member".to_string()));
    update_work_item_partial("demo", "AAA-0001", &assign_alice).expect("assign alice");

    let connection = conn().expect("conn");
    connection
        .execute(
            "INSERT INTO team_inbox_read_receipts
                (viewer_member_id, source_kind, source_id, read_at)
             VALUES (?1, 'work_item_assigned', 'w1', 42)",
            ["member-alice"],
        )
        .expect("seed read receipt");
    drop(connection);

    let mut assign_bob = WorkItemPartialUpdate::default();
    assign_bob.assignee = Some(Some("member-bob".to_string()));
    update_work_item_partial("demo", "AAA-0001", &assign_bob).expect("assign bob");

    let connection = conn().expect("conn");
    let (assigned_human_id, receipt_count): (Option<String>, i64) = connection
        .query_row(
            "SELECT w.assigned_human_id,
                    (SELECT COUNT(*) FROM team_inbox_read_receipts r
                      WHERE r.source_kind = 'work_item_assigned'
                        AND r.source_id = w.id)
               FROM workitems w WHERE w.id = 'w1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("assignment projection");
    assert_eq!(assigned_human_id.as_deref(), Some("member-bob"));
    assert_eq!(
        receipt_count, 0,
        "the old assignment episode must not stay read"
    );
}

#[test]
fn returned_handoff_atomically_reassigns_sender_and_resets_receipts() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    update_work_item_atomic("demo", "AAA-0001", |frontmatter, _body| {
        frontmatter.assignee = Some("member-recipient".to_string());
        frontmatter.assignee_type = Some("member".to_string());
        frontmatter.handoff = Some(WorkItemHandoff {
            id: "handoff-1".to_string(),
            status: WorkItemHandoffStatus::Pending,
            sender_member_id: "member-sender".to_string(),
            sender_name: "Ada".to_string(),
            recipient_member_id: "member-recipient".to_string(),
            recipient_name: "Lin".to_string(),
            note: Some("Continue the investigation".to_string()),
            requested_at: "2026-07-28T10:00:00Z".to_string(),
            responded_at: None,
            response_note: None,
        });
        Ok::<(), String>(())
    })
    .expect("seed handoff");

    let connection = conn().expect("conn");
    connection
        .execute(
            "INSERT INTO team_inbox_read_receipts
                (viewer_member_id, source_kind, source_id, read_at)
             VALUES ('member-recipient', 'work_item_assigned', 'w1', 42)",
            [],
        )
        .expect("seed recipient receipt");
    drop(connection);

    let result = transition_work_item_handoff(
        "demo",
        "AAA-0001",
        &WorkItemHandoffTransition {
            handoff_id: "handoff-1".to_string(),
            action: WorkItemHandoffAction::Return,
            actor: WorkItemMutationActor {
                id: "member-recipient".to_string(),
                name: "Lin".to_string(),
            },
            note: Some("Please add reproduction steps".to_string()),
        },
    )
    .expect("return handoff");

    assert_eq!(
        result.frontmatter.assignee.as_deref(),
        Some("member-sender")
    );
    let handoff = result.frontmatter.handoff.expect("persisted handoff");
    assert_eq!(handoff.status, WorkItemHandoffStatus::Returned);
    assert_eq!(
        handoff.response_note.as_deref(),
        Some("Please add reproduction steps")
    );
    let history = result.frontmatter.history.last().expect("history event");
    assert_eq!(history.actor_id.as_deref(), Some("member-recipient"));
    assert!(history
        .changes
        .iter()
        .any(|change| change.field == "handoff"));
    assert!(history
        .changes
        .iter()
        .any(|change| change.field == "assignee"));

    let connection = conn().expect("conn");
    let receipt_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM team_inbox_read_receipts
              WHERE source_kind = 'work_item_assigned' AND source_id = 'w1'",
            [],
            |row| row.get(0),
        )
        .expect("receipt count");
    assert_eq!(receipt_count, 0);
}

#[test]
fn standalone_partial_update_persists_collaboration_fields_atomically() {
    let _sandbox = test_env::sandbox();
    seed_standalone("org-team");

    let result = update_standalone_work_item_partial(
        Some("org-team"),
        "ORG-0001",
        &WorkItemPartialUpdate {
            status: Some("in_progress".to_string()),
            priority: Some("high".to_string()),
            assignee: Some(Some("member-b".to_string())),
            assignee_type: Some(Some("member".to_string())),
            target_date: Some(Some("2026-08-01T00:00:00.000Z".to_string())),
            todos: Some(vec![TodoEntry {
                id: "todo-1".to_string(),
                content: "Verify the handoff".to_string(),
                status: "completed".to_string(),
            }]),
            comments: Some(vec![CommentEntry {
                id: "comment-1".to_string(),
                author: "member-b".to_string(),
                content: "@Ada ready for review".to_string(),
                created_at: "2026-07-29T09:00:00.000Z".to_string(),
                mentioned_user_ids: vec!["member-a".to_string()],
                ..Default::default()
            }]),
            actor: Some(WorkItemMutationActor {
                id: "member-b".to_string(),
                name: "Lin".to_string(),
            }),
            ..Default::default()
        },
    )
    .expect("update standalone work item");

    assert_eq!(result.frontmatter.status, "in_progress");
    assert_eq!(result.frontmatter.priority, "high");
    assert_eq!(result.frontmatter.assignee.as_deref(), Some("member-b"));
    assert_eq!(result.frontmatter.todos[0].status, "completed");
    assert_eq!(
        result.frontmatter.comments[0].mentioned_user_ids,
        vec!["member-a".to_string()]
    );

    let persisted =
        read_standalone_work_item(Some("org-team"), "ORG-0001").expect("read standalone");
    assert_eq!(persisted.frontmatter.status, "in_progress");
    assert_eq!(persisted.frontmatter.priority, "high");
    assert_eq!(
        persisted.frontmatter.target_date.as_deref(),
        Some("2026-08-01T00:00:00.000Z")
    );
    assert_eq!(persisted.frontmatter.todos.len(), 1);
    assert_eq!(persisted.frontmatter.comments.len(), 1);
    assert!(persisted.frontmatter.history.iter().any(|event| {
        event.actor_id.as_deref() == Some("member-b")
            && event
                .changes
                .iter()
                .any(|change| change.field == "assignee")
    }));
    assert_eq!(current_local_version("standalone-w1"), 1);
}

#[test]
fn standalone_return_handoff_reassigns_to_original_sender() {
    let _sandbox = test_env::sandbox();
    seed_standalone("org-team");

    update_standalone_work_item_partial(
        Some("org-team"),
        "ORG-0001",
        &WorkItemPartialUpdate {
            assignee: Some(Some("member-b".to_string())),
            assignee_type: Some(Some("member".to_string())),
            handoff: Some(Some(WorkItemHandoff {
                id: "standalone-handoff".to_string(),
                status: WorkItemHandoffStatus::Pending,
                sender_member_id: "member-a".to_string(),
                sender_name: "Ada".to_string(),
                recipient_member_id: "member-b".to_string(),
                recipient_name: "Lin".to_string(),
                note: Some("Please continue".to_string()),
                requested_at: "2026-07-29T09:00:00.000Z".to_string(),
                responded_at: None,
                response_note: None,
            })),
            ..Default::default()
        },
    )
    .expect("seed standalone handoff");

    let result = transition_standalone_work_item_handoff(
        Some("org-team"),
        "ORG-0001",
        &WorkItemHandoffTransition {
            handoff_id: "standalone-handoff".to_string(),
            action: WorkItemHandoffAction::Return,
            actor: WorkItemMutationActor {
                id: "member-b".to_string(),
                name: "Lin".to_string(),
            },
            note: Some("Need the original reproduction".to_string()),
        },
    )
    .expect("return standalone handoff");

    assert_eq!(result.frontmatter.assignee.as_deref(), Some("member-a"));
    let handoff = result.frontmatter.handoff.expect("handoff");
    assert_eq!(handoff.status, WorkItemHandoffStatus::Returned);
    assert_eq!(
        handoff.response_note.as_deref(),
        Some("Need the original reproduction")
    );
}

#[test]
fn non_human_assignee_is_excluded_from_assigned_human_projection() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let mut assign_agent = WorkItemPartialUpdate::default();
    assign_agent.assignee = Some(Some("agent-1".to_string()));
    assign_agent.assignee_type = Some(Some("agent".to_string()));
    update_work_item_partial("demo", "AAA-0001", &assign_agent).expect("assign agent");

    let connection = conn().expect("conn");
    let assigned_human_id: Option<String> = connection
        .query_row(
            "SELECT assigned_human_id FROM workitems WHERE id = 'w1'",
            [],
            |row| row.get(0),
        )
        .expect("assigned_human_id");
    assert_eq!(assigned_human_id, None);
}

#[test]
fn partial_nullable_fields_json_null_deserializes_as_explicit_clear() {
    let updates: WorkItemPartialUpdate = serde_json::from_value(serde_json::json!({
        "project": null,
        "assignee": null,
        "assigneeType": null,
        "milestone": null,
        "startDate": null,
        "targetDate": null,
        "schedule": null
    }))
    .expect("deserialize");

    assert_eq!(updates.project, Some(None));
    assert_eq!(updates.assignee, Some(None));
    assert_eq!(updates.assignee_type, Some(None));
    assert_eq!(updates.milestone, Some(None));
    assert_eq!(updates.start_date, Some(None));
    assert_eq!(updates.target_date, Some(None));
    assert_eq!(updates.schedule, Some(None));

    let omitted: WorkItemPartialUpdate =
        serde_json::from_value(serde_json::json!({})).expect("deserialize omitted");
    assert_eq!(omitted.project, None);
    assert_eq!(omitted.assignee, None);
    assert_eq!(omitted.assignee_type, None);
    assert_eq!(omitted.milestone, None);
    assert_eq!(omitted.start_date, None);
    assert_eq!(omitted.target_date, None);
    assert_eq!(omitted.schedule, None);
}

#[test]
fn partial_clears_assignee_from_json_null() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let mut populate = WorkItemPartialUpdate::default();
    populate.assignee = Some(Some("alice".to_string()));
    populate.assignee_type = Some(Some("agent".to_string()));
    update_work_item_partial("demo", "AAA-0001", &populate).expect("set assignee");

    let clear: WorkItemPartialUpdate = serde_json::from_value(serde_json::json!({
        "assignee": null,
        "assigneeType": null
    }))
    .expect("deserialize clear");
    let result = update_work_item_partial("demo", "AAA-0001", &clear).expect("clear");
    assert!(result.frontmatter.assignee.is_none(), "assignee cleared");
    assert!(
        result.frontmatter.assignee_type.is_none(),
        "assignee type cleared"
    );
}

#[test]
fn partial_clears_schedule_from_json_null() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let mut populate = WorkItemPartialUpdate::default();
    populate.schedule = Some(Some(WorkItemSchedule {
        at: Some("2026-05-19T09:00:00.000Z".to_string()),
        cron: None,
        enabled: true,
        last_run: None,
    }));
    update_work_item_partial("demo", "AAA-0001", &populate).expect("set schedule");

    let clear: WorkItemPartialUpdate =
        serde_json::from_value(serde_json::json!({ "schedule": null })).expect("deserialize clear");
    let result = update_work_item_partial("demo", "AAA-0001", &clear).expect("clear");
    assert!(result.frontmatter.schedule.is_none(), "schedule cleared");
}

#[test]
fn partial_moves_between_project_and_standalone_scopes() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");
    write_project("other", &project_fixture("p2", "Other"), "", true).expect("project p2");

    let mut set_project = WorkItemPartialUpdate::default();
    set_project.project = Some(Some("p2".to_string()));
    let with_project =
        update_work_item_partial("demo", "AAA-0001", &set_project).expect("set project");
    assert_eq!(with_project.frontmatter.project.as_deref(), Some("p2"));
    assert!(read_work_item("demo", "AAA-0001").is_err());
    assert_eq!(
        read_work_item("other", "AAA-0001")
            .expect("read moved work item")
            .frontmatter
            .project
            .as_deref(),
        Some("p2")
    );

    let mut clear_project = WorkItemPartialUpdate::default();
    clear_project.project = Some(None);
    let without_project =
        update_work_item_partial("other", "AAA-0001", &clear_project).expect("clear project");
    assert!(without_project.frontmatter.project.is_none());
    assert!(read_work_item("other", "AAA-0001").is_err());
    assert_eq!(
        read_standalone_work_item(Some("personal-org"), "AAA-0001")
            .expect("read standalone work item")
            .frontmatter
            .project,
        None
    );
}

#[test]
fn partial_combo_status_priority_starred_in_one_call() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let mut updates = WorkItemPartialUpdate::default();
    updates.status = Some("in_progress".to_string());
    updates.priority = Some("urgent".to_string());
    updates.starred = Some(true);

    let result = update_work_item_partial("demo", "AAA-0001", &updates).expect("partial");
    assert_eq!(result.frontmatter.status, "in_progress");
    assert_eq!(result.frontmatter.priority, "urgent");
    assert!(result.frontmatter.starred);
}

#[test]
fn partial_replaces_label_set() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let mut first = WorkItemPartialUpdate::default();
    first.labels = Some(vec!["a".into(), "b".into()]);
    update_work_item_partial("demo", "AAA-0001", &first).expect("first");

    let mut second = WorkItemPartialUpdate::default();
    second.labels = Some(vec!["c".into()]);
    let result = update_work_item_partial("demo", "AAA-0001", &second).expect("second");
    assert_eq!(result.frontmatter.labels, vec!["c".to_string()]);
}

#[test]
fn partial_appends_comment_via_full_replace_semantics() {
    // The wire shape is "full replace": callers send the new full
    // comment list. The previous comment is gone if it's not in the new
    // list, and the new one shows up.
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let mut first = WorkItemPartialUpdate::default();
    first.comments = Some(vec![CommentEntry {
        id: "c1".into(),
        author: "alice".into(),
        content: "first".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
        mentioned_user_ids: Vec::new(),
        ..Default::default()
    }]);
    update_work_item_partial("demo", "AAA-0001", &first).expect("first");

    let mut second = WorkItemPartialUpdate::default();
    second.comments = Some(vec![CommentEntry {
        id: "c2".into(),
        author: "bob".into(),
        content: "replaced".into(),
        created_at: "2026-01-02T00:00:00Z".into(),
        mentioned_user_ids: Vec::new(),
        ..Default::default()
    }]);
    let result = update_work_item_partial("demo", "AAA-0001", &second).expect("second");
    assert_eq!(result.frontmatter.comments.len(), 1);
    assert_eq!(result.frontmatter.comments[0].id, "c2");
}

#[test]
fn partial_bumps_updated_at_timestamp() {
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    let before = read_work_item("demo", "AAA-0001").expect("read before");
    std::thread::sleep(std::time::Duration::from_millis(5));

    let mut updates = WorkItemPartialUpdate::default();
    updates.title = Some("Touched".into());
    let result = update_work_item_partial("demo", "AAA-0001", &updates).expect("partial");

    assert_ne!(
        result.frontmatter.updated_at, before.frontmatter.updated_at,
        "updated_at should advance"
    );
}

// ---------------------------------------------------------------------------
// Sync metadata preservation, local stamping, outbox emission
// ---------------------------------------------------------------------------

mod phase_4_5 {
    //! Invariants for the atomic + partial RMW path:
    //!
    //! - existing `field_revisions` and `external_refs` survive
    //!   user-driven mutations (the RMW must never wipe sync metadata),
    //! - fields that actually changed get stamped with a fresh
    //!   `REVISION_SOURCE_LOCAL` watermark — and only the ones that
    //!   changed,
    //! - bound projects emit an outbox `update` entry per partial call,
    //!   carrying the changed-field payload,
    //! - unbound projects do not emit anything,
    //! - `update_work_item_atomic_with_revisions` allows the merge cycle
    //!   to override the source so the sync apply path can stamp the
    //!   adapter id (e.g. `"echo"`) atomically with the field write.
    use super::*;
    use crate::projects::io::work_items::sync_metadata::{
        apply_remote_merge, read_sync_metadata, FieldRevision, REVISION_SOURCE_LOCAL,
    };
    use crate::sync::io as outbox_io;
    use crate::sync::types::{OutboxOp, OutboxStatus};

    fn set_sync_kind(slug: &str, kind: &str) {
        let connection = conn().expect("conn");
        let sync_connection_id = format!("connection-{slug}");
        connection
            .execute(
                "UPDATE projects SET sync_kind = ?1, sync_connection_id = ?2 WHERE slug = ?3",
                rusqlite::params![kind, sync_connection_id, slug],
            )
            .expect("set sync_kind");
    }

    /// Seeding a synthetic sync metadata blob via `apply_remote_merge`
    /// then mutating an unrelated field via the user-driven RMW path
    /// must leave `field_revisions` and `external_refs` untouched.
    /// Regression test for the bug where
    /// `ExtrasPayload::from_frontmatter` discarded sync metadata on
    /// every update.
    #[test]
    fn user_update_preserves_existing_field_revisions_and_external_refs() {
        let _sandbox = test_env::sandbox();
        seed("demo", "p1");

        // Pretend the sync framework already stamped this row from
        // adapter "echo" at remote_updated_at = 1_700_000_000_000.
        let mut revisions = HashMap::new();
        revisions.insert(
            "title".to_string(),
            FieldRevision {
                mtime: 1_700_000_000_000,
                source: "echo".to_string(),
            },
        );
        revisions.insert(
            "status".to_string(),
            FieldRevision {
                mtime: 1_700_000_000_000,
                source: "echo".to_string(),
            },
        );
        apply_remote_merge(
            "demo",
            "AAA-0001",
            revisions,
            Some(("echo".to_string(), "ext-42".to_string())),
        )
        .expect("seed sync metadata");

        // Mutate `priority` only — `title` / `status` are untouched.
        let mut updates = WorkItemPartialUpdate::default();
        updates.priority = Some("high".to_string());
        update_work_item_partial("demo", "AAA-0001", &updates).expect("partial");

        let meta = read_sync_metadata("demo", "AAA-0001")
            .expect("read meta")
            .expect("meta exists");
        // External ref survives.
        assert_eq!(
            meta.external_refs.get("echo").map(String::as_str),
            Some("ext-42"),
            "user update must not wipe external_refs"
        );
        // Untouched-field revisions survive verbatim.
        let title_rev = meta
            .field_revisions
            .get("title")
            .expect("title revision survives");
        assert_eq!(title_rev.source, "echo");
        assert_eq!(title_rev.mtime, 1_700_000_000_000);
        let status_rev = meta
            .field_revisions
            .get("status")
            .expect("status revision survives");
        assert_eq!(status_rev.source, "echo");
        assert_eq!(status_rev.mtime, 1_700_000_000_000);
    }

    /// A user-driven mutation stamps `REVISION_SOURCE_LOCAL` on every
    /// field that actually changed, and only on those fields.
    /// `updated_at` is not in the stamped set even though the RMW
    /// always rewrites the timestamp — sync only cares about
    /// semantic fields.
    #[test]
    fn user_update_stamps_local_revision_only_on_changed_fields() {
        let _sandbox = test_env::sandbox();
        seed("demo", "p1");

        let mut updates = WorkItemPartialUpdate::default();
        updates.title = Some("New title".to_string());
        updates.priority = Some("urgent".to_string());
        update_work_item_partial("demo", "AAA-0001", &updates).expect("partial");

        let meta = read_sync_metadata("demo", "AAA-0001")
            .expect("read")
            .expect("meta");
        let title = meta
            .field_revisions
            .get("title")
            .expect("title was stamped");
        assert_eq!(title.source, REVISION_SOURCE_LOCAL);
        assert!(title.mtime > 0, "mtime is a unix-ms timestamp");
        let priority = meta
            .field_revisions
            .get("priority")
            .expect("priority was stamped");
        assert_eq!(priority.source, REVISION_SOURCE_LOCAL);

        // Status was never touched and was not in `updates` — it must
        // not appear in the revisions map.
        assert!(
            !meta.field_revisions.contains_key("status"),
            "untouched field must not be stamped"
        );
    }

    /// Setting a field to its current value is a no-op: the diff is
    /// empty so no revision is stamped.
    #[test]
    fn user_update_does_not_stamp_when_value_unchanged() {
        let _sandbox = test_env::sandbox();
        seed("demo", "p1");

        // The seed work item starts with title = "Initial" — set it
        // to itself.
        let mut updates = WorkItemPartialUpdate::default();
        updates.title = Some("Initial".to_string());
        update_work_item_partial("demo", "AAA-0001", &updates).expect("partial");

        let meta = read_sync_metadata("demo", "AAA-0001")
            .expect("read")
            .expect("meta");
        assert!(
            !meta.field_revisions.contains_key("title"),
            "no-op write must not stamp a revision"
        );
    }

    /// Mutating a bound project emits exactly one outbox `update`
    /// entry whose payload lists the changed fields. Mutating the
    /// same project a second time appends a second entry.
    #[test]
    fn user_update_on_bound_project_emits_outbox_update() {
        let _sandbox = test_env::sandbox();
        seed("demo", "p1");
        set_sync_kind("demo", "echo");

        let mut updates = WorkItemPartialUpdate::default();
        updates.title = Some("First touch".to_string());
        update_work_item_partial("demo", "AAA-0001", &updates).expect("partial");

        let connection = outbox_io::conn().expect("conn");
        let entries = outbox_io::list_for_project(&connection, "demo").expect("list");
        let updates_only: Vec<_> = entries
            .iter()
            .filter(|e| matches!(e.op, OutboxOp::Update))
            .collect();
        assert_eq!(updates_only.len(), 1, "one outbox update per partial call");
        let entry = updates_only[0];
        assert_eq!(entry.entity_id, "AAA-0001");
        assert_eq!(entry.status, OutboxStatus::Pending);
        let payload: serde_json::Value =
            serde_json::from_str(&entry.payload_json).expect("payload is json");
        assert_eq!(
            payload.get("title").and_then(|v| v.as_str()),
            Some("First touch"),
            "payload carries the changed field"
        );
    }

    /// A mutation against a project that is *not* sync-bound (its
    /// `sync_kind` column is NULL) must not emit any outbox entry —
    /// that would queue garbage that no adapter can ever drain.
    #[test]
    fn user_update_on_unbound_project_emits_nothing() {
        let _sandbox = test_env::sandbox();
        seed("demo", "p1");
        // No `set_sync_kind` call — project stays unbound.

        let mut updates = WorkItemPartialUpdate::default();
        updates.title = Some("Touched".to_string());
        update_work_item_partial("demo", "AAA-0001", &updates).expect("partial");

        let connection = outbox_io::conn().expect("conn");
        let entries = outbox_io::list_for_project(&connection, "demo").expect("list");
        assert!(
            entries.is_empty(),
            "unbound project must not emit outbox entries (got {entries:?})"
        );
    }

    /// The closure-form `update_work_item_atomic` is the path agent
    /// tools and the scheduler use. Closures touching sync-tracked
    /// fields (e.g. status flips from the scheduler, agent-driven
    /// title/priority edits) must also emit an outbox `update` entry
    /// on bound projects, exactly like the partial-update wrapper does.
    #[test]
    fn closure_form_atomic_on_bound_project_emits_outbox() {
        let _sandbox = test_env::sandbox();
        seed("demo", "p1");
        set_sync_kind("demo", "echo");

        update_work_item_atomic("demo", "AAA-0001", |fm, _body| {
            fm.title = "Closure-form rename".to_string();
            fm.priority = "urgent".to_string();
            Ok::<(), String>(())
        })
        .expect("atomic");

        let connection = outbox_io::conn().expect("conn");
        let entries = outbox_io::list_for_project(&connection, "demo").expect("list");
        let updates_only: Vec<_> = entries
            .iter()
            .filter(|e| matches!(e.op, OutboxOp::Update))
            .collect();
        assert_eq!(
            updates_only.len(),
            1,
            "one outbox update per closure-form atomic call that changes sync-tracked fields"
        );
        let entry = updates_only[0];
        assert_eq!(entry.entity_id, "AAA-0001");
        let payload: serde_json::Value =
            serde_json::from_str(&entry.payload_json).expect("payload is json");
        assert_eq!(
            payload.get("title").and_then(|v| v.as_str()),
            Some("Closure-form rename")
        );
        assert_eq!(
            payload.get("priority").and_then(|v| v.as_str()),
            Some("urgent")
        );
    }

    /// Closure-form atomic on a bound project that touches only
    /// orchestrator-internal fields (no sync-tracked diff) emits
    /// nothing — orchestrator state and follow-up items don't push to
    /// Linear/GitHub.
    #[test]
    fn closure_form_atomic_skips_outbox_for_non_sync_fields() {
        let _sandbox = test_env::sandbox();
        seed("demo", "p1");
        set_sync_kind("demo", "echo");

        update_work_item_atomic("demo", "AAA-0001", |fm, _body| {
            fm.starred = true;
            Ok::<(), String>(())
        })
        .expect("atomic");

        let connection = outbox_io::conn().expect("conn");
        let entries = outbox_io::list_for_project(&connection, "demo").expect("list");
        let updates_only: Vec<_> = entries
            .iter()
            .filter(|e| matches!(e.op, OutboxOp::Update))
            .collect();
        assert!(
            updates_only.is_empty(),
            "no outbox emission when only non-sync-tracked fields changed (got {updates_only:?})"
        );
    }

    /// `update_work_item_partial_with_revisions` is the merge-cycle
    /// entry point: it accepts an explicit revision map so the
    /// resolver-decided source (e.g. `"echo"`) is stamped atomically
    /// with the field write, and it must NOT emit an outbox update —
    /// the change came from the remote, bouncing it back would loop.
    #[test]
    fn merge_path_stamps_override_source_and_skips_outbox() {
        let _sandbox = test_env::sandbox();
        seed("demo", "p1");
        set_sync_kind("demo", "echo");

        let mut overrides = HashMap::new();
        overrides.insert(
            "title".to_string(),
            FieldRevision {
                mtime: 1_700_000_000_000,
                source: "echo".to_string(),
            },
        );
        let mut updates = WorkItemPartialUpdate::default();
        updates.title = Some("Remote-driven".to_string());
        update_work_item_partial_with_revisions("demo", "AAA-0001", overrides, &updates)
            .expect("partial with revisions");

        // Field landed.
        let after = read_work_item("demo", "AAA-0001").expect("read");
        assert_eq!(after.frontmatter.title, "Remote-driven");

        // Revision is stamped with the override source, not "local".
        let meta = read_sync_metadata("demo", "AAA-0001")
            .expect("read meta")
            .expect("meta");
        let rev = meta
            .field_revisions
            .get("title")
            .expect("title was stamped");
        assert_eq!(rev.source, "echo", "override source must win");
        assert_eq!(rev.mtime, 1_700_000_000_000);

        // No outbox bounce-back.
        let connection = outbox_io::conn().expect("conn");
        let entries = outbox_io::list_for_project(&connection, "demo").expect("list");
        let updates_only: Vec<_> = entries
            .iter()
            .filter(|e| matches!(e.op, OutboxOp::Update))
            .collect();
        assert!(
            updates_only.is_empty(),
            "merge-path writes must not bounce back into the outbox (got {updates_only:?})"
        );
    }
}

#[test]
fn atomic_two_calls_serialize_and_both_persist() {
    // SQLite's IMMEDIATE tx serializes the two writes and both
    // mutations land. Not a true concurrency stress test (no threads
    // here), but it locks down the contract that sequential atomic
    // calls compose correctly — the second call sees the result of the
    // first.
    let _sandbox = test_env::sandbox();
    seed("demo", "p1");

    update_work_item_atomic("demo", "AAA-0001", |fm, _| {
        fm.priority = "high".to_string();
        Ok::<(), String>(())
    })
    .expect("first");

    update_work_item_atomic("demo", "AAA-0001", |fm, _| {
        assert_eq!(fm.priority, "high", "second sees first's write");
        fm.status = "in_progress".to_string();
        Ok::<(), String>(())
    })
    .expect("second");

    let after = read_work_item("demo", "AAA-0001").expect("read");
    assert_eq!(after.frontmatter.priority, "high");
    assert_eq!(after.frontmatter.status, "in_progress");
    assert_eq!(current_local_version("w1"), 2, "both writes bumped version");
}
