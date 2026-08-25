use rusqlite::{params, Connection, OptionalExtension, Row};

use super::super::types::{
    ConversationExecutionEpisode, ConversationExecutionEpisodeState, ConversationExecutionKey,
    ConversationExecutionRecord, ConversationExecutionSnapshot, ConversationRunnerRegistration,
    ConversationRuntimeProfile, ConversationSourceCheckpoint,
};

pub(super) fn load_execution(
    conn: &Connection,
    key: &ConversationExecutionKey,
) -> Result<Option<ConversationExecutionRecord>, String> {
    conn.query_row(
        "SELECT executor_scope, conversation_root_key, active_episode_id,
                candidate_episode_id, revision, updated_at
         FROM conversation_executions
         WHERE executor_scope = ?1 AND conversation_root_key = ?2",
        params![key.executor_scope, key.conversation_root_key],
        |row| {
            Ok(ConversationExecutionRecord {
                executor_scope: row.get(0)?,
                conversation_root_key: row.get(1)?,
                active_episode_id: row.get(2)?,
                candidate_episode_id: row.get(3)?,
                revision: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|err| format!("load conversation execution failed: {err}"))
}

const EPISODE_COLUMNS: &str =
    "executor_scope, conversation_root_key, episode_id, runner_session_id,
     native_session_id, state,
     source_checkpoint_id, source_checkpoint_sha256, source_event_count,
     source_tip_event_id, runtime_category, runtime_id, agent_id, account_id,
     model_id, workspace_locator, workspace_fingerprint,
     execution_profile_fingerprint, bootstrap_intent_id,
     verified_materialization_sha256, activation_receipt_id,
     supersedes_episode_id, roll_reason, created_at, updated_at";

fn episode_from_row(row: &Row<'_>) -> rusqlite::Result<ConversationExecutionEpisode> {
    let stored_state: String = row.get(5)?;
    let state = ConversationExecutionEpisodeState::from_db(&stored_state).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, err.into())
    })?;
    Ok(ConversationExecutionEpisode {
        executor_scope: row.get(0)?,
        conversation_root_key: row.get(1)?,
        episode_id: row.get(2)?,
        runner_session_id: row.get(3)?,
        native_session_id: row.get(4)?,
        state,
        source: ConversationSourceCheckpoint {
            source_checkpoint_id: row.get(6)?,
            source_checkpoint_sha256: row.get(7)?,
            source_event_count: row.get(8)?,
            source_tip_event_id: row.get(9)?,
        },
        runtime: ConversationRuntimeProfile {
            runtime_category: row.get(10)?,
            runtime_id: row.get(11)?,
            agent_id: row.get(12)?,
            account_id: row.get(13)?,
            model_id: row.get(14)?,
            workspace_locator: row.get(15)?,
            workspace_fingerprint: row.get(16)?,
            execution_profile_fingerprint: row.get(17)?,
        },
        bootstrap_intent_id: row.get(18)?,
        verified_materialization_sha256: row.get(19)?,
        activation_receipt_id: row.get(20)?,
        supersedes_episode_id: row.get(21)?,
        roll_reason: row.get(22)?,
        created_at: row.get(23)?,
        updated_at: row.get(24)?,
    })
}

pub(super) fn load_episode(
    conn: &Connection,
    key: &ConversationExecutionKey,
    episode_id: &str,
) -> Result<Option<ConversationExecutionEpisode>, String> {
    conn.query_row(
        &format!(
            "SELECT {EPISODE_COLUMNS}
             FROM conversation_execution_episodes
             WHERE executor_scope = ?1 AND conversation_root_key = ?2
               AND episode_id = ?3"
        ),
        params![key.executor_scope, key.conversation_root_key, episode_id],
        episode_from_row,
    )
    .optional()
    .map_err(|err| format!("load conversation execution episode failed: {err}"))
}

