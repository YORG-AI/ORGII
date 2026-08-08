use rusqlite::Connection;
use serde_json::json;

use super::store::{
    list_page_with_connection, mark_all_read_with_connection, mark_read_with_connection,
    mark_unread_with_connection, unread_count_with_connection, work_item_summary_excerpt,
};
use super::{
    schema::init_team_inbox_tables, TeamInboxActor, TeamInboxCursor, TeamInboxFilter,
    TeamInboxItem, TeamInboxItemKind, TeamInboxListOptions, TeamInboxPayload, TeamInboxTarget,
};
use crate::projects::schema::init_project_tables;
use crate::projects::types::WorkItemHandoffStatus;

fn database() -> Connection {
    let connection = Connection::open_in_memory().expect("open in-memory database");
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .expect("enable foreign keys");
    init_project_tables(&connection).expect("initialize project schema");
    connection
}

fn insert_project(connection: &Connection, id: &str, slug: &str) {
    connection
        .execute(
            "INSERT INTO projects
                (id, name, slug, short_id_prefix, linked_repos_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'TST', ?4, 1, 1)",
            (
                id,
                format!("Project {id}"),
                slug,
                r#"["https://github.com/org2AI/ORG2.git"]"#,
            ),
        )
        .expect("insert project");
}

struct WorkItemFixture<'a> {
    id: &'a str,
    short_id: &'a str,
    title: &'a str,
    project_id: Option<&'a str>,
    assigned_human_id: Option<&'a str>,
    assignee: Option<&'a str>,
    assignee_type: Option<&'a str>,
    updated_at: i64,
    deleted_at: Option<i64>,
}

fn insert_work_item(connection: &Connection, item: WorkItemFixture<'_>) {
    connection
        .execute(
            "INSERT INTO workitems
                (id, org_id, project_id, short_id, title, status, priority,
                 assigned_human_id, assignee, assignee_type, created_at, updated_at, deleted_at)
             VALUES (?1, 'personal-org', ?2, ?3, ?4, 'in_progress', 'high',
                     ?5, ?6, ?7, ?8, ?8, ?9)",
            (
                item.id,
                item.project_id,
                item.short_id,
                item.title,
                item.assigned_human_id,
                item.assignee,
                item.assignee_type,
                item.updated_at,
                item.deleted_at,
            ),
        )
        .expect("insert work item");
}

fn set_work_item_status(connection: &Connection, work_item_id: &str, status: &str) {
    connection
        .execute(
            "UPDATE workitems SET status = ?2 WHERE id = ?1",
            (work_item_id, status),
        )
        .expect("update work item status");
}

fn options(viewers: &[&str], limit: usize) -> TeamInboxListOptions {
    TeamInboxListOptions {
        viewer_member_ids: viewers.iter().map(|value| (*value).to_string()).collect(),
        filter: TeamInboxFilter::All,
        cursor: None,
        limit,
    }
}

#[test]
fn canonical_schema_creates_viewer_scoped_receipts_without_migration() {
    let connection = Connection::open_in_memory().expect("open database");
    init_team_inbox_tables(&connection).expect("initialize team inbox schema");
    init_team_inbox_tables(&connection).expect("schema initialization is idempotent");

    let columns = connection
        .prepare("PRAGMA table_info(team_inbox_read_receipts)")
        .expect("prepare columns")
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query columns")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect columns");
    assert_eq!(
        columns,
        ["viewer_member_id", "source_kind", "source_id", "read_at"]
    );
}

#[test]
fn dto_contract_keeps_comment_mention_variant_stable() {
    let item = TeamInboxItem {
        id: "comment_mention:comment-1".into(),
        kind: TeamInboxItemKind::CommentMention,
        occurred_at: 42,
        read_at: None,
        actor: Some(TeamInboxActor {
            id: "member-2".into(),
            display_name: "Teammate".into(),
            avatar_url: None,
        }),
        target: TeamInboxTarget::Comment {
            session_id: "session-1".into(),
            comment_id: "comment-1".into(),
            anchor: Some("comment-comment-1".into()),
        },
        payload: TeamInboxPayload::CommentMention {
            session_title: "Fix auth".into(),
            comment_excerpt: "@me can you review?".into(),
            comment_count: 3,
        },
    };

    assert_eq!(
        serde_json::to_value(item).expect("serialize DTO"),
        json!({
            "id": "comment_mention:comment-1",
            "kind": "comment_mention",
            "occurredAt": 42,
            "actor": {"id": "member-2", "displayName": "Teammate"},
            "target": {
                "type": "comment",
                "sessionId": "session-1",
                "commentId": "comment-1",
                "anchor": "comment-comment-1"
            },
            "payload": {
                "type": "comment_mention",
                "sessionTitle": "Fix auth",
                "commentExcerpt": "@me can you review?",
                "commentCount": 3
            }
        })
    );
}

