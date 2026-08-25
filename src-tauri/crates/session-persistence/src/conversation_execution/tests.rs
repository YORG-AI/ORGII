use std::sync::atomic::{AtomicUsize, Ordering};

use database::db::get_connection;
use rusqlite::Connection;

use super::schema;
use super::store;
use super::types::*;

static TEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

fn with_test_database<T>(run: impl FnOnce() -> T) -> T {
    let _guard = match crate::ORGII_HOME_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let previous = std::env::var("ORGII_HOME").ok();
    let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "orgii-conversation-execution-test-{}-{sequence}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create test ORGII_HOME");
    std::env::set_var("ORGII_HOME", &root);
    {
        let conn = get_connection().expect("open test sessions database");
        crate::schema::init_session_tables(&conn).expect("initialize session schema");
    }
    let result = run();
    match previous {
        Some(value) => std::env::set_var("ORGII_HOME", value),
        None => std::env::remove_var("ORGII_HOME"),
    }
    let _ = std::fs::remove_dir_all(root);
    result
}

fn execution_key(suffix: &str) -> ConversationExecutionKey {
    ConversationExecutionKey {
        executor_scope: format!(
            "[\"org2-conversation-executor\",1,\"local-device\",[\"{suffix}\"]]"
        ),
        conversation_root_key: format!(
            "[\"org2-conversation-root\",1,\"external-history\",[\"manual\"],\"{suffix}\"]"
        ),
    }
}

fn digest(index: usize) -> String {
    format!("{index:064x}")
}

fn source(index: usize) -> ConversationSourceCheckpoint {
    if index == 0 {
        return ConversationSourceCheckpoint {
            source_checkpoint_id: None,
            source_checkpoint_sha256: None,
            source_event_count: 0,
            source_tip_event_id: None,
        };
    }
    ConversationSourceCheckpoint {
        source_checkpoint_id: Some(format!("checkpoint-{index}")),
        source_checkpoint_sha256: Some(digest(index)),
        source_event_count: index as i64,
        source_tip_event_id: Some(format!("event-{index}")),
    }
}

fn runtime(category: &str, runtime_id: &str) -> ConversationRuntimeProfile {
    ConversationRuntimeProfile {
        runtime_category: category.to_string(),
        runtime_id: runtime_id.to_string(),
        agent_id: Some("agent:builder".to_string()),
        account_id: Some("account:test".to_string()),
        model_id: Some("model:test".to_string()),
        workspace_locator: Some("/authorized/workspace".to_string()),
        workspace_fingerprint: Some("workspace:sha256:test".to_string()),
        execution_profile_fingerprint: format!("profile:{category}:{runtime_id}"),
    }
}

fn prepare_request(
    key: &ConversationExecutionKey,
    index: usize,
    expected_revision: i64,
) -> ConversationExecutionPrepareCandidateRequest {
    ConversationExecutionPrepareCandidateRequest {
        key: key.clone(),
        expected_revision,
        episode_id: format!("episode-{index}"),
        runner_session_id: format!("org2-runner-{index}"),
        native_session_id: format!("native-{index}"),
        bootstrap_intent_id: format!("turn-{index}"),
        source: source(index + 1),
        runtime: runtime("cli", "codex"),
    }
}

fn begin_request(
    prepare: &ConversationExecutionPrepareCandidateRequest,
    expected_revision: i64,
) -> ConversationExecutionBeginMaterializationRequest {
    ConversationExecutionBeginMaterializationRequest {
        key: prepare.key.clone(),
        expected_revision,
        expected_candidate_episode_id: prepare.episode_id.clone(),
        runner_session_id: prepare.runner_session_id.clone(),
        native_session_id: prepare.native_session_id.clone(),
        bootstrap_intent_id: prepare.bootstrap_intent_id.clone(),
    }
}

fn activate_request(
    prepare: &ConversationExecutionPrepareCandidateRequest,
    expected_revision: i64,
    expected_active_episode_id: Option<String>,
) -> ConversationExecutionActivateCandidateRequest {
    ConversationExecutionActivateCandidateRequest {
        key: prepare.key.clone(),
        expected_revision,
        expected_active_episode_id,
        expected_candidate_episode_id: prepare.episode_id.clone(),
        runner_session_id: prepare.runner_session_id.clone(),
        native_session_id: prepare.native_session_id.clone(),
        bootstrap_intent_id: prepare.bootstrap_intent_id.clone(),
        verified_materialization_sha256: digest(10_000 + expected_revision as usize),
        activation_receipt_id: format!("accepted-turn-{expected_revision}"),
    }
}

