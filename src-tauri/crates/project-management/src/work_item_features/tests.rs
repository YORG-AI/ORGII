use axum::body::{to_bytes, Bytes};
use axum::extract::Path;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::json;
use test_helpers::test_env;

use super::*;
use crate::projects::io::helpers::conn;
use crate::projects::types::{
    AgentRole, LinkedSession, LinkedSessionStatus, LinkedSessionType, MentionTarget,
    OrchestratorConfig, WorkItemCloseOut, WorkItemCloseOutStatus, WorkItemWorkProduct,
    WorkItemWorkProductStatus, WorkItemWorkProductType,
};
use crate::routine_service::spec::{Activation, ActivationPolicies, RoutineSpecFile};
use crate::work_service::{self, CreateWorkItemRequest};

fn scope() -> WorkItemScope {
    WorkItemScope {
        project_slug: Some("demo".to_string()),
        org_id: "personal-org".to_string(),
        work_item_id: "AAA-0001".to_string(),
    }
}

fn seed(linked_session: bool) {
    work_service::tests_support::seed_project("demo", "project-1");
    work_service::create_project_work_item(
        "demo",
        "AAA-0001",
        &CreateWorkItemRequest {
            title: "Durable collaboration".to_string(),
            body: "Ship the durable path and notify <@member-description>.".to_string(),
            created_by: Some("creator-1".to_string()),
            linked_sessions: linked_session
                .then(|| LinkedSession {
                    session_id: "session-1".to_string(),
                    session_type: LinkedSessionType::Native,
                    agent_role: AgentRole::Coding,
                    started_at: "2026-08-08T10:00:00Z".to_string(),
                    completed_at: None,
                    status: LinkedSessionStatus::Running,
                    cost_usd: 0.0,
                    total_tokens: 0,
                    parent_session_id: None,
                    sub_agent_name: None,
                    sub_agent_instance: None,
                    result_preview: None,
                })
                .into_iter()
                .collect(),
            ..Default::default()
        },
        None,
    )
    .expect("seed Work Item");
}

fn post(comment_id: &str, content: &str, parent_id: Option<&str>) -> DiscussionPostResult {
    post_with_mentions(comment_id, content, parent_id, Vec::new())
}

fn post_with_mentions(
    comment_id: &str,
    content: &str,
    parent_id: Option<&str>,
    mentions: Vec<MentionTarget>,
) -> DiscussionPostResult {
    discussion::post(DiscussionPostRequest {
        scope: scope(),
        comment_id: comment_id.to_string(),
        author_id: "member-1".to_string(),
        author_name: "Member One".to_string(),
        content: content.to_string(),
        mentioned_user_ids: Vec::new(),
        mentions,
        parent_id: parent_id.map(str::to_string),
        target_session_id: None,
    })
    .expect("post Discussion comment")
}