#[test]
fn global_query_returns_only_local_items_assigned_to_explicit_viewers() {
    let connection = database();
    insert_project(&connection, "project-1", "alpha");
    insert_work_item(
        &connection,
        WorkItemFixture {
            id: "work-1",
            short_id: "TST-1",
            title: "Assigned by canonical human column",
            project_id: Some("project-1"),
            assigned_human_id: Some("member-a"),
            assignee: None,
            assignee_type: None,
            updated_at: 30,
            deleted_at: None,
        },
    );
    insert_work_item(
        &connection,
        WorkItemFixture {
            id: "work-2",
            short_id: "TST-2",
            title: "Standalone legacy member assignment",
            project_id: None,
            assigned_human_id: None,
            assignee: Some("member-alias"),
            assignee_type: Some("member"),
            updated_at: 20,
            deleted_at: None,
        },
    );
    for (id, assignee, assignee_type, deleted_at) in [
        ("work-agent", "member-a", Some("agent"), None),
        ("work-other", "member-other", Some("member"), None),
        ("work-deleted", "member-a", Some("member"), Some(99)),
    ] {
        insert_work_item(
            &connection,
            WorkItemFixture {
                id,
                short_id: id,
                title: id,
                project_id: Some("project-1"),
                assigned_human_id: None,
                assignee: Some(assignee),
                assignee_type,
                updated_at: 10,
                deleted_at,
            },
        );
    }

    let page = list_page_with_connection(&connection, options(&["member-a", "member-alias"], 50))
        .expect("list assigned items");
    assert_eq!(
        page.items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["work_item_assigned:work-1", "work_item_assigned:work-2"]
    );
    assert_eq!(page.unread_count, 2);
    assert!(matches!(
        &page.items[0].target,
        TeamInboxTarget::WorkItem {
            project_slug: Some(slug),
            repository: Some(repository),
            ..
        } if slug == "alpha" && repository == "https://github.com/org2AI/ORG2.git"
    ));
    assert_eq!(
        serde_json::to_value(&page.items[0].target).expect("serialize Work Item target"),
        json!({
            "type": "work_item",
            "workItemId": "work-1",
            "shortId": "TST-1",
            "orgId": "personal-org",
            "projectId": "project-1",
            "projectSlug": "alpha",
            "repository": "https://github.com/org2AI/ORG2.git"
        })
    );
    assert!(matches!(
        &page.items[1].target,
        TeamInboxTarget::WorkItem {
            project_id: None,
            project_slug: None,
            repository: None,
            ..
        }
    ));
}

#[test]
fn terminal_assignments_are_not_actionable_or_counted_as_unread() {
    let mut connection = database();
    for (index, status) in [
        "in_progress",
        "completed",
        "cancelled",
        "canceled",
        "duplicate",
        "closed",
        "done",
        "Done",
    ]
    .into_iter()
    .enumerate()
    {
        let id = format!("work-{index}");
        insert_work_item(
            &connection,
            WorkItemFixture {
                id: &id,
                short_id: &id,
                title: status,
                project_id: None,
                assigned_human_id: Some("member-a"),
                assignee: None,
                assignee_type: None,
                updated_at: 100 - index as i64,
                deleted_at: None,
            },
        );
        set_work_item_status(&connection, &id, status);
    }

    let page = list_page_with_connection(&connection, options(&["member-a"], 50))
        .expect("list actionable assignments");
    assert_eq!(
        page.items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["work_item_assigned:work-0"]
    );
    assert_eq!(page.unread_count, 1);
    assert!(!mark_read_with_connection(
        &mut connection,
        &["member-a".into()],
        "work_item_assigned:work-5",
        1000,
    )
    .expect("closed assignment is not actionable"));
    assert_eq!(
        mark_all_read_with_connection(
            &mut connection,
            &["member-a".into()],
            TeamInboxFilter::Assigned,
            1000,
        )
        .expect("mark all actionable assignments read"),
        1
    );
    assert_eq!(
        unread_count_with_connection(&connection, &["member-a".into()], TeamInboxFilter::Assigned)
            .expect("assigned unread count"),
        0
    );
}