fn prepare_begin_activate(
    prepare: ConversationExecutionPrepareCandidateRequest,
    expected_active_episode_id: Option<String>,
) -> ConversationExecutionSnapshot {
    let prepared = store::prepare_candidate(prepare.clone()).expect("prepare candidate");
    let materializing = store::begin_materialization(begin_request(
        &prepare,
        prepared.snapshot.execution.revision,
    ))
    .expect("begin materialization");
    store::activate_candidate(activate_request(
        &prepare,
        materializing.snapshot.execution.revision,
        expected_active_episode_id,
    ))
    .expect("activate candidate")
    .snapshot
}

#[test]
fn schema_is_reentrant_without_foreign_keys_or_transport_fields() {
    let conn = Connection::open_in_memory().expect("open in-memory database");
    schema::init_schema(&conn).expect("initialize schema");
    schema::init_schema(&conn).expect("reinitialize schema");

    for table in [
        "conversation_executions",
        "conversation_execution_episodes",
        "conversation_runner_registry",
    ] {
        let foreign_key_count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM pragma_foreign_key_list('{table}')"),
                [],
                |row| row.get(0),
            )
            .expect("inspect foreign keys");
        assert_eq!(foreign_key_count, 0, "{table} must not have foreign keys");
    }
    let ddl: String = conn
        .query_row(
            "SELECT group_concat(sql, '\n') FROM sqlite_master
             WHERE name LIKE 'conversation_%'",
            [],
            |row| row.get(0),
        )
        .expect("read canonical DDL");
    for forbidden in ["root_session_id", "plane_seq", "work_item", "cloud_org"] {
        assert!(
            !ddl.to_ascii_lowercase().contains(forbidden),
            "generic schema leaked {forbidden}: {ddl}"
        );
    }
}

#[test]
fn prepare_is_idempotent_and_revision_cas_rejects_another_candidate() {
    with_test_database(|| {
        let key = execution_key("prepare");
        let first = prepare_request(&key, 1, 0);
        let prepared = store::prepare_candidate(first.clone()).expect("prepare first");
        assert!(prepared.applied);
        assert_eq!(prepared.snapshot.execution.revision, 1);
        assert_eq!(
            prepared.snapshot.execution.candidate_episode_id.as_deref(),
            Some("episode-1")
        );

        let retry = store::prepare_candidate(first).expect("idempotent prepare");
        assert!(!retry.applied);
        assert_eq!(retry.snapshot.execution.revision, 1);

        let conflict = store::prepare_candidate(prepare_request(&key, 2, 0))
            .expect_err("a second candidate must not race the first");
        assert!(conflict.contains("already has candidate"));
    });
}

#[test]
fn activation_requires_materialization_reparse_and_first_turn_receipt() {
    with_test_database(|| {
        let key = execution_key("activation-boundary");
        let prepare = prepare_request(&key, 1, 0);
        let prepared = store::prepare_candidate(prepare.clone()).expect("prepare candidate");

        let premature = store::activate_candidate(activate_request(
            &prepare,
            prepared.snapshot.execution.revision,
            None,
        ))
        .expect_err("prepared-only candidate must not activate");
        assert!(premature.contains("materializing"));

        let materializing = store::begin_materialization(begin_request(
            &prepare,
            prepared.snapshot.execution.revision,
        ))
        .expect("begin materialization");
        let mut no_receipt =
            activate_request(&prepare, materializing.snapshot.execution.revision, None);
        no_receipt.activation_receipt_id.clear();
        assert!(store::activate_candidate(no_receipt)
            .expect_err("first-turn receipt is required")
            .contains("activationReceiptId"));

        let activated_request =
            activate_request(&prepare, materializing.snapshot.execution.revision, None);
        let activated = store::activate_candidate(activated_request.clone())
            .expect("activate after verification and acceptance");
        assert_eq!(
            activated.snapshot.episodes[0].state,
            ConversationExecutionEpisodeState::Active
        );
        assert!(activated.snapshot.episodes[0]
            .verified_materialization_sha256
            .is_some());
        assert!(activated.snapshot.episodes[0]
            .activation_receipt_id
            .is_some());

        let retry =
            store::activate_candidate(activated_request).expect("activation retry is idempotent");
        assert!(!retry.applied);
    });
}

#[test]
fn cold_boot_recovers_materializing_candidate_and_explicit_workspace() {
    with_test_database(|| {
        let key = execution_key("cold-boot");
        let prepare = prepare_request(&key, 1, 0);
        let prepared = store::prepare_candidate(prepare.clone()).expect("prepare candidate");
        let request = begin_request(&prepare, prepared.snapshot.execution.revision);
        let materializing =
            store::begin_materialization(request.clone()).expect("begin materialization");
        assert_eq!(materializing.snapshot.execution.revision, 2);

        // A new DB connection is the restart boundary; no localStorage or
        // in-memory runtime registry participates in this recovery.
        let recovered = store::load_snapshot(&key)
            .expect("load after restart")
            .expect("durable execution");
        assert_eq!(
            recovered.episodes[0].state,
            ConversationExecutionEpisodeState::Materializing
        );
        assert_eq!(
            recovered.episodes[0].runtime.workspace_locator.as_deref(),
            Some("/authorized/workspace")
        );
        let retry =
            store::begin_materialization(request).expect("materialization restart is idempotent");
        assert!(!retry.applied);
    });
}

