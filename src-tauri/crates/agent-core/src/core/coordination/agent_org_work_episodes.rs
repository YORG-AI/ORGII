//! Stable formal-work identity for a long-lived Agent Org Team.
//!
//! `activation_generation` is an authorization fence and may advance across
//! Pause/Resume. A work episode instead spans the complete Task graph from
//! the first Task through one durable completion certificate. Task rows keep
//! their creation generation for audit; this table owns the stable grouping.

use rusqlite::{params, Connection, OptionalExtension};

pub(crate) const UNRESOLVED_EPISODE_NEW_MISSION_ERROR: &str =
    "agent_org_work_episode_unresolved_new_user_mission";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentOrgWorkEpisode {
    pub id: String,
    pub sequence: i64,
    pub opening_activation_generation: i64,
    pub closing_activation_generation: Option<i64>,
    pub certificate_id: Option<String>,
    pub opened_by_turn_intent_id: String,
}

pub(crate) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_work_episodes (
            id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            episode_sequence INTEGER NOT NULL CHECK(episode_sequence >= 1),
            status TEXT NOT NULL CHECK(status IN ('active','certified')),
            opening_activation_generation INTEGER NOT NULL
                CHECK(opening_activation_generation >= 1),
            closing_activation_generation INTEGER
                CHECK(closing_activation_generation IS NULL OR closing_activation_generation >= 1),
            opening_work_revision INTEGER NOT NULL CHECK(opening_work_revision >= 0),
            closing_work_revision INTEGER CHECK(closing_work_revision IS NULL OR closing_work_revision >= 0),
            outcome TEXT CHECK(outcome IN ('delivered','cancelled','failed')),
            certificate_id TEXT UNIQUE,
            opened_by_turn_intent_id TEXT NOT NULL CHECK(trim(opened_by_turn_intent_id) <> ''),
            created_at TEXT NOT NULL,
            closed_at TEXT,
            UNIQUE(org_run_id, episode_sequence),
            FOREIGN KEY (org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
            CHECK(
                (status='active' AND closing_activation_generation IS NULL
                    AND closing_work_revision IS NULL AND outcome IS NULL
                    AND certificate_id IS NULL AND closed_at IS NULL)
                OR
                (status='certified' AND closing_activation_generation IS NOT NULL
                    AND closing_work_revision IS NOT NULL AND outcome IS NOT NULL
                    AND certificate_id IS NOT NULL AND closed_at IS NOT NULL)
            )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_runtime_work_episodes_active
            ON agent_org_runtime_work_episodes(org_run_id) WHERE status='active';
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_work_episodes_current
            ON agent_org_runtime_work_episodes(org_run_id, episode_sequence DESC);
        CREATE TABLE IF NOT EXISTS agent_org_runtime_work_episode_tasks (
            org_run_id TEXT NOT NULL,
            work_episode_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            associated_at TEXT NOT NULL,
            PRIMARY KEY (org_run_id, task_id),
            FOREIGN KEY (work_episode_id)
                REFERENCES agent_org_runtime_work_episodes(id) ON DELETE CASCADE,
            FOREIGN KEY (org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (org_run_id, task_id)
                REFERENCES agent_org_runtime_tasks(org_run_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_work_episode_tasks_episode
            ON agent_org_runtime_work_episode_tasks(org_run_id, work_episode_id, task_id);",
    )
}

fn decode_episode(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentOrgWorkEpisode> {
    Ok(AgentOrgWorkEpisode {
        id: row.get(0)?,
        sequence: row.get(1)?,
        opening_activation_generation: row.get(2)?,
        closing_activation_generation: row.get(3)?,
        certificate_id: row.get(4)?,
        opened_by_turn_intent_id: row.get(5)?,
    })
}

pub(crate) fn active_with_connection(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Option<AgentOrgWorkEpisode>, String> {
    conn.query_row(
        "SELECT id,episode_sequence,opening_activation_generation,
                closing_activation_generation,certificate_id,opened_by_turn_intent_id
         FROM agent_org_runtime_work_episodes
         WHERE org_run_id=?1 AND status='active'",
        [org_run_id],
        decode_episode,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn current_with_connection(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Option<AgentOrgWorkEpisode>, String> {
    conn.query_row(
        "SELECT id,episode_sequence,opening_activation_generation,
                closing_activation_generation,certificate_id,opened_by_turn_intent_id
         FROM agent_org_runtime_work_episodes
         WHERE org_run_id=?1
         ORDER BY episode_sequence DESC LIMIT 1",
        [org_run_id],
        decode_episode,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn ensure_active_in_tx(
    conn: &Connection,
    org_run_id: &str,
    activation_generation: i64,
    opened_by_turn_intent_id: &str,
) -> Result<AgentOrgWorkEpisode, String> {
    if let Some(active) = active_with_connection(conn, org_run_id)? {
        if active.opened_by_turn_intent_id != opened_by_turn_intent_id
            && is_new_user_root_turn(conn, org_run_id, opened_by_turn_intent_id)?
        {
            return Err(format!(
                "{UNRESOLVED_EPISODE_NEW_MISSION_ERROR}:{}",
                active.id
            ));
        }
        return Ok(active);
    }
    let latest = current_with_connection(conn, org_run_id)?;
    if latest.as_ref().is_some_and(|episode| {
        episode
            .closing_activation_generation
            .is_some_and(|closing| closing >= activation_generation)
    }) {
        return Err("agent_org_task_mutation_after_completion_certificate".to_string());
    }
    let sequence = latest
        .as_ref()
        .map(|episode| {
            episode
                .sequence
                .checked_add(1)
                .ok_or_else(|| "agent_org_work_episode_sequence_exhausted".to_string())
        })
        .transpose()?
        .unwrap_or(1);
    if sequence < 1 || opened_by_turn_intent_id.trim().is_empty() {
        return Err("agent_org_work_episode_identity_invalid".to_string());
    }
    conn.execute(
        "INSERT INTO agent_org_runtime_run_progress(org_run_id,updated_at)
         VALUES (?1,?2) ON CONFLICT(org_run_id) DO NOTHING",
        params![org_run_id, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|error| error.to_string())?;
    let work_revision: i64 = conn
        .query_row(
            "SELECT work_revision FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
            [org_run_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("agent_org_work_episode_progress_missing:{error}"))?;
    let id = format!("work-episode-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_work_episodes (
            id,org_run_id,episode_sequence,status,opening_activation_generation,
            opening_work_revision,opened_by_turn_intent_id,created_at
         ) VALUES (?1,?2,?3,'active',?4,?5,?6,?7)",
        params![
            &id,
            org_run_id,
            sequence,
            activation_generation,
            work_revision,
            opened_by_turn_intent_id,
            &now,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(AgentOrgWorkEpisode {
        id,
        sequence,
        opening_activation_generation: activation_generation,
        closing_activation_generation: None,
        certificate_id: None,
        opened_by_turn_intent_id: opened_by_turn_intent_id.to_string(),
    })
}

fn is_new_user_root_turn(
    conn: &Connection,
    org_run_id: &str,
    turn_intent_id: &str,
) -> Result<bool, String> {
    // The compatibility Task-store constructors synthesize this identity and
    // never admit a real user Turn. Besides documenting that boundary here,
    // the fast path keeps isolated Task-store tests independent from the
    // session lifecycle schema they intentionally do not exercise.
    if turn_intent_id.starts_with("legacy-create:") {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM session_turn_intents intent
             JOIN agent_org_runtime_turn_contexts context
               ON context.session_id=intent.session_id
              AND context.turn_intent_id=intent.turn_intent_id
             JOIN agent_org_runtime_runs run ON run.id=context.org_run_id
             WHERE context.org_run_id=?1 AND context.turn_intent_id=?2
               AND context.turn_kind='coordinator'
               AND intent.session_id=run.root_session_id
               AND intent.source IN (
                   'user_submit','queue','force_send','wingman','mobile_remote'
               )
         )",
        params![org_run_id, turn_intent_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn associate_task_in_tx(
    conn: &Connection,
    org_run_id: &str,
    task_id: &str,
    activation_generation: i64,
    opened_by_turn_intent_id: &str,
) -> Result<String, String> {
    let episode = ensure_active_in_tx(
        conn,
        org_run_id,
        activation_generation,
        opened_by_turn_intent_id,
    )?;
    conn.execute(
        "INSERT INTO agent_org_runtime_work_episode_tasks (
            org_run_id,work_episode_id,task_id,associated_at
         ) VALUES (?1,?2,?3,?4)",
        params![
            org_run_id,
            &episode.id,
            task_id,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(episode.id)
}

pub(crate) fn task_ids_with_connection(
    conn: &Connection,
    org_run_id: &str,
    work_episode_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT task_id FROM agent_org_runtime_work_episode_tasks
             WHERE org_run_id=?1 AND work_episode_id=?2 ORDER BY task_id",
        )
        .map_err(|error| error.to_string())?;
    let task_ids = statement
        .query_map(params![org_run_id, work_episode_id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(task_ids)
}

pub(crate) fn unassociated_task_count_with_connection(
    conn: &Connection,
    org_run_id: &str,
) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM agent_org_runtime_tasks task
         WHERE task.org_run_id=?1 AND NOT EXISTS(
             SELECT 1 FROM agent_org_runtime_work_episode_tasks episode_task
             WHERE episode_task.org_run_id=task.org_run_id
               AND episode_task.task_id=task.id
         )",
        [org_run_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) struct WorkEpisodeClosure<'a> {
    pub activation_generation: i64,
    pub work_revision: i64,
    pub outcome: &'a str,
    pub certificate_id: &'a str,
    pub closed_at: &'a str,
}

pub(crate) fn close_active_in_tx(
    conn: &Connection,
    org_run_id: &str,
    work_episode_id: &str,
    closure: WorkEpisodeClosure<'_>,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE agent_org_runtime_work_episodes
             SET status='certified',closing_activation_generation=?1,
                 closing_work_revision=?2,outcome=?3,certificate_id=?4,closed_at=?5
             WHERE id=?6 AND org_run_id=?7 AND status='active'",
            params![
                closure.activation_generation,
                closure.work_revision,
                closure.outcome,
                closure.certificate_id,
                closure.closed_at,
                work_episode_id,
                org_run_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("agent_org_work_episode_close_conflict".to_string());
    }
    Ok(())
}

#[cfg(test)]
#[path = "agent_org_work_episodes/tests.rs"]
mod tests;
