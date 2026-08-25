use std::collections::HashSet;

use chrono::{DateTime, SecondsFormat, Utc};
use database::db::{begin_immediate, get_connection, with_sessions_writer};
use rusqlite::params;

use super::super::types::{
    ConversationExecutionImportLegacyRunnersRequest, ConversationExecutionKey,
    ConversationExecutionMutationResult, ConversationRunnerCleanupCandidatesRequest,
    ConversationRunnerIdentityRequest, ConversationRunnerMutationResult, ConversationRunnerPage,
    ConversationRunnerPageRequest, ConversationRunnerRegistration, MAX_LEGACY_RUNNER_IMPORTS,
    MAX_RUNNER_CLEANUP_CANDIDATES, MAX_RUNNER_PAGE_SIZE,
};
use super::mutations::{commit_snapshot, registration_matches};
use super::read::{load_episode, load_execution, load_registration, registration_from_row};
use super::{now_iso, validate_key, validate_optional, validate_required, MAX_ID_CHARS};

fn identity_key(request: &ConversationRunnerIdentityRequest) -> ConversationExecutionKey {
    ConversationExecutionKey {
        executor_scope: request.executor_scope.clone(),
        conversation_root_key: request.conversation_root_key.clone(),
    }
}

fn validate_identity(request: &ConversationRunnerIdentityRequest) -> Result<(), String> {
    validate_required("runnerSessionId", &request.runner_session_id, MAX_ID_CHARS)?;
    validate_key(&identity_key(request))?;
    validate_required("episodeId", &request.episode_id, MAX_ID_CHARS)
}

pub(crate) fn mark_runner_terminal(
    request: ConversationRunnerIdentityRequest,
) -> Result<ConversationRunnerMutationResult, String> {
    validate_identity(&request)?;
    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| {
            format!("open sessions database for runner terminal mark failed: {err}")
        })?;
        let transaction = begin_immediate(&conn)
            .map_err(|err| format!("begin runner terminal transaction failed: {err}"))?;
        let registration = load_registration(&transaction, &request.runner_session_id)?
            .ok_or_else(|| {
                format!(
                    "conversation runner {} is not registered",
                    request.runner_session_id
                )
            })?;
        let key = identity_key(&request);
        if !registration_matches(
            &registration,
            &key,
            &request.episode_id,
            &request.runner_session_id,
        ) {
            return Err("conversation runner registration identity conflict".to_string());
        }
        let execution = load_execution(&transaction, &key)?
            .ok_or_else(|| "cannot mark a runner terminal for a missing execution".to_string())?;
        if execution.active_episode_id.as_deref() == Some(request.episode_id.as_str())
            || execution.candidate_episode_id.as_deref() == Some(request.episode_id.as_str())
        {
            return Err(
                "retire or abort the episode before marking its runner terminal".to_string(),
            );
        }
        if let Some(episode) = load_episode(&transaction, &key, &request.episode_id)? {
            if !episode.state.is_final() {
                return Err(
                    "retire or abort the non-final episode before terminal cleanup".to_string(),
                );
            }
        }
        if registration.terminal {
            transaction
                .commit()
                .map_err(|err| format!("commit runner terminal no-op failed: {err}"))?;
            return Ok(ConversationRunnerMutationResult {
                applied: false,
                registration: Some(registration),
            });
        }
        let now = now_iso();
        let changed = transaction
            .execute(
                "UPDATE conversation_runner_registry
                 SET terminal = 1, terminal_at = ?2, updated_at = ?2
                 WHERE runner_session_id = ?1 AND terminal = 0",
                params![request.runner_session_id, now],
            )
            .map_err(|err| format!("mark conversation runner terminal failed: {err}"))?;
        if changed != 1 {
            return Err("conversation runner changed during terminal mark".to_string());
        }
        let captured = load_registration(&transaction, &request.runner_session_id)?
            .ok_or_else(|| "runner disappeared during terminal mark".to_string())?;
        transaction
            .commit()
            .map_err(|err| format!("commit runner terminal mark failed: {err}"))?;
        Ok(ConversationRunnerMutationResult {
            applied: true,
            registration: Some(captured),
        })
    })
}

