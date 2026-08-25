use std::collections::HashSet;

use database::db::{begin_immediate, get_connection, with_sessions_writer};
use rusqlite::{params, OptionalExtension, Transaction};

use super::super::types::{
    ConversationExecutionAbortCandidateRequest, ConversationExecutionActivateCandidateRequest,
    ConversationExecutionAdvanceCheckpointRequest,
    ConversationExecutionBeginMaterializationRequest, ConversationExecutionEpisode,
    ConversationExecutionEpisodeState, ConversationExecutionKey,
    ConversationExecutionMutationResult, ConversationExecutionPrepareCandidateRequest,
    ConversationExecutionRecord, ConversationExecutionRetireActiveRequest,
    ConversationExecutionSnapshot, ConversationRunnerRegistration,
    MAX_CONVERSATION_EXECUTION_EPISODES,
};
use super::read::{
    get_execution_snapshot, load_episode, load_execution, load_registration, require_snapshot,
};
use super::{
    now_iso, validate_key, validate_optional, validate_required, validate_revision,
    validate_roll_reason, validate_runtime_profile, validate_sha256, validate_source_checkpoint,
    MAX_ID_CHARS,
};

const SUPERSEDED_ROLL_REASON: &str = "superseded_by_verified_candidate";

fn assert_revision(
    execution: &ConversationExecutionRecord,
    expected_revision: i64,
) -> Result<(), String> {
    if execution.revision != expected_revision {
        return Err(format!(
            "conversation execution revision conflict: expected {}, observed {}",
            expected_revision, execution.revision
        ));
    }
    Ok(())
}

fn validate_prepare(request: &ConversationExecutionPrepareCandidateRequest) -> Result<(), String> {
    validate_key(&request.key)?;
    validate_revision(request.expected_revision)?;
    validate_required("episodeId", &request.episode_id, MAX_ID_CHARS)?;
    validate_required("runnerSessionId", &request.runner_session_id, MAX_ID_CHARS)?;
    validate_required("nativeSessionId", &request.native_session_id, MAX_ID_CHARS)?;
    validate_required(
        "bootstrapIntentId",
        &request.bootstrap_intent_id,
        MAX_ID_CHARS,
    )?;
    validate_source_checkpoint(&request.source)?;
    validate_runtime_profile(&request.runtime)
}

fn episode_matches_prepare(
    episode: &ConversationExecutionEpisode,
    request: &ConversationExecutionPrepareCandidateRequest,
) -> bool {
    episode.runner_session_id == request.runner_session_id
        && episode.native_session_id == request.native_session_id
        && episode.bootstrap_intent_id == request.bootstrap_intent_id
        && episode.source == request.source
        && episode.runtime == request.runtime
}

fn ensure_execution_row(
    transaction: &Transaction<'_>,
    request: &ConversationExecutionPrepareCandidateRequest,
    now: &str,
) -> Result<ConversationExecutionRecord, String> {
    if let Some(execution) = load_execution(transaction, &request.key)? {
        return Ok(execution);
    }
    if request.expected_revision != 0 {
        return Err(format!(
            "conversation execution revision conflict: expected {}, execution does not exist",
            request.expected_revision
        ));
    }
    transaction
        .execute(
            "INSERT INTO conversation_executions (
                executor_scope, conversation_root_key, active_episode_id,
                candidate_episode_id, revision, updated_at
             ) VALUES (?1, ?2, NULL, NULL, 0, ?3)",
            params![
                request.key.executor_scope,
                request.key.conversation_root_key,
                now,
            ],
        )
        .map_err(|err| format!("create conversation execution failed: {err}"))?;
    load_execution(transaction, &request.key)?.ok_or_else(|| {
        "conversation execution disappeared after creation inside its transaction".to_string()
    })
}