fn load_episodes(
    conn: &Connection,
    key: &ConversationExecutionKey,
) -> Result<Vec<ConversationExecutionEpisode>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {EPISODE_COLUMNS}
             FROM conversation_execution_episodes
             WHERE executor_scope = ?1 AND conversation_root_key = ?2
             ORDER BY created_at ASC, episode_id ASC"
        ))
        .map_err(|err| format!("prepare conversation episode load failed: {err}"))?;
    let episodes = statement
        .query_map(
            params![key.executor_scope, key.conversation_root_key],
            episode_from_row,
        )
        .map_err(|err| format!("query conversation episodes failed: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("read conversation episodes failed: {err}"))?;
    Ok(episodes)
}

pub(super) fn registration_from_row(
    row: &Row<'_>,
) -> rusqlite::Result<ConversationRunnerRegistration> {
    Ok(ConversationRunnerRegistration {
        runner_session_id: row.get(0)?,
        executor_scope: row.get(1)?,
        conversation_root_key: row.get(2)?,
        episode_id: row.get(3)?,
        terminal: row.get::<_, i64>(4)? != 0,
        registered_at: row.get(5)?,
        terminal_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub(super) fn load_registration(
    conn: &Connection,
    runner_session_id: &str,
) -> Result<Option<ConversationRunnerRegistration>, String> {
    conn.query_row(
        "SELECT runner_session_id, executor_scope, conversation_root_key,
                episode_id, terminal, registered_at, terminal_at, updated_at
         FROM conversation_runner_registry
         WHERE runner_session_id = ?1",
        [runner_session_id],
        registration_from_row,
    )
    .optional()
    .map_err(|err| format!("load conversation runner registration failed: {err}"))
}

fn validate_snapshot_integrity(
    conn: &Connection,
    key: &ConversationExecutionKey,
    snapshot: &ConversationExecutionSnapshot,
) -> Result<(), String> {
    if snapshot.execution.executor_scope != key.executor_scope
        || snapshot.execution.conversation_root_key != key.conversation_root_key
    {
        return Err("conversation execution snapshot key identity conflict".to_string());
    }

    let active = snapshot
        .execution
        .active_episode_id
        .as_deref()
        .map(|episode_id| {
            snapshot
                .episodes
                .iter()
                .find(|episode| episode.episode_id == episode_id)
                .ok_or_else(|| format!("active episode pointer {episode_id} is dangling"))
        })
        .transpose()?;
    if active.is_some_and(|episode| episode.state != ConversationExecutionEpisodeState::Active) {
        return Err("active episode pointer does not reference an active episode".to_string());
    }

    let candidate = snapshot
        .execution
        .candidate_episode_id
        .as_deref()
        .map(|episode_id| {
            snapshot
                .episodes
                .iter()
                .find(|episode| episode.episode_id == episode_id)
                .ok_or_else(|| format!("candidate episode pointer {episode_id} is dangling"))
        })
        .transpose()?;
    if candidate.is_some_and(|episode| !episode.state.is_candidate()) {
        return Err(
            "candidate pointer does not reference a prepared/materializing episode".to_string(),
        );
    }
    if candidate.is_some_and(|episode| {
        episode.supersedes_episode_id.as_deref() != snapshot.execution.active_episode_id.as_deref()
    }) {
        return Err("candidate predecessor does not match the active pointer".to_string());
    }

    for episode in &snapshot.episodes {
        if episode.executor_scope != key.executor_scope
            || episode.conversation_root_key != key.conversation_root_key
        {
            return Err(format!(
                "episode {} has a conflicting execution key",
                episode.episode_id
            ));
        }
        let pointer_is_live = match episode.state {
            ConversationExecutionEpisodeState::Active => {
                snapshot.execution.active_episode_id.as_deref() == Some(episode.episode_id.as_str())
            }
            ConversationExecutionEpisodeState::Prepared
            | ConversationExecutionEpisodeState::Materializing => {
                snapshot.execution.candidate_episode_id.as_deref()
                    == Some(episode.episode_id.as_str())
            }
            ConversationExecutionEpisodeState::Retired
            | ConversationExecutionEpisodeState::Failed => false,
        };
        if !episode.state.is_final() && !pointer_is_live {
            return Err(format!(
                "live episode {} is detached from its authoritative pointer",
                episode.episode_id
            ));
        }

        let registration = load_registration(conn, &episode.runner_session_id)?;
        if pointer_is_live {
            let registration = registration.ok_or_else(|| {
                format!(
                    "live episode {} has no runner registration",
                    episode.episode_id
                )
            })?;
            if registration.terminal
                || registration.executor_scope != key.executor_scope
                || registration.conversation_root_key != key.conversation_root_key
                || registration.episode_id != episode.episode_id
            {
                return Err(format!(
                    "live episode {} has a conflicting runner registration",
                    episode.episode_id
                ));
            }
        } else if registration.as_ref().is_some_and(|registration| {
            registration.executor_scope != key.executor_scope
                || registration.conversation_root_key != key.conversation_root_key
                || registration.episode_id != episode.episode_id
        }) {
            return Err(format!(
                "final episode {} has a conflicting runner registration",
                episode.episode_id
            ));
        }
    }
    Ok(())
}

pub(crate) fn get_execution_snapshot(
    conn: &Connection,
    key: &ConversationExecutionKey,
) -> Result<Option<ConversationExecutionSnapshot>, String> {
    let Some(execution) = load_execution(conn, key)? else {
        return Ok(None);
    };
    let snapshot = ConversationExecutionSnapshot {
        execution,
        episodes: load_episodes(conn, key)?,
    };
    validate_snapshot_integrity(conn, key, &snapshot)?;
    Ok(Some(snapshot))
}

pub(super) fn require_snapshot(
    conn: &Connection,
    key: &ConversationExecutionKey,
) -> Result<ConversationExecutionSnapshot, String> {
    get_execution_snapshot(conn, key)?.ok_or_else(|| {
        format!(
            "conversation execution not found for root {}",
            key.conversation_root_key
        )
    })
}