#[test]
fn discussion_comment_and_run_are_atomic_and_threads_reopen_on_reply() {
    let _sandbox = test_env::sandbox();
    seed(true);

    let root = post("comment-root", "Please include the retry proof.", None);
    assert_eq!(root.wake_reason, "latest_session");
    assert!(
        root.run.is_some(),
        "a linked Session must be woken through a Run"
    );
    work_service::note_project_work_item_threaded(
        "demo",
        "AAA-0001",
        "comment",
        "Agent receipt",
        Some("comment-root"),
        None,
        Some("session-1"),
    )
    .expect("append agent receipt in the same thread");

    let note = post("comment-note", "/note internal context only", None);
    assert_eq!(note.wake_reason, "note_only");
    assert!(note.run.is_none(), "/note must persist without dispatching");

    let reply = post(
        "comment-reply",
        "The proof is attached.",
        Some("comment-root"),
    );
    assert_eq!(reply.comment.thread_id.as_deref(), Some("comment-root"));
    assert_eq!(reply.wake_reason, "thread_owner");
    let resolved = discussion::resolve_thread(DiscussionThreadMutation {
        scope: scope(),
        thread_id: "comment-root".to_string(),
        actor_id: "reviewer-1".to_string(),
        conclusion_comment_id: Some("comment-reply".to_string()),
    })
    .expect("resolve thread");
    assert!(resolved
        .iter()
        .any(|comment| comment.id == "comment-reply" && comment.conclusion));

    let reopened = post(
        "comment-after-resolution",
        "One more question.",
        Some("comment-reply"),
    );
    assert!(reopened.thread_reopened);
    let item = crate::projects::io::read_work_item("demo", "AAA-0001").expect("read item");
    let root = item
        .frontmatter
        .comments
        .iter()
        .find(|comment| comment.id == "comment-root")
        .expect("root comment");
    assert!(root.resolved_at.is_none());
    assert!(item.frontmatter.comments.iter().any(|comment| {
        comment.content == "Agent receipt"
            && comment.parent_id.as_deref() == Some("comment-root")
            && comment.thread_id.as_deref() == Some("comment-root")
    }));
    assert!(!item
        .frontmatter
        .comments
        .iter()
        .any(|comment| comment.id == "comment-reply" && comment.conclusion));

    let connection = conn().expect("connection");
    let run_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_work_item_runs WHERE work_item_id = 'AAA-0001'",
            [],
            |row| row.get(0),
        )
        .expect("run count");
    let outbox_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM pm_dispatch_outbox", [], |row| {
            row.get(0)
        })
        .expect("outbox count");
    assert_eq!(
        run_count, 1,
        "consecutive waking comments coalesce into one open wake window"
    );
    assert_eq!(outbox_count, run_count);
    let input_json: String = connection
        .query_row(
            "SELECT input_json FROM pm_work_item_runs WHERE work_item_id = 'AAA-0001'",
            [],
            |row| row.get(0),
        )
        .expect("wake input");
    let input: serde_json::Value = serde_json::from_str(&input_json).expect("wake input json");
    let merged_ids = input["discussionCommentIds"]
        .as_array()
        .expect("merged comment ids")
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect::<Vec<_>>();
    assert_eq!(
        merged_ids,
        vec![
            "comment-root".to_string(),
            "comment-reply".to_string(),
            "comment-after-resolution".to_string()
        ],
        "the window carries every merged comment in arrival order"
    );
}

#[test]
fn discussion_wake_window_closes_once_the_dispatcher_claims_it() {
    let _sandbox = test_env::sandbox();
    seed(true);

    let first = post("comment-first", "Please include the retry proof.", None);
    let first_run = first.run.expect("first wake run");

    let connection = conn().expect("connection");
    connection
        .execute(
            "UPDATE pm_dispatch_outbox SET status = 'leased' WHERE run_id = ?1",
            rusqlite::params![first_run.id],
        )
        .expect("simulate dispatcher claim");

    let second = post("comment-second", "One more detail.", None);
    let second_run = second.run.expect("second wake run");
    assert_ne!(
        second_run.id, first_run.id,
        "a claimed window must not absorb new comments"
    );

    let run_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_work_item_runs WHERE work_item_id = 'AAA-0001'",
            [],
            |row| row.get(0),
        )
        .expect("run count");
    assert_eq!(run_count, 2, "window close opens a fresh deferred wake");
}