#[test]
fn cursor_is_stable_for_equal_timestamps_and_newer_insertions() {
    let connection = database();
    for id in ["work-c", "work-b", "work-a"] {
        insert_work_item(
            &connection,
            WorkItemFixture {
                id,
                short_id: id,
                title: id,
                project_id: None,
                assigned_human_id: Some("member-a"),
                assignee: None,
                assignee_type: None,
                updated_at: 100,
                deleted_at: None,
            },
        );
    }
    let first =
        list_page_with_connection(&connection, options(&["member-a"], 2)).expect("first page");
    assert_eq!(
        first
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["work_item_assigned:work-c", "work_item_assigned:work-b"]
    );
    assert_eq!(
        first.next_cursor,
        Some(TeamInboxCursor {
            occurred_at: 100,
            item_id: "work_item_assigned:work-b".into()
        })
    );

    insert_work_item(
        &connection,
        WorkItemFixture {
            id: "work-new",
            short_id: "work-new",
            title: "newer",
            project_id: None,
            assigned_human_id: Some("member-a"),
            assignee: None,
            assignee_type: None,
            updated_at: 200,
            deleted_at: None,
        },
    );
    let second = list_page_with_connection(
        &connection,
        TeamInboxListOptions {
            cursor: first.next_cursor,
            ..options(&["member-a"], 2)
        },
    )
    .expect("second page");
    assert_eq!(
        second
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ["work_item_assigned:work-a"]
    );
}

#[test]
fn read_receipts_and_bulk_read_are_viewer_scoped_and_idempotent() {
    let mut connection = database();
    for (id, assignee) in [("work-a", "member-a"), ("work-b", "member-b")] {
        insert_work_item(
            &connection,
            WorkItemFixture {
                id,
                short_id: id,
                title: id,
                project_id: None,
                assigned_human_id: Some(assignee),
                assignee: None,
                assignee_type: None,
                updated_at: 100,
                deleted_at: None,
            },
        );
    }

    assert!(mark_read_with_connection(
        &mut connection,
        &["member-a".into()],
        "work_item_assigned:work-a",
        1000,
    )
    .expect("mark read"));
    assert!(mark_read_with_connection(
        &mut connection,
        &["member-a".into()],
        "work_item_assigned:work-a",
        900,
    )
    .expect("repeat mark read"));
    let read_at: i64 = connection
        .query_row(
            "SELECT read_at FROM team_inbox_read_receipts
              WHERE viewer_member_id = 'member-a' AND source_id = 'work-a'",
            [],
            |row| row.get(0),
        )
        .expect("read receipt");
    assert_eq!(
        read_at, 1000,
        "older retries must not move read_at backward"
    );
    assert_eq!(
        unread_count_with_connection(&connection, &["member-a".into()], TeamInboxFilter::Assigned)
            .expect("member a unread"),
        0
    );
    assert_eq!(
        unread_count_with_connection(&connection, &["member-b".into()], TeamInboxFilter::Assigned)
            .expect("member b unread"),
        1
    );

    assert_eq!(
        mark_all_read_with_connection(
            &mut connection,
            &["member-b".into()],
            TeamInboxFilter::All,
            2000,
        )
        .expect("mark all"),
        1
    );
    assert_eq!(
        mark_all_read_with_connection(
            &mut connection,
            &["member-b".into()],
            TeamInboxFilter::All,
            2000,
        )
        .expect("repeat mark all"),
        0
    );
}