fn ensure_fresh_native_target(
    transaction: &Transaction<'_>,
    request: &ConversationExecutionPrepareCandidateRequest,
) -> Result<(), String> {
    let existing_runner = transaction
        .query_row(
            "SELECT runner_session_id
             FROM conversation_execution_episodes
             WHERE native_session_id = ?1
               AND runtime_category = ?2
               AND runtime_id = ?3
               AND execution_profile_fingerprint = ?4
             LIMIT 1",
            params![
                request.native_session_id,
                request.runtime.runtime_category,
                request.runtime.runtime_id,
                request.runtime.execution_profile_fingerprint,
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("inspect native continuation target failed: {err}"))?;
    if let Some(existing_runner) = existing_runner {
        return Err(format!(
            "native session {} is already owned by runner {existing_runner} under this runtime profile",
            request.native_session_id
        ));
    }
    Ok(())
}

fn ensure_registration_for_candidate(
    transaction: &Transaction<'_>,
    request: &ConversationExecutionPrepareCandidateRequest,
    now: &str,
) -> Result<(), String> {
    if let Some(registration) = load_registration(transaction, &request.runner_session_id)? {
        if registration.executor_scope != request.key.executor_scope
            || registration.conversation_root_key != request.key.conversation_root_key
            || registration.episode_id != request.episode_id
        {
            return Err(format!(
                "runner session {} is already registered to a different conversation episode",
                request.runner_session_id
            ));
        }
        if registration.terminal {
            return Err(format!(
                "terminal runner session {} cannot be reused",
                request.runner_session_id
            ));
        }
        return Ok(());
    }
    transaction
        .execute(
            "INSERT INTO conversation_runner_registry (
                runner_session_id, executor_scope, conversation_root_key,
                episode_id, terminal, registered_at, terminal_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 0, ?5, NULL, ?5)",
            params![
                request.runner_session_id,
                request.key.executor_scope,
                request.key.conversation_root_key,
                request.episode_id,
                now,
            ],
        )
        .map_err(|err| format!("register conversation runner failed: {err}"))?;
    Ok(())
}

fn update_execution_cas(
    transaction: &Transaction<'_>,
    key: &ConversationExecutionKey,
    expected_revision: i64,
    active_episode_id: Option<&str>,
    candidate_episode_id: Option<&str>,
    now: &str,
) -> Result<(), String> {
    let changed = transaction
        .execute(
            "UPDATE conversation_executions
             SET active_episode_id = ?3,
                 candidate_episode_id = ?4,
                 revision = revision + 1,
                 updated_at = ?5
             WHERE executor_scope = ?1 AND conversation_root_key = ?2
               AND revision = ?6",
            params![
                key.executor_scope,
                key.conversation_root_key,
                active_episode_id,
                candidate_episode_id,
                now,
                expected_revision,
            ],
        )
        .map_err(|err| format!("update conversation execution failed: {err}"))?;
    if changed != 1 {
        return Err("conversation execution changed during compare-and-swap".to_string());
    }
    Ok(())
}