#[test]
fn discussion_mutation_commits_a_collaboration_outbox_row() {
    let _sandbox = test_env::sandbox();
    seed(false);
    crate::projects::io::configure_project_org_collab_sync("personal-org", Some("personal-org"))
        .expect("enable collaboration");

    post("comment-collab", "/note visible on peers", None);

    let connection = conn().expect("connection");
    let row: (String, String) = connection
        .query_row(
            "SELECT o.status, o.field_path
               FROM outbox_entries o
               JOIN workitems w ON w.id = o.entity_id
              WHERE o.org_id = 'personal-org'
                AND o.entity_type = 'work_item'
                AND w.short_id = 'AAA-0001'
              ORDER BY o.id DESC
              LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("discussion collaboration row");
    assert_eq!(row.0, "pending");
    assert_eq!(row.1, "comments");
}

#[test]
fn discussion_routing_rejects_mentions_outside_the_configured_agent() {
    let _sandbox = test_env::sandbox();
    seed(true);

    let unroutable = post_with_mentions(
        "comment-mention-unknown",
        "Please take a look.",
        None,
        vec![MentionTarget::Agent {
            id: "agent-unknown".to_string(),
        }],
    );
    assert_eq!(unroutable.wake_reason, "mention_unroutable");
    assert!(
        unroutable.run.is_none(),
        "unroutable mentions must not wake"
    );
}

fn seed_with_config(linked_session: bool, agent_definition_id: &str) {
    work_service::tests_support::seed_project("demo", "project-1");
    work_service::create_project_work_item(
        "demo",
        "AAA-0001",
        &CreateWorkItemRequest {
            title: "Routing fixture".to_string(),
            body: "Route this discussion.".to_string(),
            created_by: Some("creator-1".to_string()),
            orchestrator_config: Some(OrchestratorConfig {
                agent_definition_id: Some(agent_definition_id.to_string()),
                ..Default::default()
            }),
            linked_sessions: linked_session
                .then(|| LinkedSession {
                    session_id: "session-1".to_string(),
                    session_type: LinkedSessionType::Native,
                    agent_role: AgentRole::Coding,
                    started_at: "2026-08-08T10:00:00Z".to_string(),
                    completed_at: None,
                    status: LinkedSessionStatus::Running,
                    cost_usd: 0.0,
                    total_tokens: 0,
                    parent_session_id: None,
                    sub_agent_name: None,
                    sub_agent_instance: None,
                    result_preview: None,
                })
                .into_iter()
                .collect(),
            ..Default::default()
        },
        None,
    )
    .expect("seed Work Item");
}

#[test]
fn discussion_routing_resumes_the_configured_agent_on_mention() {
    let _sandbox = test_env::sandbox();
    seed_with_config(true, "builtin:sde");

    let mentioned = post_with_mentions(
        "comment-mention-agent",
        "Please take a look.",
        None,
        vec![MentionTarget::Agent {
            id: "builtin:sde".to_string(),
        }],
    );
    assert_eq!(mentioned.wake_reason, "mention");
    assert_eq!(
        mentioned.comment.agent_session_id.as_deref(),
        Some("session-1")
    );
    assert!(mentioned.run.is_some());
}

#[test]
fn discussion_routing_starts_the_assigned_agent_without_sessions() {
    let _sandbox = test_env::sandbox();
    seed_with_config(false, "builtin:sde");

    let root = post("comment-root", "Kick this off please.", None);
    assert_eq!(root.wake_reason, "assignee_start");
    assert!(
        root.run.is_some(),
        "assigned agent must be started through a Run"
    );
    assert!(root.comment.agent_session_id.is_none());
}

#[test]
fn discussion_preview_reports_assignee_start() {
    let _sandbox = test_env::sandbox();
    seed_with_config(false, "builtin:sde");

    let preview = discussion::preview(DiscussionTriggerPreviewRequest {
        scope: scope(),
        content: "please take a look".to_string(),
        mentions: Vec::new(),
        parent_id: None,
        target_session_id: None,
    })
    .expect("preview");
    assert!(preview.will_wake);
    assert_eq!(preview.reason, "assignee_start");
    assert_eq!(preview.target_kind.as_deref(), Some("start"));
    assert!(!preview.will_coalesce);
}

#[test]
fn subscriptions_coalesce_updates_but_keep_mentions_separate() {
    let _sandbox = test_env::sandbox();
    seed(false);
    subscriptions::subscribe(SubscriptionMutation {
        scope: scope(),
        subscriber_id: "watcher-1".to_string(),
    })
    .expect("subscribe watcher");

    for (id, body) in [("comment-1", "first"), ("comment-2", "second")] {
        discussion::post(DiscussionPostRequest {
            scope: scope(),
            comment_id: id.to_string(),
            author_id: "author-1".to_string(),
            author_name: "Author".to_string(),
            content: body.to_string(),
            mentioned_user_ids: vec!["mentioned-1".to_string()],
            mentions: Vec::new(),
            parent_id: None,
            target_session_id: None,
        })
        .expect("post comment");
    }

    let connection = conn().expect("connection");
    let watcher_events: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_work_item_inbox_events
              WHERE recipient_id = 'watcher-1' AND kind = 'discussion_updated'",
            [],
            |row| row.get(0),
        )
        .expect("watcher event count");
    let mention_events: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_work_item_inbox_events
              WHERE recipient_id = 'mentioned-1' AND kind = 'mention'",
            [],
            |row| row.get(0),
        )
        .expect("mention event count");
    assert_eq!(watcher_events, 1, "ordinary updates coalesce per Work Item");
    assert_eq!(mention_events, 2, "mentions are never coalesced away");

    let page = crate::team_inbox::list_page(crate::team_inbox::TeamInboxListOptions {
        viewer_member_ids: vec!["watcher-1".to_string()],
        filter: crate::team_inbox::TeamInboxFilter::All,
        cursor: None,
        limit: 20,
    })
    .expect("project subscription event into Team Inbox");
    assert!(page.items.iter().any(|item| {
        item.kind == crate::team_inbox::TeamInboxItemKind::WorkItemUpdated
            && matches!(
                &item.payload,
                crate::team_inbox::TeamInboxPayload::WorkItemUpdated { event_kind, .. }
                    if event_kind == "discussion_updated"
            )
    }));
}