pub(crate) fn forget_runner(
    request: ConversationRunnerIdentityRequest,
) -> Result<ConversationRunnerMutationResult, String> {
    validate_identity(&request)?;
    with_sessions_writer(|| {
        let conn = get_connection()
            .map_err(|err| format!("open sessions database for runner forget failed: {err}"))?;
        let transaction = begin_immediate(&conn)
            .map_err(|err| format!("begin runner forget transaction failed: {err}"))?;
        let Some(registration) = load_registration(&transaction, &request.runner_session_id)?
        else {
            transaction
                .commit()
                .map_err(|err| format!("commit runner forget no-op failed: {err}"))?;
            return Ok(ConversationRunnerMutationResult {
                applied: false,
                registration: None,
            });
        };
        let key = identity_key(&request);
        if !registration_matches(
            &registration,
            &key,
            &request.episode_id,
            &request.runner_session_id,
        ) {
            return Err("conversation runner registration identity conflict".to_string());
        }
        if !registration.terminal {
            return Err("only a terminal conversation runner can be forgotten".to_string());
        }
        if let Some(execution) = load_execution(&transaction, &key)? {
            if execution.active_episode_id.as_deref() == Some(request.episode_id.as_str())
                || execution.candidate_episode_id.as_deref() == Some(request.episode_id.as_str())
            {
                return Err("cannot forget an active or candidate runner".to_string());
            }
        }
        if let Some(episode) = load_episode(&transaction, &key, &request.episode_id)? {
            if !episode.state.is_final() {
                return Err("cannot forget a non-final conversation runner".to_string());
            }
        }
        let changed = transaction
            .execute(
                "DELETE FROM conversation_runner_registry
                 WHERE runner_session_id = ?1 AND executor_scope = ?2
                   AND conversation_root_key = ?3 AND episode_id = ?4
                   AND terminal = 1",
                params![
                    request.runner_session_id,
                    request.executor_scope,
                    request.conversation_root_key,
                    request.episode_id,
                ],
            )
            .map_err(|err| format!("forget conversation runner failed: {err}"))?;
        if changed != 1 {
            return Err("conversation runner changed during forget".to_string());
        }
        transaction
            .commit()
            .map_err(|err| format!("commit runner forget failed: {err}"))?;
        Ok(ConversationRunnerMutationResult {
            applied: true,
            registration: None,
        })
    })
}