fn prune_episode_lineage(
    transaction: &Transaction<'_>,
    key: &ConversationExecutionKey,
) -> Result<(), String> {
    let execution = load_execution(transaction, key)?
        .ok_or_else(|| "conversation execution disappeared before lineage pruning".to_string())?;
    let mut statement = transaction
        .prepare(
            "SELECT episode_id
             FROM conversation_execution_episodes
             WHERE executor_scope = ?1 AND conversation_root_key = ?2
             ORDER BY updated_at DESC, created_at DESC, episode_id DESC",
        )
        .map_err(|err| format!("prepare conversation lineage pruning failed: {err}"))?;
    let episode_ids = statement
        .query_map(
            params![key.executor_scope, key.conversation_root_key],
            |row| row.get::<_, String>(0),
        )
        .map_err(|err| format!("query conversation lineage for pruning failed: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("read conversation lineage for pruning failed: {err}"))?;
    drop(statement);

    let mut retained = HashSet::new();
    if let Some(active) = execution.active_episode_id {
        retained.insert(active);
    }
    if let Some(candidate) = execution.candidate_episode_id {
        retained.insert(candidate);
    }
    for episode_id in &episode_ids {
        if retained.len() >= MAX_CONVERSATION_EXECUTION_EPISODES {
            break;
        }
        retained.insert(episode_id.clone());
    }
    for episode_id in episode_ids {
        if retained.contains(&episode_id) {
            continue;
        }
        transaction
            .execute(
                "DELETE FROM conversation_execution_episodes
                 WHERE executor_scope = ?1 AND conversation_root_key = ?2
                   AND episode_id = ?3",
                params![key.executor_scope, key.conversation_root_key, episode_id],
            )
            .map_err(|err| format!("prune conversation execution episode failed: {err}"))?;
    }
    Ok(())
}

pub(super) fn commit_snapshot(
    transaction: Transaction<'_>,
    key: &ConversationExecutionKey,
    applied: bool,
) -> Result<ConversationExecutionMutationResult, String> {
    let snapshot = require_snapshot(&transaction, key)?;
    transaction
        .commit()
        .map_err(|err| format!("commit conversation execution mutation failed: {err}"))?;
    Ok(ConversationExecutionMutationResult { applied, snapshot })
}

pub(crate) fn prepare_candidate(
    request: ConversationExecutionPrepareCandidateRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    validate_prepare(&request)?;
    with_sessions_writer(|| {
        let conn = get_connection()
            .map_err(|err| format!("open sessions database for candidate prepare failed: {err}"))?;
        let transaction = begin_immediate(&conn)
            .map_err(|err| format!("begin candidate prepare transaction failed: {err}"))?;
        let now = now_iso();
        let execution = ensure_execution_row(&transaction, &request, &now)?;

        if let Some(episode) = load_episode(&transaction, &request.key, &request.episode_id)? {
            if !episode_matches_prepare(&episode, &request) {
                return Err(format!(
                    "episode {} already exists with a different execution identity",
                    request.episode_id
                ));
            }
            let owns_pointer = (episode.state.is_candidate()
                && execution.candidate_episode_id.as_deref() == Some(request.episode_id.as_str()))
                || (episode.state == ConversationExecutionEpisodeState::Active
                    && execution.active_episode_id.as_deref() == Some(request.episode_id.as_str()));
            if !owns_pointer {
                return Err(format!(
                    "episode {} already exists but is no longer resumable",
                    request.episode_id
                ));
            }
            ensure_registration_for_candidate(&transaction, &request, &now)?;
            return commit_snapshot(transaction, &request.key, false);
        }

        if let Some(candidate_episode_id) = execution.candidate_episode_id.as_deref() {
            return Err(format!(
                "conversation execution already has candidate episode {candidate_episode_id}"
            ));
        }
        assert_revision(&execution, request.expected_revision)?;
        ensure_fresh_native_target(&transaction, &request)?;
        ensure_registration_for_candidate(&transaction, &request, &now)?;
        transaction
            .execute(
                "INSERT INTO conversation_execution_episodes (
                    executor_scope, conversation_root_key, episode_id,
                    runner_session_id, native_session_id, state,
                    source_checkpoint_id, source_checkpoint_sha256,
                    source_event_count, source_tip_event_id,
                    runtime_category, runtime_id, agent_id, account_id,
                    model_id, workspace_locator, workspace_fingerprint,
                    execution_profile_fingerprint, bootstrap_intent_id,
                    verified_materialization_sha256, activation_receipt_id,
                    supersedes_episode_id, roll_reason, created_at, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, 'prepared', ?6, ?7, ?8, ?9,
                    ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                    NULL, NULL, ?19, NULL, ?20, ?20
                 )",
                params![
                    request.key.executor_scope,
                    request.key.conversation_root_key,
                    request.episode_id,
                    request.runner_session_id,
                    request.native_session_id,
                    request.source.source_checkpoint_id,
                    request.source.source_checkpoint_sha256,
                    request.source.source_event_count,
                    request.source.source_tip_event_id,
                    request.runtime.runtime_category,
                    request.runtime.runtime_id,
                    request.runtime.agent_id,
                    request.runtime.account_id,
                    request.runtime.model_id,
                    request.runtime.workspace_locator,
                    request.runtime.workspace_fingerprint,
                    request.runtime.execution_profile_fingerprint,
                    request.bootstrap_intent_id,
                    execution.active_episode_id,
                    now,
                ],
            )
            .map_err(|err| format!("insert conversation candidate episode failed: {err}"))?;
        update_execution_cas(
            &transaction,
            &request.key,
            request.expected_revision,
            execution.active_episode_id.as_deref(),
            Some(&request.episode_id),
            &now,
        )?;
        prune_episode_lineage(&transaction, &request.key)?;
        commit_snapshot(transaction, &request.key, true)
    })
}

fn validate_candidate_identity(
    key: &ConversationExecutionKey,
    expected_revision: i64,
    episode_id: &str,
    runner_session_id: &str,
    native_session_id: &str,
    bootstrap_intent_id: &str,
) -> Result<(), String> {
    validate_key(key)?;
    validate_revision(expected_revision)?;
    validate_required("expectedCandidateEpisodeId", episode_id, MAX_ID_CHARS)?;
    validate_required("runnerSessionId", runner_session_id, MAX_ID_CHARS)?;
    validate_required("nativeSessionId", native_session_id, MAX_ID_CHARS)?;
    validate_required("bootstrapIntentId", bootstrap_intent_id, MAX_ID_CHARS)
}

fn ensure_candidate_identity(
    episode: &ConversationExecutionEpisode,
    runner_session_id: &str,
    native_session_id: &str,
    bootstrap_intent_id: &str,
) -> Result<(), String> {
    if episode.runner_session_id != runner_session_id
        || episode.native_session_id != native_session_id
        || episode.bootstrap_intent_id != bootstrap_intent_id
    {
        return Err("candidate runner/native/bootstrap identity conflict".to_string());
    }
    Ok(())
}

pub(crate) fn begin_materialization(
    request: ConversationExecutionBeginMaterializationRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    validate_candidate_identity(
        &request.key,
        request.expected_revision,
        &request.expected_candidate_episode_id,
        &request.runner_session_id,
        &request.native_session_id,
        &request.bootstrap_intent_id,
    )?;
    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| {
            format!("open sessions database for materialization start failed: {err}")
        })?;
        let transaction = begin_immediate(&conn)
            .map_err(|err| format!("begin materialization transaction failed: {err}"))?;
        let execution = load_execution(&transaction, &request.key)?.ok_or_else(|| {
            "cannot materialize a candidate for a missing conversation execution".to_string()
        })?;
        let episode = load_episode(
            &transaction,
            &request.key,
            &request.expected_candidate_episode_id,
        )?
        .ok_or_else(|| {
            format!(
                "candidate episode {} not found",
                request.expected_candidate_episode_id
            )
        })?;
        ensure_candidate_identity(
            &episode,
            &request.runner_session_id,
            &request.native_session_id,
            &request.bootstrap_intent_id,
        )?;
        if episode.state == ConversationExecutionEpisodeState::Materializing
            && execution.candidate_episode_id.as_deref()
                == Some(request.expected_candidate_episode_id.as_str())
        {
            return commit_snapshot(transaction, &request.key, false);
        }
        assert_revision(&execution, request.expected_revision)?;
        if episode.state != ConversationExecutionEpisodeState::Prepared
            || execution.candidate_episode_id.as_deref()
                != Some(request.expected_candidate_episode_id.as_str())
        {
            return Err("candidate materialization compare-and-swap conflict".to_string());
        }
        let now = now_iso();
        let changed = transaction
            .execute(
                "UPDATE conversation_execution_episodes
                 SET state = 'materializing', updated_at = ?4
                 WHERE executor_scope = ?1 AND conversation_root_key = ?2
                   AND episode_id = ?3 AND state = 'prepared'",
                params![
                    request.key.executor_scope,
                    request.key.conversation_root_key,
                    request.expected_candidate_episode_id,
                    now,
                ],
            )
            .map_err(|err| format!("start candidate materialization failed: {err}"))?;
        if changed != 1 {
            return Err("candidate changed during materialization start".to_string());
        }
        update_execution_cas(
            &transaction,
            &request.key,
            request.expected_revision,
            execution.active_episode_id.as_deref(),
            execution.candidate_episode_id.as_deref(),
            &now,
        )?;
        commit_snapshot(transaction, &request.key, true)
    })
}