#[test]
fn typed_properties_validate_values_and_keep_archived_history() {
    let _sandbox = test_env::sandbox();
    seed(false);
    let definition = properties::upsert_definition(UpsertPropertyDefinitionRequest {
        id: Some("prop_effort".to_string()),
        org_id: "personal-org".to_string(),
        name: "Effort".to_string(),
        property_type: PropertyType::Number,
        description: None,
        config: PropertyConfig::default(),
        position: 0,
    })
    .expect("create property");
    let invalid = properties::set_value(SetWorkItemPropertyValueRequest {
        scope: scope(),
        property_id: definition.id.clone(),
        value: Some(json!("large")),
    })
    .expect_err("number property rejects text");
    assert!(invalid.contains("expects a number"), "{invalid}");

    properties::set_value(SetWorkItemPropertyValueRequest {
        scope: scope(),
        property_id: definition.id.clone(),
        value: Some(json!(8.5)),
    })
    .expect("set number");
    let renamed = properties::upsert_definition(UpsertPropertyDefinitionRequest {
        id: Some(definition.id.clone()),
        org_id: "personal-org".to_string(),
        name: "Estimated effort".to_string(),
        property_type: PropertyType::Number,
        description: None,
        config: PropertyConfig::default(),
        position: 0,
    })
    .expect("rename property");
    assert_eq!(
        renamed.id, definition.id,
        "renames preserve property identity"
    );
    properties::archive_definition(&definition.id).expect("archive property");

    let values = properties::list_values(&scope()).expect("list historical values");
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].definition.name, "Estimated effort");
    assert!(values[0].definition.archived_at.is_some());
    assert_eq!(values[0].value, json!(8.5));
}

#[test]
fn pr_readiness_requires_current_execution_evidence_and_close_intent() {
    let _sandbox = test_env::sandbox();
    seed(false);
    let product = WorkItemWorkProduct {
        id: "pr-1".to_string(),
        session_id: Some("session-1".to_string()),
        product_type: WorkItemWorkProductType::PullRequest,
        title: "PR #123".to_string(),
        provider: Some("github".to_string()),
        external_id: Some("123".to_string()),
        url: Some("https://github.com/org/repo/pull/123".to_string()),
        status: Some(WorkItemWorkProductStatus::Merged),
        review_state: None,
        is_primary: true,
        summary: None,
        metadata: serde_json::Map::from_iter([
            ("mergeable".to_string(), json!(true)),
            ("ciStatus".to_string(), json!("success")),
        ]),
        created_at: "2026-08-08T10:00:00Z".to_string(),
        updated_at: "2026-08-08T10:05:00Z".to_string(),
    };
    let close_out = WorkItemCloseOut {
        status: WorkItemCloseOutStatus::Done,
        session_id: Some("session-1".to_string()),
        reviewer_target: None,
        summary: Some("Merged and ready to close".to_string()),
        decision_reason: None,
        next_owner: None,
        created_at: Some("2026-08-08T10:05:00Z".to_string()),
        resolved_at: Some("2026-08-08T10:05:00Z".to_string()),
    };
    let connection = conn().expect("connection");
    let row_id: String = connection
        .query_row(
            "SELECT id FROM workitems WHERE short_id = 'AAA-0001'",
            [],
            |row| row.get(0),
        )
        .expect("row id");
    connection
        .execute(
            "UPDATE workitem_extras SET extras_json = ?2 WHERE work_item_id = ?1",
            rusqlite::params![
                row_id,
                json!({
                    "work_products": [product],
                    "close_out": close_out,
                })
                .to_string()
            ],
        )
        .expect("persist PR evidence");

    let ready = readiness::get(&scope()).expect("ready state");
    assert!(ready.can_complete, "{:?}", ready.blockers);

    let request = crate::projects::types::EnqueueWorkItemRunRequest {
        project_slug: Some("demo".to_string()),
        org_id: "personal-org".to_string(),
        work_item_id: "AAA-0001".to_string(),
        trigger: crate::projects::types::WorkItemRunTrigger::Manual,
        target_snapshot: crate::projects::types::WorkItemRunTargetSnapshot::new(
            crate::projects::types::WorkItemRunTarget::StartWorkItem {
                account_id: None,
                model_id: None,
            },
        ),
        input: json!({}),
        idempotency_key: "readiness-snapshot".to_string(),
        max_attempts: 1,
        parent_run_id: None,
    };
    crate::work_run_service::enqueue(request).expect("capture execution snapshot");
    connection
        .execute(
            "UPDATE workitems SET local_version = local_version + 1 WHERE id = ?1",
            rusqlite::params![row_id],
        )
        .expect("advance Work Item revision");
    let stale = readiness::get(&scope()).expect("stale state");
    assert!(stale.snapshot_stale);
    assert!(!stale.can_complete);
    assert!(readiness::guard_completion(&scope()).is_err());
}