#[test]
fn global_runner_identity_is_separate_from_provider_native_uuid() {
    with_test_database(|| {
        let first_key = execution_key("claude");
        let mut claude = prepare_request(&first_key, 1, 0);
        claude.native_session_id = "provider-shared-uuid".to_string();
        claude.runtime = runtime("cli", "claude");
        store::prepare_candidate(claude.clone()).expect("prepare Claude candidate");

        let second_key = execution_key("codex");
        let mut codex = prepare_request(&second_key, 2, 0);
        codex.native_session_id = "provider-shared-uuid".to_string();
        codex.runtime = runtime("cli", "codex");
        store::prepare_candidate(codex).expect("same provider UUID under another runtime is valid");

        let third_key = execution_key("claude-duplicate");
        let mut duplicate_native = prepare_request(&third_key, 3, 0);
        duplicate_native.native_session_id = "provider-shared-uuid".to_string();
        duplicate_native.runtime = runtime("cli", "claude");
        assert!(store::prepare_candidate(duplicate_native)
            .expect_err("same native target/profile must not be reused")
            .contains("already owned"));

        let fourth_key = execution_key("runner-collision");
        let mut runner_collision = prepare_request(&fourth_key, 4, 0);
        runner_collision.runner_session_id = claude.runner_session_id;
        assert!(store::prepare_candidate(runner_collision)
            .expect_err("ORG2 runner ids are globally unique")
            .contains("different conversation episode"));
    });
}

#[test]
fn checkpoint_progress_is_explicit_monotonic_and_has_no_negative_sentinel() {
    with_test_database(|| {
        let key = execution_key("checkpoint");
        let active = prepare_begin_activate(prepare_request(&key, 1, 0), None);
        let active_episode = active.episodes.last().expect("active episode");

        let advanced_source = source(10);
        let request = ConversationExecutionAdvanceCheckpointRequest {
            key: key.clone(),
            expected_revision: active.execution.revision,
            episode_id: active_episode.episode_id.clone(),
            runner_session_id: active_episode.runner_session_id.clone(),
            source: advanced_source.clone(),
        };
        let advanced = store::advance_checkpoint(request.clone()).expect("advance checkpoint");
        assert_eq!(advanced.snapshot.episodes[0].source, advanced_source);

        let retry = store::advance_checkpoint(request).expect("checkpoint retry");
        assert!(!retry.applied);

        let mut divergent = source(10);
        divergent.source_checkpoint_sha256 = Some(digest(999));
        assert!(
            store::advance_checkpoint(ConversationExecutionAdvanceCheckpointRequest {
                key: key.clone(),
                expected_revision: advanced.snapshot.execution.revision,
                episode_id: active_episode.episode_id.clone(),
                runner_session_id: active_episode.runner_session_id.clone(),
                source: divergent,
            })
            .expect_err("same-length divergent checkpoint must fail")
            .contains("same event count")
        );

        let mut invalid_prepare = prepare_request(&execution_key("negative"), 2, 0);
        invalid_prepare.source.source_event_count = -1;
        assert!(store::prepare_candidate(invalid_prepare)
            .expect_err("negative sentinel must be rejected")
            .contains("non-negative"));
    });
}

#[test]
fn candidate_activation_rolls_active_episode_and_lineage_is_bounded() {
    with_test_database(|| {
        let key = execution_key("lineage");
        let mut snapshot: Option<ConversationExecutionSnapshot> = None;
        for index in 0..(MAX_CONVERSATION_EXECUTION_EPISODES + 5) {
            let revision = snapshot
                .as_ref()
                .map_or(0, |snapshot| snapshot.execution.revision);
            let active_id = snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.execution.active_episode_id.clone());
            snapshot = Some(prepare_begin_activate(
                prepare_request(&key, index + 1, revision),
                active_id,
            ));
        }
        let snapshot = snapshot.expect("final snapshot");
        assert_eq!(snapshot.episodes.len(), MAX_CONVERSATION_EXECUTION_EPISODES);
        let active_id = snapshot
            .execution
            .active_episode_id
            .as_deref()
            .expect("active pointer");
        assert!(snapshot.episodes.iter().any(|episode| {
            episode.episode_id == active_id
                && episode.state == ConversationExecutionEpisodeState::Active
        }));
        assert!(!snapshot
            .episodes
            .iter()
            .any(|episode| episode.episode_id == "episode-1"));
    });
}