pub(crate) fn activate_candidate(
    request: ConversationExecutionActivateCandidateRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    validate_candidate_identity(
        &request.key,
        request.expected_revision,
        &request.expected_candidate_episode_id,
        &request.runner_session_id,
        &request.native_session_id,
        &request.bootstrap_intent_id,
    )?;
    validate_optional(
        "expectedActiveEpisodeId",
        request.expected_active_episode_id.as_deref(),
        MAX_ID_CHARS,
    )?;
    validate_sha256(
        "verifiedMaterializationSha256",
        &request.verified_materialization_sha256,
    )?;
    validate_required(
        "activationReceiptId",
        &request.activation_receipt_id,
        MAX_ID_CHARS,
    )?;
    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| {
            format!("open sessions database for candidate activation failed: {err}")
        })?;
        let transaction = begin_immediate(&conn)
            .map_err(|err| format!("begin candidate activation transaction failed: {err}"))?;
        let execution = load_execution(&transaction, &request.key)?.ok_or_else(|| {
            "cannot activate a candidate for a missing conversation execution".to_string()
        })?;
        let episode = load_episode(
            &transaction,
            &request.key,
            &request.expected_candidate_episode_id,
        )?
        .ok_or_else(|| {
            format!(
                "candidate episode {} not found",
                request.expected_candidate_episode_id
            )
        })?;
        ensure_candidate_identity(
            &episode,
            &request.runner_session_id,
            &request.native_session_id,
            &request.bootstrap_intent_id,
        )?;
        if execution.active_episode_id.as_deref()
            == Some(request.expected_candidate_episode_id.as_str())
            && execution.candidate_episode_id.is_none()
            && episode.state == ConversationExecutionEpisodeState::Active
        {
            if episode.verified_materialization_sha256.as_deref()
                != Some(request.verified_materialization_sha256.as_str())
                || episode.activation_receipt_id.as_deref()
                    != Some(request.activation_receipt_id.as_str())
            {
                return Err("activated candidate verification receipt conflict".to_string());
            }
            return commit_snapshot(transaction, &request.key, false);
        }
        assert_revision(&execution, request.expected_revision)?;
        if execution.active_episode_id != request.expected_active_episode_id {
            return Err("active episode compare-and-swap conflict".to_string());
        }
        if execution.candidate_episode_id.as_deref()
            != Some(request.expected_candidate_episode_id.as_str())
            || episode.state != ConversationExecutionEpisodeState::Materializing
        {
            return Err(
                "activation requires the authoritative materializing candidate".to_string(),
            );
        }
        if episode.supersedes_episode_id != request.expected_active_episode_id {
            return Err("candidate supersedes identity conflict".to_string());
        }
        let now = now_iso();
        if let Some(active_episode_id) = request.expected_active_episode_id.as_deref() {
            let active = load_episode(&transaction, &request.key, active_episode_id)?
                .ok_or_else(|| format!("active episode {active_episode_id} not found"))?;
            if active.state != ConversationExecutionEpisodeState::Active {
                return Err(format!("episode {active_episode_id} is not active"));
            }
            let changed = transaction
                .execute(
                    "UPDATE conversation_execution_episodes
                     SET state = 'retired', roll_reason = ?4, updated_at = ?5
                     WHERE executor_scope = ?1 AND conversation_root_key = ?2
                       AND episode_id = ?3 AND state = 'active'",
                    params![
                        request.key.executor_scope,
                        request.key.conversation_root_key,
                        active_episode_id,
                        SUPERSEDED_ROLL_REASON,
                        now,
                    ],
                )
                .map_err(|err| format!("retire superseded episode failed: {err}"))?;
            if changed != 1 {
                return Err("active episode changed during activation".to_string());
            }
        }
        let changed = transaction
            .execute(
                "UPDATE conversation_execution_episodes
                 SET state = 'active',
                     verified_materialization_sha256 = ?4,
                     activation_receipt_id = ?5,
                     updated_at = ?6
                 WHERE executor_scope = ?1 AND conversation_root_key = ?2
                   AND episode_id = ?3 AND state = 'materializing'",
                params![
                    request.key.executor_scope,
                    request.key.conversation_root_key,
                    request.expected_candidate_episode_id,
                    request.verified_materialization_sha256,
                    request.activation_receipt_id,
                    now,
                ],
            )
            .map_err(|err| format!("activate conversation candidate failed: {err}"))?;
        if changed != 1 {
            return Err("candidate changed during activation".to_string());
        }
        update_execution_cas(
            &transaction,
            &request.key,
            request.expected_revision,
            Some(&request.expected_candidate_episode_id),
            None,
            &now,
        )?;
        prune_episode_lineage(&transaction, &request.key)?;
        commit_snapshot(transaction, &request.key, true)
    })
}