#[test]
fn work_item_comment_mentions_are_viewer_scoped_and_readable() {
    let mut connection = database();
    insert_work_item(
        &connection,
        WorkItemFixture {
            id: "work-a",
            short_id: "TST-1",
            title: "Assigned",
            project_id: None,
            assigned_human_id: Some("member-a"),
            assignee: None,
            assignee_type: None,
            updated_at: 10,
            deleted_at: None,
        },
    );
    connection
        .execute(
            "INSERT INTO workitem_extras (work_item_id, extras_json)
             VALUES (?1, ?2)",
            (
                "work-a",
                json!({
                    "comments": [{
                        "id": "comment-1",
                        "author": "member-b",
                        "content": "Please review this",
                        "created_at": "2026-07-29T08:00:00Z",
                        "mentioned_user_ids": ["member-a"]
                    }]
                })
                .to_string(),
            ),
        )
        .expect("insert comment extras");
    let page = list_page_with_connection(
        &connection,
        TeamInboxListOptions {
            filter: TeamInboxFilter::Mentions,
            ..options(&["member-a"], 10)
        },
    )
    .expect("list mentions");
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.unread_count, 1);
    assert_eq!(page.items[0].kind, TeamInboxItemKind::CommentMention);
    assert!(matches!(
        page.items[0].target,
        TeamInboxTarget::WorkItemComment { ref comment_id, .. }
            if comment_id == "comment-1"
    ));

    let item_id = page.items[0].id.clone();
    assert!(
        mark_read_with_connection(&mut connection, &["member-a".into()], &item_id, 123)
            .expect("mark mention read")
    );
    let page = list_page_with_connection(
        &connection,
        TeamInboxListOptions {
            filter: TeamInboxFilter::Mentions,
            ..options(&["member-a"], 10)
        },
    )
    .expect("list read mentions");
    assert_eq!(page.unread_count, 0);
    assert_eq!(page.items[0].read_at, Some(123));
}

#[test]
fn explicit_viewer_ids_are_required() {
    let connection = database();
    let error = list_page_with_connection(&connection, options(&["", "  "], 10))
        .expect_err("empty viewer identities must fail");
    assert!(error.contains("viewerMemberIds"));
}

#[test]
fn mark_unread_clears_receipt_and_restores_unread_count() {
    let mut connection = database();
    insert_work_item(
        &connection,
        WorkItemFixture {
            id: "work-a",
            short_id: "TST-1",
            title: "Assigned",
            project_id: None,
            assigned_human_id: Some("member-a"),
            assignee: None,
            assignee_type: None,
            updated_at: 10,
            deleted_at: None,
        },
    );

    assert!(mark_read_with_connection(
        &mut connection,
        &["member-a".into()],
        "work_item_assigned:work-a",
        1000,
    )
    .expect("mark read"));
    assert_eq!(
        unread_count_with_connection(&connection, &["member-a".into()], TeamInboxFilter::Assigned)
            .expect("unread after read"),
        0
    );

    assert!(mark_unread_with_connection(
        &mut connection,
        &["member-a".into()],
        "work_item_assigned:work-a",
    )
    .expect("mark unread"));
    assert_eq!(
        unread_count_with_connection(&connection, &["member-a".into()], TeamInboxFilter::Assigned)
            .expect("unread after unread"),
        1
    );

    assert!(
        !mark_unread_with_connection(
            &mut connection,
            &["member-a".into()],
            "work_item_assigned:work-a",
        )
        .expect("repeat mark unread"),
        "second mark-unread deletes nothing and reports no change"
    );
    assert_eq!(
        unread_count_with_connection(&connection, &["member-a".into()], TeamInboxFilter::Assigned)
            .expect("unread stays after idempotent unread"),
        1
    );
}

#[test]
fn summary_excerpt_folds_whitespace_and_trims() {
    assert_eq!(
        work_item_summary_excerpt("  Investigate the\n  flaky auth test  "),
        Some("Investigate the flaky auth test".to_string())
    );
}

#[test]
fn summary_excerpt_is_none_for_blank_body() {
    assert_eq!(work_item_summary_excerpt(""), None);
    assert_eq!(work_item_summary_excerpt("   \n\t "), None);
}

#[test]
fn summary_excerpt_truncates_long_body_on_char_boundary() {
    let excerpt = work_item_summary_excerpt(&"x".repeat(300)).expect("non-empty excerpt");
    assert_eq!(excerpt.chars().count(), 241);
    assert!(excerpt.ends_with('…'));
}