#[test]
fn terminal_registry_cleanup_requires_final_episode() {
    with_test_database(|| {
        let key = execution_key("cleanup");
        let active = prepare_begin_activate(prepare_request(&key, 1, 0), None);
        let episode = active.episodes.last().expect("active episode").clone();
        let identity = ConversationRunnerIdentityRequest {
            runner_session_id: episode.runner_session_id.clone(),
            executor_scope: key.executor_scope.clone(),
            conversation_root_key: key.conversation_root_key.clone(),
            episode_id: episode.episode_id.clone(),
        };
        assert!(store::mark_runner_terminal(identity.clone())
            .expect_err("active runner must not be terminal")
            .contains("retire or abort"));

        let retired = store::retire_active(ConversationExecutionRetireActiveRequest {
            key: key.clone(),
            expected_revision: active.execution.revision,
            expected_active_episode_id: episode.episode_id.clone(),
            runner_session_id: episode.runner_session_id.clone(),
            final_state: ConversationExecutionFinalState::Retired,
            roll_reason: "manual_roll".to_string(),
        })
        .expect("retire active");
        assert!(retired.snapshot.execution.active_episode_id.is_none());

        let terminal = store::mark_runner_terminal(identity.clone()).expect("mark terminal");
        assert!(terminal.applied);
        let candidates =
            store::list_cleanup_candidates(ConversationRunnerCleanupCandidatesRequest {
                terminal_before: "2999-01-01T00:00:00.000Z".to_string(),
                limit: 10,
            })
            .expect("list cleanup candidates");
        assert_eq!(candidates.len(), 1);

        assert!(
            store::forget_runner(identity)
                .expect("forget terminal runner")
                .applied
        );
        assert!(store::list_runner_ids(ConversationRunnerPageRequest {
            after_runner_session_id: None,
            limit: 10,
        })
        .expect("list registry")
        .runner_session_ids
        .is_empty());
    });
}

#[test]
fn legacy_import_preserves_only_generic_runner_registry() {
    with_test_database(|| {
        let key = execution_key("legacy");
        let empty = ConversationExecutionImportLegacyRunnersRequest {
            key: key.clone(),
            runners: Vec::new(),
        };
        assert!(store::import_legacy_runners(empty).is_err());
        assert!(store::load_snapshot(&key)
            .expect("read after rejected empty import")
            .is_none());

        let request = ConversationExecutionImportLegacyRunnersRequest {
            key: key.clone(),
            runners: vec![
                LegacyConversationRunnerImport {
                    runner_session_id: "legacy-live".to_string(),
                    episode_id: "legacy-episode-live".to_string(),
                    terminal: false,
                },
                LegacyConversationRunnerImport {
                    runner_session_id: "legacy-terminal".to_string(),
                    episode_id: "legacy-episode-terminal".to_string(),
                    terminal: true,
                },
            ],
        };
        let imported = store::import_legacy_runners(request.clone()).expect("import registry");
        assert!(imported.applied);
        assert_eq!(imported.snapshot.execution.revision, 0);
        assert!(imported.snapshot.execution.active_episode_id.is_none());
        assert!(imported.snapshot.execution.candidate_episode_id.is_none());
        assert!(imported.snapshot.episodes.is_empty());

        // There is no API field through which old plane cursors, owner
        // cursors, or unpublished prepared episodes could be guessed.
        let retry = store::import_legacy_runners(request).expect("idempotent import");
        assert!(!retry.applied);
        assert_eq!(
            store::list_runner_ids(ConversationRunnerPageRequest {
                after_runner_session_id: None,
                limit: 10,
            })
            .expect("list imported runners")
            .runner_session_ids,
            vec!["legacy-live".to_string(), "legacy-terminal".to_string()]
        );
    });
}

#[test]
fn abort_is_idempotent_and_keeps_active_predecessor() {
    with_test_database(|| {
        let key = execution_key("abort");
        let active = prepare_begin_activate(prepare_request(&key, 1, 0), None);
        let candidate = prepare_request(&key, 2, active.execution.revision);
        let prepared = store::prepare_candidate(candidate.clone()).expect("prepare roll");
        let request = ConversationExecutionAbortCandidateRequest {
            key: key.clone(),
            expected_revision: prepared.snapshot.execution.revision,
            expected_candidate_episode_id: candidate.episode_id.clone(),
            runner_session_id: candidate.runner_session_id.clone(),
            final_state: ConversationExecutionFinalState::Failed,
            roll_reason: "native_publish_failed".to_string(),
        };
        let aborted = store::abort_candidate(request.clone()).expect("abort candidate");
        assert_eq!(
            aborted.snapshot.execution.active_episode_id,
            active.execution.active_episode_id
        );
        assert!(aborted.snapshot.execution.candidate_episode_id.is_none());
        let retry = store::abort_candidate(request).expect("abort retry");
        assert!(!retry.applied);
    });
}