pub(crate) fn abort_candidate(
    request: ConversationExecutionAbortCandidateRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    validate_key(&request.key)?;
    validate_revision(request.expected_revision)?;
    validate_required(
        "expectedCandidateEpisodeId",
        &request.expected_candidate_episode_id,
        MAX_ID_CHARS,
    )?;
    validate_required("runnerSessionId", &request.runner_session_id, MAX_ID_CHARS)?;
    validate_roll_reason(&request.roll_reason)?;
    with_sessions_writer(|| {
        let conn = get_connection()
            .map_err(|err| format!("open sessions database for candidate abort failed: {err}"))?;
        let transaction = begin_immediate(&conn)
            .map_err(|err| format!("begin candidate abort transaction failed: {err}"))?;
        let execution = load_execution(&transaction, &request.key)?.ok_or_else(|| {
            "cannot abort a candidate for a missing conversation execution".to_string()
        })?;
        let episode = load_episode(
            &transaction,
            &request.key,
            &request.expected_candidate_episode_id,
        )?
        .ok_or_else(|| {
            format!(
                "candidate episode {} not found",
                request.expected_candidate_episode_id
            )
        })?;
        if episode.runner_session_id != request.runner_session_id {
            return Err("candidate runner identity conflict".to_string());
        }
        let final_state = request.final_state.episode_state();
        if execution.candidate_episode_id.is_none()
            && episode.state == final_state
            && episode.roll_reason.as_deref() == Some(request.roll_reason.as_str())
        {
            return commit_snapshot(transaction, &request.key, false);
        }
        assert_revision(&execution, request.expected_revision)?;
        if execution.candidate_episode_id.as_deref()
            != Some(request.expected_candidate_episode_id.as_str())
            || !episode.state.is_candidate()
        {
            return Err("candidate abort compare-and-swap conflict".to_string());
        }
        let now = now_iso();
        let changed = transaction
            .execute(
                "UPDATE conversation_execution_episodes
                 SET state = ?4, roll_reason = ?5, updated_at = ?6
                 WHERE executor_scope = ?1 AND conversation_root_key = ?2
                   AND episode_id = ?3
                   AND state IN ('prepared', 'materializing')",
                params![
                    request.key.executor_scope,
                    request.key.conversation_root_key,
                    request.expected_candidate_episode_id,
                    final_state.as_str(),
                    request.roll_reason,
                    now,
                ],
            )
            .map_err(|err| format!("abort conversation candidate failed: {err}"))?;
        if changed != 1 {
            return Err("candidate changed during abort".to_string());
        }
        update_execution_cas(
            &transaction,
            &request.key,
            request.expected_revision,
            execution.active_episode_id.as_deref(),
            None,
            &now,
        )?;
        prune_episode_lineage(&transaction, &request.key)?;
        commit_snapshot(transaction, &request.key, true)
    })
}