#[test]
fn assigned_item_carries_body_excerpt_as_summary() {
    let connection = database();
    connection
        .execute(
            "INSERT INTO workitems
                (id, org_id, short_id, title, body, status, priority,
                 assigned_human_id, created_at, updated_at)
             VALUES ('work-b', 'personal-org', 'TST-9', 'Body item',
                     '  Investigate the flaky auth test  ',
                     'in_progress', 'high', 'member-a', 5, 5)",
            [],
        )
        .expect("insert work item with body");
    let page =
        list_page_with_connection(&connection, options(&["member-a"], 10)).expect("list page");
    let summary = match &page.items[0].payload {
        TeamInboxPayload::WorkItemAssigned { summary, .. } => summary.clone(),
        other => panic!("expected assigned payload, got {other:?}"),
    };
    assert_eq!(summary.as_deref(), Some("Investigate the flaky auth test"));
}

#[test]
fn assigned_item_projects_durable_handoff_context() {
    let connection = database();
    insert_project(&connection, "project-1", "alpha");
    insert_work_item(
        &connection,
        WorkItemFixture {
            id: "work-handoff",
            short_id: "TST-10",
            title: "Continue the investigation",
            project_id: Some("project-1"),
            assigned_human_id: Some("member-recipient"),
            assignee: Some("member-recipient"),
            assignee_type: Some("member"),
            updated_at: 10,
            deleted_at: None,
        },
    );
    connection
        .execute(
            "INSERT INTO workitem_extras (work_item_id, extras_json)
             VALUES ('work-handoff', ?1)",
            [json!({
                "handoff": {
                    "id": "handoff-1",
                    "status": "pending",
                    "senderMemberId": "member-sender",
                    "senderName": "Ada",
                    "recipientMemberId": "member-recipient",
                    "recipientName": "Lin",
                    "note": "Continue from the failing test.",
                    "requestedAt": "2026-07-28T10:00:00Z"
                }
            })
            .to_string()],
        )
        .expect("insert handoff extras");

    let page = list_page_with_connection(&connection, options(&["member-recipient"], 10))
        .expect("list handoff");
    assert_eq!(
        page.items[0].actor.as_ref().map(|actor| actor.id.as_str()),
        Some("member-sender")
    );
    match &page.items[0].payload {
        TeamInboxPayload::WorkItemAssigned {
            handoff: Some(handoff),
            ..
        } => {
            assert_eq!(handoff.status, WorkItemHandoffStatus::Pending);
            assert_eq!(handoff.sender_name, "Ada");
            assert_eq!(
                handoff.note.as_deref(),
                Some("Continue from the failing test.")
            );
        }
        other => panic!("expected assigned handoff payload, got {other:?}"),
    }
}

#[test]
fn assigned_item_projects_the_actor_from_the_current_assignment_episode() {
    let connection = database();
    insert_project(&connection, "project-1", "alpha");
    insert_work_item(
        &connection,
        WorkItemFixture {
            id: "work-assigned",
            short_id: "TST-11",
            title: "Review notification flow",
            project_id: Some("project-1"),
            assigned_human_id: Some("member-recipient"),
            assignee: Some("member-recipient"),
            assignee_type: Some("member"),
            updated_at: 30,
            deleted_at: None,
        },
    );
    connection
        .execute(
            "INSERT INTO workitem_extras (work_item_id, extras_json)
             VALUES ('work-assigned', ?1)",
            [json!({
                "history": [
                    {
                        "id": "created",
                        "action": "created",
                        "timestamp": "2026-07-28T09:00:00Z",
                        "actorId": "member-creator",
                        "actorName": "Creator"
                    },
                    {
                        "id": "assigned",
                        "action": "updated",
                        "timestamp": "2026-07-28T10:00:00Z",
                        "actorId": "member-sender",
                        "actorName": "Ada",
                        "changes": [{
                            "field": "assignee",
                            "oldValue": null,
                            "newValue": "member-recipient"
                        }]
                    },
                    {
                        "id": "status",
                        "action": "updated",
                        "timestamp": "2026-07-28T11:00:00Z",
                        "actorId": "member-editor",
                        "actorName": "Later editor",
                        "changes": [{
                            "field": "status",
                            "oldValue": "todo",
                            "newValue": "in_progress"
                        }]
                    }
                ]
            })
            .to_string()],
        )
        .expect("insert assignment history");

    let page = list_page_with_connection(&connection, options(&["member-recipient"], 10))
        .expect("list assignment");
    assert_eq!(
        page.items[0].actor,
        Some(TeamInboxActor {
            id: "member-sender".into(),
            display_name: "Ada".into(),
            avatar_url: None,
        })
    );
}
