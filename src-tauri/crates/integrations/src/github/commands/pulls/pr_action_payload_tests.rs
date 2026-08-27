use super::super::reviewers::normalize_reviewer_logins;
use super::*;

#[test]
fn merge_payload_uses_an_allowed_method_and_expected_head_sha() {
    assert_eq!(
        build_merge_payload("squash", Some("head-sha")).unwrap(),
        json!({ "merge_method": "squash", "sha": "head-sha" })
    );
    assert!(build_merge_payload("octopus", None).is_err());
}

#[test]
fn auto_merge_payloads_match_each_mutations_input_schema() {
    let enable =
        build_auto_merge_graphql_request(true, Some("rebase"), "pull-request-node", "head-sha")
            .unwrap();
    assert_eq!(enable.mutation_field, "enablePullRequestAutoMerge");
    assert_eq!(
        enable.input,
        json!({
            "pullRequestId": "pull-request-node",
            "expectedHeadOid": "head-sha",
            "mergeMethod": "REBASE",
        })
    );

    let disable =
        build_auto_merge_graphql_request(false, None, "pull-request-node", "head-sha").unwrap();
    assert_eq!(disable.mutation_field, "disablePullRequestAutoMerge");
    assert_eq!(
        disable.input,
        json!({
            "pullRequestId": "pull-request-node",
        })
    );
}

#[test]
fn draft_state_payloads_use_the_matching_graphql_mutation() {
    let convert = build_draft_state_graphql_request(true, "pull-request-node");
    assert_eq!(convert.mutation, CONVERT_PULL_REQUEST_TO_DRAFT_MUTATION);
    assert_eq!(convert.mutation_field, "convertPullRequestToDraft");
    assert_eq!(
        convert.input,
        json!({ "pullRequestId": "pull-request-node" })
    );

    let ready = build_draft_state_graphql_request(false, "pull-request-node");
    assert_eq!(ready.mutation, MARK_PULL_REQUEST_READY_FOR_REVIEW_MUTATION);
    assert_eq!(ready.mutation_field, "markPullRequestReadyForReview");
    assert_eq!(ready.input, json!({ "pullRequestId": "pull-request-node" }));
}

#[test]
fn merge_queue_payloads_enqueue_by_pr_and_dequeue_by_entry() {
    let enqueue =
        build_merge_queue_graphql_request(true, "pull-request-node", None, "head-sha").unwrap();
    assert_eq!(enqueue.mutation_field, "enqueuePullRequest");
    assert_eq!(
        enqueue.input,
        json!({
            "pullRequestId": "pull-request-node",
            "expectedHeadOid": "head-sha",
        })
    );

    let dequeue = build_merge_queue_graphql_request(
        false,
        "pull-request-node",
        Some("queue-entry"),
        "head-sha",
    )
    .unwrap();
    assert_eq!(dequeue.mutation_field, "dequeuePullRequest");
    assert_eq!(dequeue.input, json!({ "id": "queue-entry" }));
    assert!(
        build_merge_queue_graphql_request(false, "pull-request-node", None, "head-sha").is_err()
    );
}

#[test]
fn merge_queue_requires_clean_merge_state_without_review_blockers() {
    let ready = PullRequestMergeAutomationContext {
        merge_state_status: Some("CLEAN".to_string()),
        ..Default::default()
    };
    let review_blocked = PullRequestMergeAutomationContext {
        merge_state_status: Some("CLEAN".to_string()),
        review_decision: Some("REVIEW_REQUIRED".to_string()),
        ..Default::default()
    };
    let checks_blocked = PullRequestMergeAutomationContext {
        merge_state_status: Some("BLOCKED".to_string()),
        ..Default::default()
    };

    assert!(ready.ready_for_merge_queue());
    assert!(!review_blocked.ready_for_merge_queue());
    assert!(!checks_blocked.ready_for_merge_queue());
}

#[test]
fn pr_detail_enrichment_preserves_graphql_merge_state() {
    let mut detail = json!({ "mergeable_state": "unknown" });

    apply_pull_request_merge_context(
        &mut detail,
        PullRequestMergeAutomationContext {
            merge_queue_enabled: true,
            merge_queue_entry_id: Some("queue-entry".to_string()),
            merge_state_status: Some("DIRTY".to_string()),
            review_decision: Some("CHANGES_REQUESTED".to_string()),
        },
    );

    assert_eq!(detail["merge_queue_required"], json!(true));
    assert_eq!(detail["is_in_merge_queue"], json!(true));
    assert_eq!(detail["merge_state_status"], json!("DIRTY"));
    assert_eq!(detail["review_decision"], json!("CHANGES_REQUESTED"));
}

#[test]
fn reviewer_logins_are_trimmed_and_deduplicated_case_insensitively() {
    assert_eq!(
        normalize_reviewer_logins(vec![
            " Reviewer ".to_string(),
            "reviewer".to_string(),
            "second".to_string(),
            " ".to_string(),
        ])
        .unwrap(),
        vec!["Reviewer".to_string(), "second".to_string()]
    );
    assert!(normalize_reviewer_logins(vec![" ".to_string()]).is_err());
}

#[test]
fn graphql_errors_are_preserved_for_the_frontend() {
    assert_eq!(
        graphql_error(&json!({
            "errors": [
                { "message": "Auto-merge is disabled" },
                { "message": "Approval is required" }
            ]
        })),
        Some("Auto-merge is disabled; Approval is required".to_string())
    );
}