pub(crate) fn advance_checkpoint(
    request: ConversationExecutionAdvanceCheckpointRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    validate_key(&request.key)?;
    validate_revision(request.expected_revision)?;
    validate_required("episodeId", &request.episode_id, MAX_ID_CHARS)?;
    validate_required("runnerSessionId", &request.runner_session_id, MAX_ID_CHARS)?;
    validate_source_checkpoint(&request.source)?;
    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| {
            format!("open sessions database for checkpoint advance failed: {err}")
        })?;
        let transaction = begin_immediate(&conn)
            .map_err(|err| format!("begin checkpoint advance transaction failed: {err}"))?;
        let execution = load_execution(&transaction, &request.key)?
            .ok_or_else(|| "conversation execution not found for checkpoint advance".to_string())?;
        let episode = load_episode(&transaction, &request.key, &request.episode_id)?
            .ok_or_else(|| format!("episode {} not found", request.episode_id))?;
        if episode.runner_session_id != request.runner_session_id {
            return Err("checkpoint runner identity conflict".to_string());
        }
        if episode.source == request.source {
            return commit_snapshot(transaction, &request.key, false);
        }
        if request.source.source_event_count < episode.source.source_event_count {
            return Err("source checkpoint event count cannot move backwards".to_string());
        }
        if request.source.source_event_count == episode.source.source_event_count {
            return Err(
                "a source checkpoint cannot change identity at the same event count".to_string(),
            );
        }
        assert_revision(&execution, request.expected_revision)?;
        if episode.state != ConversationExecutionEpisodeState::Active
            || execution.active_episode_id.as_deref() != Some(request.episode_id.as_str())
        {
            return Err("only the authoritative active episode can advance".to_string());
        }
        let now = now_iso();
        let changed = transaction
            .execute(
                "UPDATE conversation_execution_episodes
                 SET source_checkpoint_id = ?4,
                     source_checkpoint_sha256 = ?5,
                     source_event_count = ?6,
                     source_tip_event_id = ?7,
                     updated_at = ?8
                 WHERE executor_scope = ?1 AND conversation_root_key = ?2
                   AND episode_id = ?3 AND state = 'active'",
                params![
                    request.key.executor_scope,
                    request.key.conversation_root_key,
                    request.episode_id,
                    request.source.source_checkpoint_id,
                    request.source.source_checkpoint_sha256,
                    request.source.source_event_count,
                    request.source.source_tip_event_id,
                    now,
                ],
            )
            .map_err(|err| format!("advance conversation checkpoint failed: {err}"))?;
        if changed != 1 {
            return Err("episode changed during checkpoint advance".to_string());
        }
        update_execution_cas(
            &transaction,
            &request.key,
            request.expected_revision,
            execution.active_episode_id.as_deref(),
            execution.candidate_episode_id.as_deref(),
            &now,
        )?;
        commit_snapshot(transaction, &request.key, true)
    })
}