pub(crate) fn list_runner_ids(
    request: ConversationRunnerPageRequest,
) -> Result<ConversationRunnerPage, String> {
    if !(1..=MAX_RUNNER_PAGE_SIZE).contains(&request.limit) {
        return Err(format!(
            "limit must be between 1 and {MAX_RUNNER_PAGE_SIZE}"
        ));
    }
    validate_optional(
        "afterRunnerSessionId",
        request.after_runner_session_id.as_deref(),
        MAX_ID_CHARS,
    )?;
    let conn = get_connection()
        .map_err(|err| format!("open sessions database for runner list failed: {err}"))?;
    let mut runner_session_ids =
        if let Some(after_runner_session_id) = request.after_runner_session_id.as_deref() {
            let mut statement = conn
                .prepare(
                    "SELECT runner_session_id
                     FROM conversation_runner_registry
                     WHERE runner_session_id > ?1
                     ORDER BY runner_session_id ASC
                     LIMIT ?2",
                )
                .map_err(|err| format!("prepare continued runner page failed: {err}"))?;
            let rows = statement
                .query_map(params![after_runner_session_id, request.limit + 1], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|err| format!("query continued runner page failed: {err}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| format!("read continued runner page failed: {err}"))?;
            rows
        } else {
            let mut statement = conn
                .prepare(
                    "SELECT runner_session_id
                     FROM conversation_runner_registry
                     ORDER BY runner_session_id ASC
                     LIMIT ?1",
                )
                .map_err(|err| format!("prepare first runner page failed: {err}"))?;
            let rows = statement
                .query_map(params![request.limit + 1], |row| row.get::<_, String>(0))
                .map_err(|err| format!("query first runner page failed: {err}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| format!("read first runner page failed: {err}"))?;
            rows
        };
    let has_more = runner_session_ids.len() > request.limit as usize;
    runner_session_ids.truncate(request.limit as usize);
    let next_cursor = has_more
        .then(|| runner_session_ids.last().cloned())
        .flatten();
    Ok(ConversationRunnerPage {
        runner_session_ids,
        next_cursor,
    })
}

pub(crate) fn list_cleanup_candidates(
    request: ConversationRunnerCleanupCandidatesRequest,
) -> Result<Vec<ConversationRunnerRegistration>, String> {
    if !(1..=MAX_RUNNER_CLEANUP_CANDIDATES).contains(&request.limit) {
        return Err(format!(
            "limit must be between 1 and {MAX_RUNNER_CLEANUP_CANDIDATES}"
        ));
    }
    let terminal_before = DateTime::parse_from_rfc3339(&request.terminal_before)
        .map_err(|err| format!("terminalBefore must be RFC3339: {err}"))?
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let conn = get_connection()
        .map_err(|err| format!("open sessions database for cleanup list failed: {err}"))?;
    let mut statement = conn
        .prepare(
            "SELECT r.runner_session_id, r.executor_scope,
                    r.conversation_root_key, r.episode_id, r.terminal,
                    r.registered_at, r.terminal_at, r.updated_at
             FROM conversation_runner_registry r
             WHERE r.terminal = 1 AND r.terminal_at <= ?1
               AND NOT EXISTS (
                   SELECT 1 FROM conversation_executions e
                   WHERE e.executor_scope = r.executor_scope
                     AND e.conversation_root_key = r.conversation_root_key
                     AND (
                         e.active_episode_id = r.episode_id
                         OR e.candidate_episode_id = r.episode_id
                     )
               )
             ORDER BY r.terminal_at ASC, r.runner_session_id ASC
             LIMIT ?2",
        )
        .map_err(|err| format!("prepare conversation cleanup list failed: {err}"))?;
    let candidates = statement
        .query_map(
            params![terminal_before, request.limit],
            registration_from_row,
        )
        .map_err(|err| format!("query conversation cleanup candidates failed: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("read conversation cleanup candidates failed: {err}"))?;
    Ok(candidates)
}

pub(crate) fn import_legacy_runners(
    request: ConversationExecutionImportLegacyRunnersRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    validate_key(&request.key)?;
    if request.runners.is_empty() {
        return Err("legacy import requires at least one exact runner registration".to_string());
    }
    if request.runners.len() > MAX_LEGACY_RUNNER_IMPORTS {
        return Err(format!(
            "legacy import accepts at most {MAX_LEGACY_RUNNER_IMPORTS} runner registrations"
        ));
    }
    let mut seen_runner_ids = HashSet::new();
    for runner in &request.runners {
        validate_required("runnerSessionId", &runner.runner_session_id, MAX_ID_CHARS)?;
        validate_required("episodeId", &runner.episode_id, MAX_ID_CHARS)?;
        if !seen_runner_ids.insert(runner.runner_session_id.as_str()) {
            return Err(format!(
                "duplicate legacy runner session id: {}",
                runner.runner_session_id
            ));
        }
    }

    with_sessions_writer(|| {
        let conn = get_connection()
            .map_err(|err| format!("open sessions database for legacy import failed: {err}"))?;
        let transaction = begin_immediate(&conn)
            .map_err(|err| format!("begin legacy runner import transaction failed: {err}"))?;
        let now = now_iso();
        if load_execution(&transaction, &request.key)?.is_none() {
            transaction
                .execute(
                    "INSERT INTO conversation_executions (
                        executor_scope, conversation_root_key,
                        active_episode_id, candidate_episode_id,
                        revision, updated_at
                     ) VALUES (?1, ?2, NULL, NULL, 0, ?3)",
                    params![
                        request.key.executor_scope,
                        request.key.conversation_root_key,
                        now,
                    ],
                )
                .map_err(|err| format!("create legacy registry execution failed: {err}"))?;
        }

        let mut applied = false;
        for runner in &request.runners {
            if let Some(existing) = load_registration(&transaction, &runner.runner_session_id)? {
                if !registration_matches(
                    &existing,
                    &request.key,
                    &runner.episode_id,
                    &runner.runner_session_id,
                ) {
                    return Err(format!(
                        "legacy runner {} conflicts with an existing registration",
                        runner.runner_session_id
                    ));
                }
                if existing.terminal && !runner.terminal {
                    return Err(format!(
                        "legacy runner {} cannot be revived from terminal state",
                        runner.runner_session_id
                    ));
                }
                if !existing.terminal && runner.terminal {
                    transaction
                        .execute(
                            "UPDATE conversation_runner_registry
                             SET terminal = 1, terminal_at = ?2, updated_at = ?2
                             WHERE runner_session_id = ?1 AND terminal = 0",
                            params![runner.runner_session_id, now],
                        )
                        .map_err(|err| {
                            format!("upgrade legacy runner terminal state failed: {err}")
                        })?;
                    applied = true;
                }
                continue;
            }
            transaction
                .execute(
                    "INSERT INTO conversation_runner_registry (
                        runner_session_id, executor_scope,
                        conversation_root_key, episode_id, terminal,
                        registered_at, terminal_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6)",
                    params![
                        runner.runner_session_id,
                        request.key.executor_scope,
                        request.key.conversation_root_key,
                        runner.episode_id,
                        i64::from(runner.terminal),
                        now,
                        runner.terminal.then_some(now.as_str()),
                    ],
                )
                .map_err(|err| format!("insert legacy runner registration failed: {err}"))?;
            applied = true;
        }
        commit_snapshot(transaction, &request.key, applied)
    })
}
