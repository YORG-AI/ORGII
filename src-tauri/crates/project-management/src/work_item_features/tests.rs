use axum::body::{to_bytes, Bytes};
use axum::extract::Path;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::json;
use test_helpers::test_env;

use super::*;
use crate::projects::io::helpers::conn;
use crate::projects::types::{
    AgentRole, LinkedSession, LinkedSessionStatus, LinkedSessionType, MentionTarget,
    OrchestratorConfig, WorkItemCloseOut, WorkItemCloseOutStatus, WorkItemMutationActor,
    WorkItemWorkProduct, WorkItemWorkProductStatus, WorkItemWorkProductType,
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

fn agent_actor(agent_definition_id: &str) -> WorkItemMutationActor {
    WorkItemMutationActor {
        id: format!("agent:{agent_definition_id}"),
        name: agent_definition_id.to_string(),
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudienceContractCase {
    name: String,
    surface: String,
    targets: Vec<MentionTarget>,
    expected: AudienceContractExpectation,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudienceContractExpectation {
    agent_mode: String,
}

#[test]
fn work_item_execution_matches_the_shared_audience_contract() {
    let contract: Vec<AudienceContractCase> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../src/features/TeamCollaboration/messageAudienceRouting.contract.json"
    )))
    .expect("parse shared audience contract");

    for case in contract
        .into_iter()
        .filter(|case| case.surface == "work_item_comment")
    {
        let actual_mode = match discussion::mention_audience(&case.targets) {
            discussion::MentionAudience::Assigned => "assigned",
            discussion::MentionAudience::NoAgent { .. } => "none",
            discussion::MentionAudience::Agent { .. }
            | discussion::MentionAudience::AgentOrg { .. } => "explicit",
        };
        assert_eq!(actual_mode, case.expected.agent_mode, "{}", case.name);
    }
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
        None,
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
fn discussion_starts_fresh_after_the_target_session_exhausts_context() {
    let _sandbox = test_env::sandbox();
    seed_with_config(true, "builtin:sde");

    let failed =
        crate::work_run_service::enqueue(crate::projects::types::EnqueueWorkItemRunRequest {
            project_slug: Some("demo".to_string()),
            org_id: "personal-org".to_string(),
            work_item_id: "AAA-0001".to_string(),
            trigger: crate::projects::types::WorkItemRunTrigger::Manual,
            target_snapshot: crate::projects::types::WorkItemRunTargetSnapshot::new(
                crate::projects::types::WorkItemRunTarget::ResumeSession {
                    session_id: "session-1".to_string(),
                },
            ),
            input: json!({ "content": "oversized turn" }),
            idempotency_key: "context-overflow-fixture".to_string(),
            max_attempts: 1,
            parent_run_id: None,
        })
        .expect("enqueue context overflow fixture");
    let lease = crate::work_run_service::claim_next_dispatch("test-worker", 30_000)
        .expect("claim context overflow fixture")
        .expect("dispatch fixture");
    crate::work_run_service::acknowledge_dispatch_started(
        &lease.dispatch_id,
        &lease.lease_token,
        "session-1",
    )
    .expect("acknowledge context overflow fixture");
    crate::work_run_service::record_run_terminal(
        &failed.id,
        Some("session-1"),
        crate::work_run_service::WorkItemRunTerminalOutcome::Failed,
        crate::projects::types::WorkItemRunUsage::default(),
        Some(r#"{\"terminal_reason\":\"prompt_too_long\"}"#),
    )
    .expect("record context overflow");

    let mentioned = post_with_mentions(
        "comment-after-context-overflow",
        "Please continue with a clean context.",
        None,
        vec![MentionTarget::Agent {
            id: "builtin:sde".to_string(),
        }],
    );
    assert_eq!(
        mentioned.wake_reason,
        "mention_fresh_after_context_overflow"
    );
    assert!(mentioned.comment.agent_session_id.is_none());
    let run = mentioned.run.expect("fresh start run");
    assert!(matches!(
        run.target_snapshot.target,
        crate::projects::types::WorkItemRunTarget::StartWorkItem { .. }
    ));
    assert_eq!(
        run.target_snapshot.agent_definition_id.as_deref(),
        Some("builtin:sde")
    );
}

#[test]
fn context_exhaustion_preserves_deferred_assignee_delay_and_cancellation() {
    let _sandbox = test_env::sandbox();
    seed_with_config(true, "builtin:sde");

    let failed =
        crate::work_run_service::enqueue(crate::projects::types::EnqueueWorkItemRunRequest {
            project_slug: Some("demo".to_string()),
            org_id: "personal-org".to_string(),
            work_item_id: "AAA-0001".to_string(),
            trigger: crate::projects::types::WorkItemRunTrigger::Manual,
            target_snapshot: crate::projects::types::WorkItemRunTargetSnapshot::new(
                crate::projects::types::WorkItemRunTarget::ResumeSession {
                    session_id: "session-1".to_string(),
                },
            ),
            input: json!({ "content": "oversized turn" }),
            idempotency_key: "context-overflow-assignee-fixture".to_string(),
            max_attempts: 1,
            parent_run_id: None,
        })
        .expect("enqueue context overflow fixture");
    let lease = crate::work_run_service::claim_next_dispatch("test-worker", 30_000)
        .expect("claim context overflow fixture")
        .expect("dispatch fixture");
    crate::work_run_service::acknowledge_dispatch_started(
        &lease.dispatch_id,
        &lease.lease_token,
        "session-1",
    )
    .expect("acknowledge context overflow fixture");
    crate::work_run_service::record_run_terminal(
        &failed.id,
        Some("session-1"),
        crate::work_run_service::WorkItemRunTerminalOutcome::Failed,
        crate::projects::types::WorkItemRunUsage::default(),
        Some(r#"{\"terminal_reason\":\"prompt_too_long\"}"#),
    )
    .expect("record context overflow");

    let posted = post(
        "comment-assignee-after-context-overflow",
        "Please pick this up with a clean context.",
        None,
    );
    assert_eq!(posted.wake_reason, "assignee_deferred");
    assert!(posted.comment.agent_session_id.is_none());
    let deferred_run = posted.run.expect("fresh deferred run");
    assert!(matches!(
        deferred_run.target_snapshot.target,
        crate::projects::types::WorkItemRunTarget::StartWorkItem { .. }
    ));

    let connection = conn().expect("connection");
    let (available_at, created_at): (i64, i64) = connection
        .query_row(
            "SELECT available_at, created_at FROM pm_dispatch_outbox WHERE run_id = ?1",
            rusqlite::params![&deferred_run.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("deferred outbox row");
    assert!(
        available_at - created_at >= 300_000,
        "fresh assignee fallback must retain the five-minute delay"
    );
    drop(connection);

    work_service::note_project_work_item_threaded(
        "demo",
        "AAA-0001",
        "comment",
        "I picked this up.",
        Some(&posted.comment.id),
        Some(&agent_actor("builtin:sde")),
        Some("session-1"),
        None,
    )
    .expect("agent reply");

    let connection = conn().expect("connection");
    let (run_status, outbox_status): (String, String) = connection
        .query_row(
            "SELECT r.status, d.status
               FROM pm_work_item_runs r
               JOIN pm_dispatch_outbox d ON d.run_id = r.id
              WHERE r.id = ?1",
            rusqlite::params![deferred_run.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("cancelled escalation");
    assert_eq!(run_status, "cancelled");
    assert_eq!(outbox_status, "cancelled");
}

#[test]
fn member_only_mention_stays_silent_instead_of_waking_the_assignee() {
    let _sandbox = test_env::sandbox();
    seed_with_config(false, "builtin:sde");

    let addressed = post_with_mentions(
        "comment-member-only",
        "<@member-2> can you take a look?",
        None,
        vec![MentionTarget::Member {
            id: "member-2".to_string(),
        }],
    );
    assert_eq!(addressed.wake_reason, "member_addressed");
    assert!(
        addressed.run.is_none(),
        "an explicit @person comment must not start the assigned agent"
    );

    let default_comment = post("comment-default", "Kick this off please.", None);
    assert_eq!(default_comment.wake_reason, "assignee_deferred");
    assert!(default_comment.run.is_some());
}

#[test]
fn discussion_routing_starts_the_assigned_agent_without_sessions() {
    let _sandbox = test_env::sandbox();
    seed_with_config(false, "builtin:sde");

    let root = post("comment-root", "Kick this off please.", None);
    assert_eq!(root.wake_reason, "assignee_deferred");
    assert!(
        root.run.is_some(),
        "assigned agent must be started through a Run"
    );
    assert!(root.comment.agent_session_id.is_none());

    let connection = conn().expect("connection");
    let (available_at, created_at, outbox_status): (i64, i64, String) = connection
        .query_row(
            "SELECT available_at, created_at, status FROM pm_dispatch_outbox WHERE run_id = ?1",
            rusqlite::params![root.run.as_ref().expect("deferred run").id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("deferred outbox row");
    assert_eq!(outbox_status, "pending");
    assert!(
        available_at - created_at >= 300_000,
        "assignee fallback must wait at least five minutes"
    );

    work_service::note_project_work_item_threaded(
        "demo",
        "AAA-0001",
        "comment",
        "Another agent is only leaving context.",
        Some(&root.comment.id),
        Some(&agent_actor("other-agent")),
        Some("other-agent-session"),
        None,
    )
    .expect("unrelated agent note");
    let (run_status, outbox_status): (String, String) = connection
        .query_row(
            "SELECT r.status, d.status
               FROM pm_work_item_runs r
               JOIN pm_dispatch_outbox d ON d.run_id = r.id
              WHERE r.id = ?1",
            rusqlite::params![root.run.as_ref().expect("deferred run").id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("pending escalation after unrelated agent note");
    assert_eq!(run_status, "queued");
    assert_eq!(outbox_status, "pending");

    work_service::note_project_work_item_threaded(
        "demo",
        "AAA-0001",
        "comment",
        "I picked this up.",
        Some(&root.comment.id),
        Some(&agent_actor("builtin:sde")),
        Some("agent-session-1"),
        None,
    )
    .expect("assigned agent reply");
    let (run_status, outbox_status): (String, String) = connection
        .query_row(
            "SELECT r.status, d.status
               FROM pm_work_item_runs r
               JOIN pm_dispatch_outbox d ON d.run_id = r.id
              WHERE r.id = ?1",
            rusqlite::params![root.run.expect("deferred run").id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("cancelled escalation");
    assert_eq!(run_status, "cancelled");
    assert_eq!(outbox_status, "cancelled");
}

#[test]
fn only_the_assigned_agent_run_terminal_cancels_the_deferred_escalation() {
    let _sandbox = test_env::sandbox();
    seed_with_config(false, "builtin:sde");

    let posted = post("comment-terminal-fence", "Please pick this up.", None);
    let deferred_run = posted.run.expect("deferred assignee run");
    let mut unrelated_target = crate::projects::types::WorkItemRunTargetSnapshot::new(
        crate::projects::types::WorkItemRunTarget::StartWorkItem {
            account_id: None,
            model_id: None,
        },
    );
    unrelated_target.agent_definition_id = Some("other-agent".to_string());
    let unrelated =
        crate::work_run_service::enqueue(crate::projects::types::EnqueueWorkItemRunRequest {
            project_slug: Some("demo".to_string()),
            org_id: "personal-org".to_string(),
            work_item_id: "AAA-0001".to_string(),
            trigger: crate::projects::types::WorkItemRunTrigger::Manual,
            target_snapshot: unrelated_target,
            input: json!({ "content": "unrelated action" }),
            idempotency_key: "unrelated-terminal-fence".to_string(),
            max_attempts: 1,
            parent_run_id: None,
        })
        .expect("enqueue unrelated run");
    let lease = crate::work_run_service::claim_next_dispatch("test-worker", 30_000)
        .expect("claim unrelated run")
        .expect("dispatch unrelated run");
    assert_eq!(lease.run.id, unrelated.id);
    crate::work_run_service::acknowledge_dispatch_started(
        &lease.dispatch_id,
        &lease.lease_token,
        "other-agent-session",
    )
    .expect("start unrelated run");
    crate::work_run_service::record_run_terminal(
        &unrelated.id,
        Some("other-agent-session"),
        crate::work_run_service::WorkItemRunTerminalOutcome::Succeeded,
        crate::projects::types::WorkItemRunUsage::default(),
        None,
    )
    .expect("finish unrelated run");

    let connection = conn().expect("connection");
    let (run_status, outbox_status): (String, String) = connection
        .query_row(
            "SELECT r.status, d.status
               FROM pm_work_item_runs r
               JOIN pm_dispatch_outbox d ON d.run_id = r.id
              WHERE r.id = ?1",
            rusqlite::params![deferred_run.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("pending escalation after unrelated terminal run");
    assert_eq!(run_status, "queued");
    assert_eq!(outbox_status, "pending");

    let mut assigned_target = crate::projects::types::WorkItemRunTargetSnapshot::new(
        crate::projects::types::WorkItemRunTarget::StartWorkItem {
            account_id: None,
            model_id: None,
        },
    );
    assigned_target.agent_definition_id = Some("builtin:sde".to_string());
    let assigned =
        crate::work_run_service::enqueue(crate::projects::types::EnqueueWorkItemRunRequest {
            project_slug: Some("demo".to_string()),
            org_id: "personal-org".to_string(),
            work_item_id: "AAA-0001".to_string(),
            trigger: crate::projects::types::WorkItemRunTrigger::Manual,
            target_snapshot: assigned_target,
            input: json!({ "content": "assigned agent work" }),
            idempotency_key: "assigned-terminal-fence".to_string(),
            max_attempts: 1,
            parent_run_id: None,
        })
        .expect("enqueue assigned agent run");
    let lease = crate::work_run_service::claim_next_dispatch("test-worker", 30_000)
        .expect("claim assigned agent run")
        .expect("dispatch assigned agent run");
    assert_eq!(lease.run.id, assigned.id);
    crate::work_run_service::acknowledge_dispatch_started(
        &lease.dispatch_id,
        &lease.lease_token,
        "assigned-agent-session",
    )
    .expect("start assigned agent run");
    crate::work_run_service::record_run_terminal(
        &assigned.id,
        Some("assigned-agent-session"),
        crate::work_run_service::WorkItemRunTerminalOutcome::Succeeded,
        crate::projects::types::WorkItemRunUsage::default(),
        None,
    )
    .expect("finish assigned agent run");

    let (run_status, outbox_status): (String, String) = connection
        .query_row(
            "SELECT r.status, d.status
               FROM pm_work_item_runs r
               JOIN pm_dispatch_outbox d ON d.run_id = r.id
              WHERE r.id = ?1",
            rusqlite::params![deferred_run.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("cancelled escalation after assigned agent terminal run");
    assert_eq!(run_status, "cancelled");
    assert_eq!(outbox_status, "cancelled");
}

#[test]
fn standalone_agent_reply_cancels_the_deferred_assignee_escalation() {
    let _sandbox = test_env::sandbox();
    work_service::create_standalone_work_item(
        None,
        "ORG-0001",
        &CreateWorkItemRequest {
            title: "Standalone routing fixture".to_string(),
            body: "Route this discussion.".to_string(),
            orchestrator_config: Some(OrchestratorConfig {
                agent_definition_id: Some("builtin:sde".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        },
        None,
    )
    .expect("seed standalone Work Item");
    let scope = WorkItemScope {
        project_slug: None,
        org_id: "personal-org".to_string(),
        work_item_id: "ORG-0001".to_string(),
    };
    let posted = discussion::post(DiscussionPostRequest {
        scope,
        comment_id: "standalone-comment".to_string(),
        author_id: "member-1".to_string(),
        author_name: "Member One".to_string(),
        content: "Please pick this up.".to_string(),
        mentioned_user_ids: Vec::new(),
        mentions: Vec::new(),
        parent_id: None,
        target_session_id: None,
    })
    .expect("post standalone comment");
    assert_eq!(posted.wake_reason, "assignee_deferred");
    let deferred_run = posted.run.expect("deferred standalone run");

    work_service::note_standalone_work_item_threaded(
        None,
        "ORG-0001",
        "comment",
        "I picked this up.",
        Some(&posted.comment.id),
        Some(&agent_actor("builtin:sde")),
        Some("agent-session-standalone"),
        None,
    )
    .expect("standalone agent reply");

    let connection = conn().expect("connection");
    let (run_status, outbox_status): (String, String) = connection
        .query_row(
            "SELECT r.status, d.status
               FROM pm_work_item_runs r
               JOIN pm_dispatch_outbox d ON d.run_id = r.id
              WHERE r.id = ?1",
            rusqlite::params![deferred_run.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("cancelled standalone escalation");
    assert_eq!(run_status, "cancelled");
    assert_eq!(outbox_status, "cancelled");
}

#[test]
fn all_and_mixed_audiences_do_not_fall_through_to_the_assigned_agent() {
    let _sandbox = test_env::sandbox();
    seed_with_config(false, "builtin:sde");

    let everyone = post_with_mentions(
        "comment-all",
        "Everyone should see this.",
        None,
        vec![MentionTarget::All],
    );
    assert_eq!(everyone.wake_reason, "member_addressed");
    assert!(everyone.run.is_none());

    let mixed = post_with_mentions(
        "comment-mixed",
        "<@member-2> and the assigned Agent should both see this.",
        None,
        vec![
            MentionTarget::Member {
                id: "member-2".to_string(),
            },
            MentionTarget::Agent {
                id: "builtin:sde".to_string(),
            },
        ],
    );
    assert_eq!(mixed.wake_reason, "mention_start");
    assert!(mixed.run.is_some());
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
    assert_eq!(preview.reason, "assignee_deferred");
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
fn inbox_event_coalescing_is_scoped_to_the_authoritative_work_item() {
    let _sandbox = test_env::sandbox();
    seed(false);
    let mut connection = conn().expect("connection");
    let tx = connection.transaction().expect("begin transaction");

    tx.execute(
        "INSERT INTO pm_work_item_inbox_events (
            id, scope_key, work_item_id, recipient_id, kind, actor_id,
            payload_json, coalesce_key, occurred_at, archived_at
         ) VALUES (
            'stale-event', 'org:wrong', 'WRONG-1', 'mentioned-1', 'mention', NULL,
            '{}', 'mention:org:alpha:ALPHA-1:comment-shared', 1, NULL
         )",
        [],
    )
    .expect("seed stale conflicting event");

    let mentioned = vec!["mentioned-1".to_string()];
    for (scope_key, work_item_id, now) in [("org:alpha", "ALPHA-1", 10), ("org:beta", "BETA-1", 20)]
    {
        subscriptions::notify_comment(
            &tx,
            subscriptions::CommentNotification {
                scope_key,
                work_item_id,
                title: "Scoped mention",
                comment_id: "comment-shared",
                author_id: "author-1",
                content: "Please review",
                mentioned_user_ids: &mentioned,
                now,
            },
        )
        .expect("write scoped mention event");
    }

    for (scope_key, parent_short_id, now) in [
        ("org:alpha", "ALPHA-PARENT", 30),
        ("org:beta", "BETA-PARENT", 40),
    ] {
        subscriptions::ensure_subscription(
            &tx,
            scope_key,
            parent_short_id,
            "watcher-1",
            SubscriptionReason::Manual,
            now,
        )
        .expect("subscribe parent watcher");
        subscriptions::notify_child_terminal(
            &tx,
            subscriptions::ChildTerminalNotification {
                scope_key,
                parent_short_id,
                child_short_id: "CHILD-1",
                child_title: "Shared child id",
                status: "completed",
                actor_id: None,
                now,
            },
        )
        .expect("write scoped child event");
    }
    tx.commit().expect("commit scoped events");

    let mentions = connection
        .prepare(
            "SELECT scope_key, work_item_id, coalesce_key
               FROM pm_work_item_inbox_events
              WHERE recipient_id = 'mentioned-1' AND kind = 'mention'
              ORDER BY scope_key",
        )
        .expect("prepare mention rows")
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .expect("query mention rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect mention rows");
    assert_eq!(
        mentions,
        vec![
            (
                "org:alpha".to_string(),
                "ALPHA-1".to_string(),
                "mention:org:alpha:ALPHA-1:comment-shared".to_string(),
            ),
            (
                "org:beta".to_string(),
                "BETA-1".to_string(),
                "mention:org:beta:BETA-1:comment-shared".to_string(),
            ),
        ]
    );

    let child_keys = connection
        .prepare(
            "SELECT coalesce_key
               FROM pm_work_item_inbox_events
              WHERE recipient_id = 'watcher-1' AND kind = 'child_completed'
              ORDER BY scope_key",
        )
        .expect("prepare child rows")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query child rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect child rows");
    assert_eq!(
        child_keys,
        [
            "child:org:alpha:ALPHA-PARENT:CHILD-1",
            "child:org:beta:BETA-PARENT:CHILD-1",
        ]
    );
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
fn batch_property_update_rolls_back_every_item_when_one_target_is_invalid() {
    let _sandbox = test_env::sandbox();
    seed(false);
    let definition = properties::upsert_definition(UpsertPropertyDefinitionRequest {
        id: Some("prop_batch_effort".to_string()),
        org_id: "personal-org".to_string(),
        name: "Batch effort".to_string(),
        property_type: PropertyType::Number,
        description: None,
        config: PropertyConfig::default(),
        position: 0,
    })
    .expect("create property");

    let failed = properties::batch_set_values(
        "personal-org".to_string(),
        Some("demo".to_string()),
        vec!["AAA-0001".to_string(), "AAA-missing".to_string()],
        definition.id,
        Some(json!(3)),
    );
    assert!(failed.is_err(), "an invalid target must reject the batch");
    assert!(
        properties::list_values(&scope())
            .expect("list values after rollback")
            .is_empty(),
        "the earlier target must not retain a partial write"
    );
}

#[test]
fn actor_properties_require_canonical_member_references() {
    let _sandbox = test_env::sandbox();
    seed(false);
    work_service::tests_support::seed_project("other-project", "project-2");
    let connection = conn().expect("connection");
    connection
        .execute(
            "INSERT INTO members (id, project_id, display_name, kind, created_at)
             VALUES ('member-1', 'project-1', 'Member One', 'member', 1),
                    ('member-foreign', 'project-2', 'Foreign Member', 'member', 1)",
            [],
        )
        .expect("seed scoped members");
    let actor = properties::upsert_definition(UpsertPropertyDefinitionRequest {
        id: Some("prop_reviewer".to_string()),
        org_id: "personal-org".to_string(),
        name: "Reviewer".to_string(),
        property_type: PropertyType::Actor,
        description: None,
        config: PropertyConfig::default(),
        position: 0,
    })
    .expect("create actor property");

    let invalid = properties::set_value(SetWorkItemPropertyValueRequest {
        scope: scope(),
        property_id: actor.id.clone(),
        value: Some(json!("member-1")),
    });
    assert!(
        invalid.is_err_and(|error| error.contains("member:<id>")),
        "bare ids must not enter the actor value domain"
    );
    let foreign = properties::set_value(SetWorkItemPropertyValueRequest {
        scope: scope(),
        property_id: actor.id.clone(),
        value: Some(json!("member:member-foreign")),
    })
    .expect_err("members from another project scope must be rejected");
    assert_eq!(
        foreign, "PM_ERR:PROPERTY_MEMBER_INVALID:member-foreign",
        "the producing boundary returns a stable member ownership error"
    );
    properties::set_value(SetWorkItemPropertyValueRequest {
        scope: scope(),
        property_id: actor.id.clone(),
        value: Some(json!("member:member-1")),
    })
    .expect("set canonical member reference");
    assert_eq!(
        properties::list_values(&scope()).expect("list actor value")[0].value,
        json!("member:member-1")
    );

    let multi_actor = properties::upsert_definition(UpsertPropertyDefinitionRequest {
        id: Some("prop_reviewers".to_string()),
        org_id: "personal-org".to_string(),
        name: "Reviewers".to_string(),
        property_type: PropertyType::MultiActor,
        description: None,
        config: PropertyConfig::default(),
        position: 1,
    })
    .expect("create multi-actor property");
    let invalid_multi = properties::set_value(SetWorkItemPropertyValueRequest {
        scope: scope(),
        property_id: multi_actor.id,
        value: Some(json!(["member:member-1", "member:member-foreign"])),
    })
    .expect_err("every multi-actor member must belong to the Work Item scope");
    assert_eq!(
        invalid_multi,
        "PM_ERR:PROPERTY_MEMBER_INVALID:member-foreign"
    );

    let work_item_row_id: String = connection
        .query_row(
            "SELECT id FROM workitems WHERE short_id = 'AAA-0001'",
            [],
            |row| row.get(0),
        )
        .expect("Work Item row id");
    let remote_error = properties::apply_work_item_wire_snapshot(
        &connection,
        "personal-org",
        &work_item_row_id,
        &json!({
            "propertyValues": [{
                "propertyId": actor.id,
                "value": "member:member-foreign",
                "updatedAt": "2099-01-01T00:00:00Z"
            }]
        }),
    )
    .expect_err("remote values use the same member ownership invariant");
    assert_eq!(
        remote_error,
        "PM_ERR:PROPERTY_MEMBER_INVALID:member-foreign"
    );
    assert_eq!(
        properties::list_values(&scope()).expect("value after rejected remote write")[0].value,
        json!("member:member-1"),
        "a rejected remote value must leave the local value intact"
    );
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

#[test]
fn reply_in_agent_free_thread_stays_silent() {
    let _sandbox = test_env::sandbox();
    seed(true);

    let root = post("comment-note-root", "/note capturing context only", None);
    assert_eq!(root.wake_reason, "note_only");
    assert!(root.run.is_none());

    let reply = post(
        "comment-note-reply",
        "Agreed, thanks!",
        Some("comment-note-root"),
    );
    assert_eq!(
        reply.wake_reason, "member_thread",
        "a reply in a thread without agent participation must not wake anyone"
    );
    assert!(reply.run.is_none());

    let connection = conn().expect("connection");
    let run_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_work_item_runs WHERE work_item_id = 'AAA-0001'",
            [],
            |row| row.get(0),
        )
        .expect("run count");
    assert_eq!(run_count, 0, "member threads never enqueue runs");
}

#[test]
fn edit_comment_updates_content_without_retrigger() {
    let _sandbox = test_env::sandbox();
    seed(true);

    let posted = post("comment-editable", "Original wording.", None);
    assert!(posted.run.is_some());

    let comments = discussion::edit(DiscussionEditRequest {
        scope: scope(),
        comment_id: "comment-editable".to_string(),
        actor_id: "member-1".to_string(),
        content: "Corrected wording.".to_string(),
        expected_revision: None,
    })
    .expect("edit comment");
    let edited = comments
        .iter()
        .find(|comment| comment.id == "comment-editable")
        .expect("edited comment present");
    assert_eq!(edited.content, "Corrected wording.");
    assert!(edited.edited_at.is_some());

    let stranger = discussion::edit(DiscussionEditRequest {
        scope: scope(),
        comment_id: "comment-editable".to_string(),
        actor_id: "member-2".to_string(),
        content: "Hijacked.".to_string(),
        expected_revision: None,
    });
    assert!(stranger.is_err(), "only the author can edit");

    let connection = conn().expect("connection");
    let run_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_work_item_runs WHERE work_item_id = 'AAA-0001'",
            [],
            |row| row.get(0),
        )
        .expect("run count");
    assert_eq!(run_count, 1, "editing must not enqueue another run");
}

#[test]
fn comment_revision_conflicts_are_scoped_to_the_target_comment() {
    let _sandbox = test_env::sandbox();
    seed(false);

    let first = post("comment-first", "/note first draft", None).comment;
    let second = post("comment-second", "/note second draft", None).comment;
    assert_eq!(first.revision, 0);
    assert_eq!(second.revision, 0);

    let after_first_edit = discussion::edit(DiscussionEditRequest {
        scope: scope(),
        comment_id: first.id.clone(),
        actor_id: "member-1".to_string(),
        content: "first corrected".to_string(),
        expected_revision: Some(first.revision),
    })
    .expect("first comment edit");
    assert_eq!(
        after_first_edit
            .iter()
            .find(|comment| comment.id == first.id)
            .expect("first comment")
            .revision,
        1
    );

    let second_edit = discussion::edit(DiscussionEditRequest {
        scope: scope(),
        comment_id: second.id.clone(),
        actor_id: "member-1".to_string(),
        content: "second corrected".to_string(),
        expected_revision: Some(second.revision),
    })
    .expect("a write to another comment must not conflict");
    assert_eq!(
        second_edit
            .iter()
            .find(|comment| comment.id == second.id)
            .expect("second comment")
            .revision,
        1
    );

    let stale = discussion::edit(DiscussionEditRequest {
        scope: scope(),
        comment_id: first.id,
        actor_id: "member-1".to_string(),
        content: "stale overwrite".to_string(),
        expected_revision: Some(0),
    })
    .expect_err("stale edit must conflict");
    assert_eq!(stale, "PM_ERR:REVISION_CONFLICT:expected=0:actual=1");
}

#[test]
fn legacy_comments_and_mutation_requests_default_revision_tokens() {
    let comment: crate::projects::types::CommentEntry = serde_json::from_value(json!({
        "id": "legacy-comment",
        "author": "member-1",
        "content": "legacy body",
        "created_at": "2026-08-01T00:00:00Z"
    }))
    .expect("legacy CommentEntry");
    assert_eq!(comment.revision, 0);

    let edit: DiscussionEditRequest = serde_json::from_value(json!({
        "projectSlug": "demo",
        "orgId": "personal-org",
        "workItemId": "AAA-0001",
        "commentId": "legacy-comment",
        "actorId": "member-1",
        "content": "next body"
    }))
    .expect("legacy edit request");
    assert_eq!(edit.expected_revision, None);
}

#[test]
fn delete_comment_tombstones_and_strips_mentions() {
    let _sandbox = test_env::sandbox();
    seed(false);

    discussion::post(DiscussionPostRequest {
        scope: scope(),
        comment_id: "comment-doomed".to_string(),
        author_id: "member-1".to_string(),
        author_name: "Member One".to_string(),
        content: "/note ping <@member-2>".to_string(),
        mentioned_user_ids: vec!["member-2".to_string()],
        mentions: vec![MentionTarget::Member {
            id: "member-2".to_string(),
        }],
        parent_id: None,
        target_session_id: None,
    })
    .expect("post comment");

    let stranger = discussion::delete(DiscussionDeleteRequest {
        scope: scope(),
        comment_id: "comment-doomed".to_string(),
        actor_id: "member-2".to_string(),
        expected_revision: None,
    });
    assert!(stranger.is_err(), "only the author can delete");

    let comments = discussion::delete(DiscussionDeleteRequest {
        scope: scope(),
        comment_id: "comment-doomed".to_string(),
        actor_id: "member-1".to_string(),
        expected_revision: Some(0),
    })
    .expect("delete comment");
    let deleted = comments
        .iter()
        .find(|comment| comment.id == "comment-doomed")
        .expect("tombstone present")
        .clone();
    assert!(deleted.deleted_at.is_some());
    assert!(deleted.content.is_empty());
    assert!(deleted.mentioned_user_ids.is_empty());
    assert!(deleted.mentions.is_empty());
    assert_eq!(deleted.revision, 1);

    let repeat = discussion::delete(DiscussionDeleteRequest {
        scope: scope(),
        comment_id: "comment-doomed".to_string(),
        actor_id: "member-1".to_string(),
        expected_revision: None,
    })
    .expect("repeat delete is idempotent");
    let again = repeat
        .iter()
        .find(|comment| comment.id == "comment-doomed")
        .expect("tombstone still present");
    assert_eq!(again.deleted_at, deleted.deleted_at);
}

#[test]
fn status_definition_crud_enforces_key_and_category_rules() {
    let _sandbox = test_env::sandbox();

    let created = statuses::upsert_definition(statuses::UpsertStatusDefinitionRequest {
        id: None,
        org_id: "personal-org".to_string(),
        key: Some("shipping".to_string()),
        name: "Shipping".to_string(),
        category: Some("completed".to_string()),
        color: Some("#22c55e".to_string()),
        description: None,
        position: None,
    })
    .expect("create custom status");
    assert_eq!(created.category, "completed");

    let reserved = statuses::upsert_definition(statuses::UpsertStatusDefinitionRequest {
        id: None,
        org_id: "personal-org".to_string(),
        key: Some("in_progress".to_string()),
        name: "Doing".to_string(),
        category: Some("planned".to_string()),
        color: None,
        description: None,
        position: None,
    });
    assert!(
        reserved.is_err_and(|err| err.contains("STATUS_KEY_RESERVED")),
        "built-in keys must stay reserved"
    );

    let recategorized = statuses::upsert_definition(statuses::UpsertStatusDefinitionRequest {
        id: Some(created.id.clone()),
        org_id: "personal-org".to_string(),
        key: None,
        name: "Shipping".to_string(),
        category: Some("backlog".to_string()),
        color: None,
        description: None,
        position: None,
    });
    assert!(
        recategorized.is_err_and(|err| err.contains("STATUS_CATEGORY_IMMUTABLE")),
        "category is immutable after creation"
    );

    let archived = statuses::set_definition_archived("personal-org", &created.id, true)
        .expect("archive status");
    assert!(archived.archived_at.is_some());
    assert!(
        statuses::list_definitions("personal-org", false)
            .expect("list active")
            .is_empty(),
        "archived statuses leave the active list"
    );
}

#[test]
fn custom_status_folds_into_its_category_for_views() {
    let _sandbox = test_env::sandbox();
    seed(false);

    statuses::upsert_definition(statuses::UpsertStatusDefinitionRequest {
        id: None,
        org_id: "personal-org".to_string(),
        key: Some("shipping".to_string()),
        name: "Shipping".to_string(),
        category: Some("completed".to_string()),
        color: None,
        description: None,
        position: None,
    })
    .expect("create custom status");

    assert_eq!(
        statuses::find_active_status_definition(Some("personal-org"), "shipping")
            .expect("lookup")
            .map(|definition| definition.category),
        Some("completed".to_string()),
        "the CLI accepts the key because the org defines it"
    );
    assert!(statuses::render_status_catalog(Some("personal-org"))
        .expect("catalog")
        .contains("- completed: `shipping` (Shipping)"));
    assert_eq!(statuses::render_status_catalog(Some("other-org")), None);

    work_service::transition_project_work_item("demo", "AAA-0001", "shipping", None, None, None)
        .expect("transition to custom status");

    let view = crate::projects::io::read_work_items_view_data("demo", Some("completed"), None)
        .expect("read view data");
    assert_eq!(
        view.counts.completed, 1,
        "custom status counts as its category"
    );
    assert_eq!(
        view.items.len(),
        1,
        "category filter matches the custom status"
    );

    let connection = conn().expect("connection");
    let effective = crate::work_item_features::statuses::effective_status_in(
        &connection,
        "personal-org",
        "shipping",
    );
    assert_eq!(effective, "completed");
}

#[test]
fn saved_views_upsert_list_and_archive() {
    let _sandbox = test_env::sandbox();
    seed(false);

    let view = saved_views::upsert_view(saved_views::UpsertSavedViewRequest {
        id: None,
        org_id: "personal-org".to_string(),
        project_slug: Some("demo".to_string()),
        name: "My review queue".to_string(),
        query: json!({ "statusFilter": "in_review", "searchQuery": "" }),
        display: json!({ "viewTab": "Kanban" }),
        position: None,
        created_by: Some("member-1".to_string()),
    })
    .expect("create saved view");
    assert_eq!(view.query["statusFilter"], "in_review");

    let renamed = saved_views::upsert_view(saved_views::UpsertSavedViewRequest {
        id: Some(view.id.clone()),
        org_id: "personal-org".to_string(),
        project_slug: Some("demo".to_string()),
        name: "Review queue".to_string(),
        query: view.query.clone(),
        display: view.display.clone(),
        position: Some(2),
        created_by: None,
    })
    .expect("rename saved view");
    assert_eq!(renamed.name, "Review queue");
    assert_eq!(renamed.position, 2);

    let listed = saved_views::list_views("personal-org", Some("demo")).expect("list");
    assert_eq!(listed.len(), 1);

    let other_project = saved_views::list_views("personal-org", Some("elsewhere")).expect("list");
    assert!(
        other_project.is_empty(),
        "project-scoped views stay out of other projects"
    );

    saved_views::archive_view("personal-org", &view.id).expect("archive");
    assert!(
        saved_views::list_views("personal-org", Some("demo"))
            .expect("list")
            .is_empty(),
        "archived views leave the list"
    );
}

#[test]
fn saved_views_wire_round_trip_applies_newer_snapshots() {
    let _sandbox = test_env::sandbox();

    let view = saved_views::upsert_view(saved_views::UpsertSavedViewRequest {
        id: None,
        org_id: "personal-org".to_string(),
        project_slug: None,
        name: "Org wide".to_string(),
        query: json!({ "statusFilter": "all" }),
        display: json!({}),
        position: None,
        created_by: None,
    })
    .expect("create saved view");

    let connection = conn().expect("connection");
    let exported = saved_views::export_views(&connection, "personal-org").expect("export");
    assert_eq!(exported.len(), 1);

    let mut remote = exported[0].clone();
    remote.name = "Org wide (remote rename)".to_string();
    remote.updated_at += 1_000;
    let payload = json!({ "savedViews": [remote] });
    saved_views::apply_wire_views(&connection, "personal-org", &payload).expect("apply");

    let listed = saved_views::list_views("personal-org", Some("demo")).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Org wide (remote rename)");
    assert!(listed[0].id == view.id);
}

#[test]
fn catalog_domain_validation_is_identical_for_local_and_wire_writes() {
    let _sandbox = test_env::sandbox();
    let connection = conn().expect("connection");

    let property_error = properties::upsert_definition(UpsertPropertyDefinitionRequest {
        id: Some("prop_invalid".to_string()),
        org_id: "personal-org".to_string(),
        name: "Invalid select".to_string(),
        property_type: PropertyType::Select,
        description: None,
        config: PropertyConfig::default(),
        position: 0,
    })
    .expect_err("local invalid property");
    let wire_property = PropertyDefinition {
        id: "prop_invalid".to_string(),
        org_id: "personal-org".to_string(),
        name: "Invalid select".to_string(),
        property_type: PropertyType::Select,
        description: None,
        config: PropertyConfig::default(),
        position: 0,
        archived_at: None,
        created_at: "2026-08-01T00:00:00Z".to_string(),
        updated_at: "2026-08-01T00:00:00Z".to_string(),
    };
    let mut valid_wire_property = wire_property.clone();
    valid_wire_property.id = "prop_valid_before_invalid".to_string();
    valid_wire_property.name = "Valid property".to_string();
    valid_wire_property.property_type = PropertyType::Text;
    let wire_property_error = properties::apply_wire_definitions(
        &connection,
        "personal-org",
        &json!({ "propertyDefinitions": [valid_wire_property, wire_property] }),
    )
    .expect_err("wire invalid property");
    assert_eq!(wire_property_error, property_error);

    let status_error = statuses::upsert_definition(statuses::UpsertStatusDefinitionRequest {
        id: None,
        org_id: "personal-org".to_string(),
        key: Some("open".to_string()),
        name: "Invalid status".to_string(),
        category: Some("planned".to_string()),
        color: None,
        description: None,
        position: None,
    })
    .expect_err("local invalid status");
    let wire_status = statuses::StatusDefinition {
        id: "wis_invalid".to_string(),
        org_id: "personal-org".to_string(),
        key: "open".to_string(),
        name: "Invalid status".to_string(),
        category: "planned".to_string(),
        color: None,
        description: None,
        position: 0,
        archived_at: None,
        created_at: 1,
        updated_at: 1,
    };
    let wire_status_error = statuses::apply_wire_definitions(
        &connection,
        "personal-org",
        &json!({ "statusDefinitions": [wire_status] }),
    )
    .expect_err("wire invalid status");
    assert_eq!(wire_status_error, status_error);

    let view_error = saved_views::upsert_view(saved_views::UpsertSavedViewRequest {
        id: Some("wiv_invalid".to_string()),
        org_id: "personal-org".to_string(),
        project_slug: None,
        name: "   ".to_string(),
        query: json!({}),
        display: json!({}),
        position: None,
        created_by: None,
    })
    .expect_err("local invalid view");
    let wire_view = saved_views::SavedView {
        id: "wiv_invalid".to_string(),
        org_id: "personal-org".to_string(),
        project_slug: None,
        name: "   ".to_string(),
        query: json!({}),
        display: json!({}),
        position: 0,
        created_by: None,
        archived_at: None,
        created_at: 1,
        updated_at: 1,
    };
    let wire_view_error = saved_views::apply_wire_views(
        &connection,
        "personal-org",
        &json!({ "savedViews": [wire_view] }),
    )
    .expect_err("wire invalid view");
    assert_eq!(wire_view_error, view_error);

    assert!(
        properties::list_definitions("personal-org", true)
            .expect("properties")
            .is_empty(),
        "the whole wire catalog is validated before its first write"
    );
    assert!(statuses::list_definitions("personal-org", true)
        .expect("statuses")
        .is_empty());
    assert!(saved_views::list_views("personal-org", None)
        .expect("views")
        .is_empty());
}

#[test]
fn quick_action_invoke_posts_mention_comment_and_bumps_use_count() {
    let _sandbox = test_env::sandbox();
    seed(true);
    let prompt = "  Investigate the failing CI run for this item\nand fix it verbatim.  ";

    let action = quick_actions::upsert_action(quick_actions::UpsertQuickActionRequest {
        id: None,
        org_id: "personal-org".to_string(),
        name: "Fix CI".to_string(),
        description: "Ask the build agent to repair CI".to_string(),
        target_kind: "agent".to_string(),
        target_id: "builtin:sde".to_string(),
        prompt: prompt.to_string(),
        created_by: Some("member-1".to_string()),
    })
    .expect("create quick action");

    let result = quick_actions::invoke_action(quick_actions::InvokeQuickActionRequest {
        scope: scope(),
        action_id: action.id.clone(),
        actor_id: "member-1".to_string(),
        actor_name: "Member One".to_string(),
    })
    .expect("invoke quick action");
    assert_eq!(
        result.comment.mentions,
        vec![MentionTarget::Agent {
            id: "builtin:sde".to_string()
        }]
    );
    assert_eq!(result.wake_reason, "quick_action");
    assert_eq!(
        result.comment.content, prompt,
        "saved prompts are sent byte-for-byte without interpolation or trimming"
    );
    let run = result
        .run
        .as_ref()
        .expect("a Quick Action must enqueue its saved target");
    assert_eq!(
        run.target_snapshot.agent_definition_id.as_deref(),
        Some("builtin:sde")
    );
    assert_eq!(run.target_snapshot.agent_org_id, None);

    let listed = quick_actions::list_actions("personal-org").expect("list");
    assert_eq!(listed[0].use_count, 1);

    let failed = quick_actions::invoke_action(quick_actions::InvokeQuickActionRequest {
        scope: WorkItemScope {
            work_item_id: "AAA-missing".to_string(),
            ..scope()
        },
        action_id: action.id.clone(),
        actor_id: "member-1".to_string(),
        actor_name: "Member One".to_string(),
    });
    assert!(
        failed.is_err(),
        "a missing Work Item must reject invocation"
    );
    assert_eq!(
        quick_actions::list_actions("personal-org").expect("list")[0].use_count,
        1,
        "failed invocation must roll back its use count"
    );

    quick_actions::archive_action("personal-org", &action.id).expect("archive");
    assert!(quick_actions::list_actions("personal-org")
        .expect("list")
        .is_empty());
    let archived_invoke = quick_actions::invoke_action(quick_actions::InvokeQuickActionRequest {
        scope: scope(),
        action_id: action.id,
        actor_id: "member-1".to_string(),
        actor_name: "Member One".to_string(),
    });
    assert!(archived_invoke.is_err(), "archived actions cannot fire");
}

#[test]
fn catalog_archive_and_collaboration_touch_commit_atomically() {
    let _sandbox = test_env::sandbox();
    seed(false);

    let status = statuses::upsert_definition(statuses::UpsertStatusDefinitionRequest {
        id: None,
        org_id: "personal-org".to_string(),
        key: Some("shipping".to_string()),
        name: "Shipping".to_string(),
        category: Some("completed".to_string()),
        color: None,
        description: None,
        position: None,
    })
    .expect("create status");
    let view = saved_views::upsert_view(saved_views::UpsertSavedViewRequest {
        id: None,
        org_id: "personal-org".to_string(),
        project_slug: Some("demo".to_string()),
        name: "Review queue".to_string(),
        query: json!({ "statusFilter": "in_review" }),
        display: json!({}),
        position: None,
        created_by: None,
    })
    .expect("create view");
    let action = quick_actions::upsert_action(quick_actions::UpsertQuickActionRequest {
        id: None,
        org_id: "personal-org".to_string(),
        name: "Fix CI".to_string(),
        description: String::new(),
        target_kind: "agent".to_string(),
        target_id: "builtin:sde".to_string(),
        prompt: "Fix the failing CI".to_string(),
        created_by: None,
    })
    .expect("create action");

    let connection = conn().expect("connection");
    connection
        .execute(
            "UPDATE project_orgs SET sync_provider = 'orgii_collab' WHERE id = 'personal-org'",
            [],
        )
        .expect("enable collaboration outbox");
    connection
        .execute_batch(
            "CREATE TRIGGER reject_catalog_outbox
             BEFORE INSERT ON outbox_entries
             BEGIN
               SELECT RAISE(ABORT, 'injected collaboration outbox failure');
             END;",
        )
        .expect("failure trigger");
    drop(connection);

    assert!(statuses::set_definition_archived("personal-org", &status.id, true).is_err());
    assert!(saved_views::archive_view("personal-org", &view.id).is_err());
    assert!(quick_actions::archive_action("personal-org", &action.id).is_err());

    let connection = conn().expect("read back");
    for (table, id) in [
        ("pm_status_definitions", status.id.as_str()),
        ("pm_saved_views", view.id.as_str()),
        ("pm_quick_actions", action.id.as_str()),
    ] {
        let archived_at: Option<i64> = connection
            .query_row(
                &format!("SELECT archived_at FROM {table} WHERE id = ?1"),
                [id],
                |row| row.get(0),
            )
            .expect("catalog row remains readable");
        assert_eq!(
            archived_at, None,
            "{table} mutation must roll back with its outbox touch"
        );
    }
}

#[test]
fn org_scoped_definition_ids_cannot_cross_organization_boundaries() {
    let _sandbox = test_env::sandbox();
    let connection = conn().expect("connection");
    connection
        .execute(
            "INSERT INTO project_orgs (
                 id, name, slug, org_key, source, sync_provider, created_at, updated_at
             ) VALUES ('org-two', 'Org Two', 'org-two', 'TWO', 'local', 'none', 1, 1)",
            [],
        )
        .expect("second PM org");

    let property = properties::upsert_definition(UpsertPropertyDefinitionRequest {
        id: Some("prop_global_collision".to_string()),
        org_id: "personal-org".to_string(),
        name: "Owner property".to_string(),
        property_type: PropertyType::Text,
        description: None,
        config: PropertyConfig::default(),
        position: 0,
    })
    .expect("owner property");
    let view = saved_views::upsert_view(saved_views::UpsertSavedViewRequest {
        id: Some("view_global_collision".to_string()),
        org_id: "personal-org".to_string(),
        project_slug: None,
        name: "Owner view".to_string(),
        query: json!({}),
        display: json!({}),
        position: None,
        created_by: None,
    })
    .expect("owner view");
    let action = quick_actions::upsert_action(quick_actions::UpsertQuickActionRequest {
        id: Some("action_global_collision".to_string()),
        org_id: "personal-org".to_string(),
        name: "Owner action".to_string(),
        description: String::new(),
        target_kind: "agent".to_string(),
        target_id: "builtin:sde".to_string(),
        prompt: "Keep the owner".to_string(),
        created_by: None,
    })
    .expect("owner action");
    let status = statuses::upsert_definition(statuses::UpsertStatusDefinitionRequest {
        id: None,
        org_id: "personal-org".to_string(),
        key: Some("owner_status".to_string()),
        name: "Owner status".to_string(),
        category: Some("planned".to_string()),
        color: None,
        description: None,
        position: None,
    })
    .expect("owner status");

    let property_error = properties::upsert_definition(UpsertPropertyDefinitionRequest {
        id: Some(property.id.clone()),
        org_id: "org-two".to_string(),
        name: "Hijacked property".to_string(),
        property_type: PropertyType::Text,
        description: None,
        config: PropertyConfig::default(),
        position: 0,
    })
    .expect_err("cross-org property id");
    let view_error = saved_views::upsert_view(saved_views::UpsertSavedViewRequest {
        id: Some(view.id.clone()),
        org_id: "org-two".to_string(),
        project_slug: None,
        name: "Hijacked view".to_string(),
        query: json!({}),
        display: json!({}),
        position: None,
        created_by: None,
    })
    .expect_err("cross-org view id");
    let action_error = quick_actions::upsert_action(quick_actions::UpsertQuickActionRequest {
        id: Some(action.id.clone()),
        org_id: "org-two".to_string(),
        name: "Hijacked action".to_string(),
        description: String::new(),
        target_kind: "agent".to_string(),
        target_id: "builtin:sde".to_string(),
        prompt: "Overwrite".to_string(),
        created_by: None,
    })
    .expect_err("cross-org action id");
    let status_error = statuses::upsert_definition(statuses::UpsertStatusDefinitionRequest {
        id: Some(status.id.clone()),
        org_id: "org-two".to_string(),
        key: None,
        name: "Hijacked status".to_string(),
        category: None,
        color: None,
        description: None,
        position: None,
    })
    .expect_err("cross-org status id");
    for error in [property_error, view_error, action_error, status_error] {
        assert!(
            error.starts_with("PM_ERR:ORG_SCOPE_MISMATCH:"),
            "stable ownership error expected, got {error}"
        );
    }

    let mut remote_property = property.clone();
    remote_property.org_id = "org-two".to_string();
    remote_property.name = "Remote hijack property".to_string();
    remote_property.updated_at = "2099-01-01T00:00:00Z".to_string();
    properties::apply_wire_definitions(
        &connection,
        "org-two",
        &json!({ "propertyDefinitions": [remote_property] }),
    )
    .expect("cross-org remote property is skipped");

    let mut remote_view = view.clone();
    remote_view.org_id = "org-two".to_string();
    remote_view.name = "Remote hijack view".to_string();
    remote_view.updated_at += 10_000;
    saved_views::apply_wire_views(
        &connection,
        "org-two",
        &json!({ "savedViews": [remote_view] }),
    )
    .expect("cross-org remote view is skipped");

    let mut remote_action = action.clone();
    remote_action.org_id = "org-two".to_string();
    remote_action.name = "Remote hijack action".to_string();
    remote_action.updated_at += 10_000;
    quick_actions::apply_wire_actions(
        &connection,
        "org-two",
        &json!({ "quickActions": [remote_action] }),
    )
    .expect("cross-org remote action is skipped");

    let mut remote_status = status.clone();
    remote_status.org_id = "org-two".to_string();
    remote_status.name = "Remote hijack status".to_string();
    remote_status.updated_at += 10_000;
    statuses::apply_wire_definitions(
        &connection,
        "org-two",
        &json!({ "statusDefinitions": [remote_status] }),
    )
    .expect("cross-org remote status is skipped");

    assert_eq!(
        properties::list_definitions("personal-org", true).expect("owner properties")[0].name,
        "Owner property"
    );
    assert_eq!(
        saved_views::list_views("personal-org", None).expect("owner views")[0].name,
        "Owner view"
    );
    assert_eq!(
        quick_actions::list_actions("personal-org").expect("owner actions")[0].name,
        "Owner action"
    );
    assert_eq!(
        statuses::list_definitions("personal-org", true).expect("owner statuses")[0].name,
        "Owner status"
    );
    assert!(
        properties::list_definitions("org-two", true)
            .expect("other properties")
            .is_empty()
            && saved_views::list_views("org-two", None)
                .expect("other views")
                .is_empty()
            && quick_actions::list_actions("org-two")
                .expect("other actions")
                .is_empty()
            && statuses::list_definitions("org-two", true)
                .expect("other statuses")
                .is_empty(),
        "remote collision records must not be re-owned by the receiving org"
    );
}

#[test]
fn quick_action_targets_are_validated_before_persistence() {
    let _sandbox = test_env::sandbox();
    let error = quick_actions::upsert_action(quick_actions::UpsertQuickActionRequest {
        id: Some("action_missing_target".to_string()),
        org_id: "personal-org".to_string(),
        name: "Missing target".to_string(),
        description: String::new(),
        target_kind: "agent".to_string(),
        target_id: "custom:missing".to_string(),
        prompt: "Do work".to_string(),
        created_by: None,
    })
    .expect_err("unknown agent definitions must be rejected");
    assert_eq!(
        error,
        "PM_ERR:QUICK_ACTION_TARGET_NOT_FOUND:agent:custom:missing"
    );

    let connection = conn().expect("connection");
    let invalid_remote = quick_actions::QuickAction {
        id: "action_remote_missing_target".to_string(),
        org_id: "personal-org".to_string(),
        name: "Remote missing target".to_string(),
        description: String::new(),
        target_kind: "agent_org".to_string(),
        target_id: "missing-agent-org".to_string(),
        prompt: "Do work".to_string(),
        use_count: 0,
        created_by: None,
        archived_at: None,
        created_at: 1,
        updated_at: 1,
    };
    quick_actions::apply_wire_actions(
        &connection,
        "personal-org",
        &json!({ "quickActions": [invalid_remote] }),
    )
    .expect("invalid remote targets are skipped without poisoning the snapshot");
    assert!(
        quick_actions::list_actions("personal-org")
            .expect("actions after rejected writes")
            .is_empty(),
        "target validation must run before either local or remote persistence"
    );

    let agent_orgs_path = app_paths::agent_orgs();
    std::fs::create_dir_all(agent_orgs_path.parent().expect("agent orgs parent"))
        .expect("create agent org registry directory");
    std::fs::write(
        &agent_orgs_path,
        r#"[{"id":"team-valid","name":"Valid team","role":"Coordinator","agentId":"builtin:sde"}]"#,
    )
    .expect("seed authoritative Agent Org registry");
    let valid_org_action = quick_actions::upsert_action(quick_actions::UpsertQuickActionRequest {
        id: Some("action_valid_agent_org".to_string()),
        org_id: "personal-org".to_string(),
        name: "Valid Agent Org".to_string(),
        description: String::new(),
        target_kind: "agent_org".to_string(),
        target_id: "team-valid".to_string(),
        prompt: "Do team work".to_string(),
        created_by: None,
    })
    .expect("registered Agent Org target is accepted");
    assert_eq!(valid_org_action.target_id, "team-valid");
}

#[test]
fn field_changes_notify_subscribers_and_honor_category_mutes() {
    let _sandbox = test_env::sandbox();
    seed(false);
    subscriptions::list(&scope()).expect("bootstrap implicit subscriptions");

    let actor = crate::projects::types::WorkItemMutationActor {
        id: "member-9".to_string(),
        name: "Member Nine".to_string(),
    };
    work_service::transition_project_work_item(
        "demo",
        "AAA-0001",
        "in_progress",
        None,
        Some(&actor),
        None,
    )
    .expect("transition");

    let connection = conn().expect("connection");
    let read_event = |recipient: &str| -> Option<(String, String)> {
        connection
            .query_row(
                "SELECT kind, payload_json FROM pm_work_item_inbox_events
                  WHERE recipient_id = ?1 AND work_item_id = 'AAA-0001'",
                rusqlite::params![recipient],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
    };
    let (kind, payload) = read_event("creator-1").expect("creator is notified");
    assert_eq!(kind, "status_changed");
    let decoded: serde_json::Value = serde_json::from_str(&payload).expect("payload json");
    assert_eq!(decoded["changes"]["status"]["to"], "in_progress");
    assert!(
        read_event("member-9").is_none(),
        "the actor never notifies themselves"
    );

    subscriptions::set_kind_muted("creator-1", "priority_changed", true).expect("mute kind");
    connection
        .execute(
            "DELETE FROM pm_work_item_inbox_events WHERE recipient_id = 'creator-1'",
            [],
        )
        .expect("clear inbox");
    crate::projects::io::update_work_item_partial(
        "demo",
        "AAA-0001",
        &crate::projects::types::WorkItemPartialUpdate {
            priority: Some("high".to_string()),
            actor: Some(actor.clone()),
            ..Default::default()
        },
    )
    .expect("priority update");
    assert!(
        read_event("creator-1").is_none(),
        "a muted category writes no inbox row"
    );
}

#[test]
fn child_terminal_status_notifies_the_parent_subscribers() {
    let _sandbox = test_env::sandbox();
    seed_with_config(false, "builtin:sde");
    subscriptions::list(&scope()).expect("bootstrap implicit subscriptions");

    work_service::create_project_work_item(
        "demo",
        "AAA-0002",
        &CreateWorkItemRequest {
            title: "Child work".to_string(),
            body: String::new(),
            created_by: Some("creator-1".to_string()),
            parent: Some("AAA-0001".to_string()),
            ..Default::default()
        },
        None,
    )
    .expect("seed child");

    let actor = crate::projects::types::WorkItemMutationActor {
        id: "member-9".to_string(),
        name: "Member Nine".to_string(),
    };
    work_service::transition_project_work_item(
        "demo",
        "AAA-0002",
        "in_progress",
        None,
        Some(&actor),
        None,
    )
    .expect("start the child");
    work_service::transition_project_work_item(
        "demo",
        "AAA-0002",
        "completed",
        None,
        Some(&actor),
        None,
    )
    .expect("complete the child");

    let connection = conn().expect("connection");
    let kind: String = connection
        .query_row(
            "SELECT kind FROM pm_work_item_inbox_events
              WHERE recipient_id = 'creator-1' AND work_item_id = 'AAA-0001'
                AND kind = 'child_completed'",
            [],
            |row| row.get(0),
        )
        .expect("parent subscriber is notified about the finished child");
    assert_eq!(kind, "child_completed");

    let parent = crate::projects::io::read_work_item("demo", "AAA-0001")
        .expect("read parent after child completion");
    let system_comments = parent
        .frontmatter
        .comments
        .iter()
        .filter(|comment| comment.author == "ORGII")
        .collect::<Vec<_>>();
    assert_eq!(system_comments.len(), 1);
    assert_eq!(
        system_comments[0].content,
        "Child AAA-0002 “Child work” reached completed."
    );

    let parent_runs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_work_item_runs
              WHERE work_item_id = 'AAA-0001' AND trigger_json LIKE '%system-child-terminal:%'",
            [],
            |row| row.get(0),
        )
        .expect("system comment routes through the parent Discussion");
    assert_eq!(parent_runs, 1);
}

#[test]
fn child_terminal_system_comment_is_idempotent_per_transition() {
    let _sandbox = test_env::sandbox();
    seed_with_config(false, "builtin:sde");
    let mut connection = conn().expect("connection");
    let tx = connection.transaction().expect("transaction");

    let first = super::post_child_terminal_system_comment_in_transaction(
        &tx,
        super::ChildTerminalSystemComment {
            project_slug: Some("demo"),
            org_id: "personal-org",
            parent_short_id: "AAA-0001",
            child_short_id: "AAA-0002",
            child_title: "Child work",
            status: "completed",
            child_revision: 7,
        },
    )
    .expect("first system comment");
    let replay = super::post_child_terminal_system_comment_in_transaction(
        &tx,
        super::ChildTerminalSystemComment {
            project_slug: Some("demo"),
            org_id: "personal-org",
            parent_short_id: "AAA-0001",
            child_short_id: "AAA-0002",
            child_title: "Child work",
            status: "completed",
            child_revision: 7,
        },
    )
    .expect("idempotent replay");
    let missing_parent = super::post_child_terminal_system_comment_in_transaction(
        &tx,
        super::ChildTerminalSystemComment {
            project_slug: Some("demo"),
            org_id: "personal-org",
            parent_short_id: "AAA-missing",
            child_short_id: "AAA-0002",
            child_title: "Child work",
            status: "completed",
            child_revision: 8,
        },
    )
    .expect("a stale parent link must not block child completion");
    tx.commit().expect("commit");

    assert!(first);
    assert!(!replay);
    assert!(!missing_parent);
    let parent = crate::projects::io::read_work_item("demo", "AAA-0001").expect("read parent");
    assert_eq!(
        parent
            .frontmatter
            .comments
            .iter()
            .filter(|comment| comment.id == "system-child-terminal:AAA-0002:7")
            .count(),
        1
    );
}

#[test]
fn archiving_an_inbox_item_hides_it_and_marks_it_read() {
    let _sandbox = test_env::sandbox();
    seed(false);
    subscriptions::list(&scope()).expect("bootstrap implicit subscriptions");

    let actor = crate::projects::types::WorkItemMutationActor {
        id: "member-9".to_string(),
        name: "Member Nine".to_string(),
    };
    work_service::transition_project_work_item(
        "demo",
        "AAA-0001",
        "in_progress",
        None,
        Some(&actor),
        None,
    )
    .expect("transition");

    let viewers = vec!["creator-1".to_string()];
    let page = crate::team_inbox::list_page(crate::team_inbox::TeamInboxListOptions::new(
        viewers.clone(),
    ))
    .expect("inbox page");
    let target = page
        .items
        .iter()
        .find(|item| item.id.starts_with("work_item_subscription_event:"))
        .expect("the change event is listed")
        .id
        .clone();

    crate::team_inbox::set_archived(&viewers, &target, true).expect("archive");
    let after = crate::team_inbox::list_page(crate::team_inbox::TeamInboxListOptions::new(
        viewers.clone(),
    ))
    .expect("inbox page");
    assert!(
        !after.items.iter().any(|item| item.id == target),
        "archived rows leave the page"
    );
    assert_eq!(after.unread_count, 0, "archiving also acknowledges the row");

    crate::team_inbox::set_archived(&viewers, &target, false).expect("unarchive");
    let restored =
        crate::team_inbox::list_page(crate::team_inbox::TeamInboxListOptions::new(viewers))
            .expect("inbox page");
    assert!(
        restored.items.iter().any(|item| item.id == target),
        "unarchive restores the row"
    );
}