pub(crate) fn retire_active(
    request: ConversationExecutionRetireActiveRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    validate_key(&request.key)?;
    validate_revision(request.expected_revision)?;
    validate_required(
        "expectedActiveEpisodeId",
        &request.expected_active_episode_id,
        MAX_ID_CHARS,
    )?;
    validate_required("runnerSessionId", &request.runner_session_id, MAX_ID_CHARS)?;
    validate_roll_reason(&request.roll_reason)?;
    with_sessions_writer(|| {
        let conn = get_connection()
            .map_err(|err| format!("open sessions database for active retirement failed: {err}"))?;
        let transaction = begin_immediate(&conn)
            .map_err(|err| format!("begin active retirement transaction failed: {err}"))?;
        let execution = load_execution(&transaction, &request.key)?
            .ok_or_else(|| "conversation execution not found for retirement".to_string())?;
        let episode = load_episode(
            &transaction,
            &request.key,
            &request.expected_active_episode_id,
        )?
        .ok_or_else(|| {
            format!(
                "active episode {} not found",
                request.expected_active_episode_id
            )
        })?;
        if episode.runner_session_id != request.runner_session_id {
            return Err("active runner identity conflict".to_string());
        }
        let final_state = request.final_state.episode_state();
        if execution.active_episode_id.is_none()
            && episode.state == final_state
            && episode.roll_reason.as_deref() == Some(request.roll_reason.as_str())
        {
            return commit_snapshot(transaction, &request.key, false);
        }
        if execution.candidate_episode_id.is_some() {
            return Err(
                "cannot retire active episode while a candidate exists; abort it first".to_string(),
            );
        }
        assert_revision(&execution, request.expected_revision)?;
        if execution.active_episode_id.as_deref()
            != Some(request.expected_active_episode_id.as_str())
            || episode.state != ConversationExecutionEpisodeState::Active
        {
            return Err("active retirement compare-and-swap conflict".to_string());
        }
        let now = now_iso();
        let changed = transaction
            .execute(
                "UPDATE conversation_execution_episodes
                 SET state = ?4, roll_reason = ?5, updated_at = ?6
                 WHERE executor_scope = ?1 AND conversation_root_key = ?2
                   AND episode_id = ?3 AND state = 'active'",
                params![
                    request.key.executor_scope,
                    request.key.conversation_root_key,
                    request.expected_active_episode_id,
                    final_state.as_str(),
                    request.roll_reason,
                    now,
                ],
            )
            .map_err(|err| format!("retire active conversation episode failed: {err}"))?;
        if changed != 1 {
            return Err("active episode changed during retirement".to_string());
        }
        update_execution_cas(
            &transaction,
            &request.key,
            request.expected_revision,
            None,
            None,
            &now,
        )?;
        prune_episode_lineage(&transaction, &request.key)?;
        commit_snapshot(transaction, &request.key, true)
    })
}

pub(crate) fn load_snapshot(
    key: &ConversationExecutionKey,
) -> Result<Option<ConversationExecutionSnapshot>, String> {
    validate_key(key)?;
    let mut conn = get_connection()
        .map_err(|err| format!("open sessions database for execution load failed: {err}"))?;
    let transaction = conn
        .transaction()
        .map_err(|err| format!("begin conversation execution read transaction failed: {err}"))?;
    let snapshot = get_execution_snapshot(&transaction, key)?;
    transaction
        .commit()
        .map_err(|err| format!("commit conversation execution read failed: {err}"))?;
    Ok(snapshot)
}

pub(super) fn registration_matches(
    registration: &ConversationRunnerRegistration,
    key: &ConversationExecutionKey,
    episode_id: &str,
    runner_session_id: &str,
) -> bool {
    registration.runner_session_id == runner_session_id
        && registration.executor_scope == key.executor_scope
        && registration.conversation_root_key == key.conversation_root_key
        && registration.episode_id == episode_id
}