fn routine_fixture() -> RoutineSpecFile {
    let raw = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/orgtrack-pm-protocol/fixtures/routine-spec.json"),
    )
    .expect("fixture readable");
    let mut file: RoutineSpecFile = serde_json::from_str(&raw).expect("fixture parses");
    file.spec.activations.push(Activation::ProviderEvent {
        provider: "github".to_string(),
        event_kind: "pull_request".to_string(),
        filter: Some(json!({ "action": "closed" })),
        policies: ActivationPolicies::default(),
    });
    file
}

#[tokio::test]
async fn provider_webhook_authenticates_filters_and_deduplicates_deliveries() {
    let _sandbox = test_env::sandbox();
    let fixture = routine_fixture();
    crate::routine_service::apply(&fixture).expect("apply Routine");
    let install = routine_webhook::install(&fixture.metadata.name).expect("install webhook");

    let mut invalid_headers = HeaderMap::new();
    invalid_headers.insert("x-org2-webhook-token", HeaderValue::from_static("wrong"));
    invalid_headers.insert("x-org2-provider", HeaderValue::from_static("github"));
    invalid_headers.insert("x-org2-event", HeaderValue::from_static("pull_request"));
    invalid_headers.insert("x-org2-delivery-id", HeaderValue::from_static("delivery-1"));
    let invalid = routine_webhook::handle_http(
        Path(fixture.metadata.name.clone()),
        invalid_headers,
        Bytes::from_static(br#"{"action":"opened"}"#),
    )
    .await;
    assert_eq!(invalid.status(), StatusCode::UNAUTHORIZED);

    let request_headers = || {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-org2-webhook-token",
            HeaderValue::from_str(&install.secret).expect("secret header"),
        );
        headers.insert("x-org2-provider", HeaderValue::from_static("github"));
        headers.insert("x-org2-event", HeaderValue::from_static("pull_request"));
        headers.insert("x-org2-delivery-id", HeaderValue::from_static("delivery-1"));
        headers
    };
    let first = routine_webhook::handle_http(
        Path(fixture.metadata.name.clone()),
        request_headers(),
        Bytes::from_static(br#"{"action":"opened"}"#),
    )
    .await;
    assert_eq!(first.status(), StatusCode::ACCEPTED);
    let first: RoutineWebhookDelivery = serde_json::from_slice(
        &to_bytes(first.into_body(), 1024 * 1024)
            .await
            .expect("response body"),
    )
    .expect("delivery response");
    assert_eq!(
        first.status, "ignored",
        "filter mismatch must not invoke the Routine"
    );

    let replayed = routine_webhook::handle_http(
        Path(fixture.metadata.name),
        request_headers(),
        Bytes::from_static(br#"{"action":"opened"}"#),
    )
    .await;
    let replayed: RoutineWebhookDelivery = serde_json::from_slice(
        &to_bytes(replayed.into_body(), 1024 * 1024)
            .await
            .expect("response body"),
    )
    .expect("delivery response");
    assert_eq!(
        replayed.id, first.id,
        "delivery idempotency returns the original row"
    );
    assert_eq!(
        routine_webhook::list_deliveries(&replayed.routine_name, 20)
            .expect("list deliveries")
            .len(),
        1
    );
}
