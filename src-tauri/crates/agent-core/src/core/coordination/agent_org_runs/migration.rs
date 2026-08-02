use std::collections::HashMap;

use crate::definitions::orgs::OrgDefinition;
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};

use super::helpers::flatten_members;
use super::{AgentOrgRunSessionRole, COORDINATOR_MEMBER_ID};

const MAX_ANOMALY_SAMPLES: usize = 20;
const MAX_IDS_PER_ANOMALY: usize = 5;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct AgentOrgRunMigrationReport {
    pub(super) coordinator_mappings_backfilled: usize,
    pub(super) coordinator_mapping_conflicts: usize,
    pub(super) worker_mappings_backfilled: usize,
    pub(super) ambiguous_worker_sessions: usize,
    pub(super) unsupported_cli_sessions: usize,
    pub(super) anomaly_samples: Vec<String>,
}

impl AgentOrgRunMigrationReport {
    pub(crate) fn log(&self) {
        if self.coordinator_mapping_conflicts == 0
            && self.ambiguous_worker_sessions == 0
            && self.unsupported_cli_sessions == 0
            && self.anomaly_samples.is_empty()
        {
            tracing::debug!(
                coordinator_mappings_backfilled = self.coordinator_mappings_backfilled,
                worker_mappings_backfilled = self.worker_mappings_backfilled,
                "[agent_org_runs] exact ownership migration complete"
            );
            return;
        }
        tracing::warn!(
            coordinator_mappings_backfilled = self.coordinator_mappings_backfilled,
            coordinator_mapping_conflicts = self.coordinator_mapping_conflicts,
            worker_mappings_backfilled = self.worker_mappings_backfilled,
            ambiguous_worker_sessions = self.ambiguous_worker_sessions,
            unsupported_cli_sessions = self.unsupported_cli_sessions,
            anomaly_samples = ?self.anomaly_samples,
            "[agent_org_runs] exact ownership migration left unsupported or ambiguous legacy rows unmapped"
        );
    }

    fn record_anomaly(&mut self, message: String) {
        if self.anomaly_samples.len() < MAX_ANOMALY_SAMPLES {
            self.anomaly_samples.push(message);
        }
    }
}

pub(super) fn init_schema(conn: &Connection) -> SqliteResult<AgentOrgRunMigrationReport> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runs (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            coordinator_agent_id TEXT NOT NULL,
            root_session_id TEXT,
            org_snapshot_json TEXT,
            entry_mode TEXT NOT NULL,
            status TEXT NOT NULL,
            work_item_id TEXT,
            project_slug TEXT,
            routine_fire_id TEXT,
            summary TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            continued_from_run_id TEXT REFERENCES agent_org_runs(id) ON DELETE SET NULL,
            originating_message_id TEXT
        );",
    )?;
    add_column_if_missing(
        &tx,
        "agent_org_runs",
        "continued_from_run_id",
        "TEXT REFERENCES agent_org_runs(id) ON DELETE SET NULL",
    )?;
    add_column_if_missing(&tx, "agent_org_runs", "originating_message_id", "TEXT")?;

    let (duplicate_live_root_count, duplicate_live_roots) = duplicate_live_root_samples(&tx)?;
    if !duplicate_live_roots.is_empty() {
        return Err(migration_error(format!(
            "duplicate live Agent Org runs detected for {duplicate_live_root_count} roots; no ownership migration was applied: {}",
            duplicate_live_roots.join(", ")
        )));
    }

    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_run_sessions (
            org_run_id TEXT NOT NULL REFERENCES agent_org_runs(id) ON DELETE CASCADE,
            member_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('coordinator', 'worker')),
            created_at TEXT NOT NULL,
            PRIMARY KEY (org_run_id, member_id),
            UNIQUE (org_run_id, session_id),
            CHECK (
                (role='coordinator' AND member_id='coordinator') OR
                (role='worker' AND member_id<>'coordinator')
            )
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runs_org_updated
            ON agent_org_runs(org_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runs_root_session
            ON agent_org_runs(root_session_id);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runs_work_item
            ON agent_org_runs(work_item_id);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runs_status
            ON agent_org_runs(status);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runs_root_timeline
            ON agent_org_runs(root_session_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runs_root_updated
            ON agent_org_runs(root_session_id, updated_at DESC, id DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_runs_root_originating_message
            ON agent_org_runs(root_session_id, originating_message_id)
            WHERE root_session_id IS NOT NULL AND originating_message_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_runs_one_live_per_root
            ON agent_org_runs(root_session_id)
            WHERE root_session_id IS NOT NULL
              AND status IN ('starting', 'running', 'paused');
        CREATE INDEX IF NOT EXISTS idx_agent_org_run_sessions_session
            ON agent_org_run_sessions(session_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_run_sessions_worker_session
            ON agent_org_run_sessions(session_id)
            WHERE role='worker';
        CREATE TRIGGER IF NOT EXISTS trg_agent_org_run_sessions_insert_role_collision
        BEFORE INSERT ON agent_org_run_sessions
        WHEN EXISTS (
            SELECT 1 FROM agent_org_run_sessions existing
            WHERE existing.session_id=NEW.session_id
              AND (existing.role='worker' OR NEW.role='worker')
        )
        BEGIN
            SELECT RAISE(ABORT, 'Agent Org worker session already has a run ownership');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_agent_org_run_sessions_update_role_collision
        BEFORE UPDATE OF session_id, role ON agent_org_run_sessions
        WHEN EXISTS (
            SELECT 1 FROM agent_org_run_sessions existing
            WHERE existing.session_id=NEW.session_id
              AND (existing.org_run_id<>OLD.org_run_id OR existing.member_id<>OLD.member_id)
              AND (existing.role='worker' OR NEW.role='worker')
        )
        BEGIN
            SELECT RAISE(ABORT, 'Agent Org worker session already has a run ownership');
        END;",
    )?;

    let report = backfill_ownership(&tx)?;
    tx.commit()?;
    Ok(report)
}

fn table_exists(conn: &Connection, table: &str) -> SqliteResult<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> SqliteResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> SqliteResult<()> {
    if !column_exists(conn, table, column)? {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {declaration};"
        ))?;
    }
    Ok(())
}

fn duplicate_live_root_samples(conn: &Connection) -> SqliteResult<(i64, Vec<String>)> {
    let total = conn.query_row(
        "SELECT COUNT(*) FROM (
             SELECT root_session_id FROM agent_org_runs
             WHERE root_session_id IS NOT NULL
               AND status IN ('starting', 'running', 'paused')
             GROUP BY root_session_id HAVING COUNT(*) > 1
         )",
        [],
        |row| row.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT root_session_id, COUNT(*)
         FROM agent_org_runs
         WHERE root_session_id IS NOT NULL
           AND status IN ('starting', 'running', 'paused')
         GROUP BY root_session_id
         HAVING COUNT(*) > 1
         ORDER BY root_session_id
         LIMIT ?1",
    )?;
    let roots = stmt
        .query_map([MAX_ANOMALY_SAMPLES as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    let mut samples = Vec::with_capacity(roots.len());
    for (root, live_count) in roots {
        let mut ids_stmt = conn.prepare(
            "SELECT id FROM agent_org_runs
             WHERE root_session_id=?1 AND status IN ('starting', 'running', 'paused')
             ORDER BY id LIMIT ?2",
        )?;
        let ids = ids_stmt
            .query_map(params![&root, MAX_IDS_PER_ANOMALY as i64], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<SqliteResult<Vec<_>>>()?;
        samples.push(format!(
            "root={root} live_count={live_count} run_ids_sample=[{}]",
            ids.join(",")
        ));
    }
    Ok((total, samples))
}

fn migration_error(message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        std::io::Error::new(std::io::ErrorKind::InvalidData, message).into(),
    )
}

fn backfill_ownership(conn: &Connection) -> SqliteResult<AgentOrgRunMigrationReport> {
    let mut report = AgentOrgRunMigrationReport::default();
    backfill_coordinators(conn, &mut report)?;
    backfill_rust_workers(conn, &mut report)?;
    report_unsupported_cli_sessions(conn, &mut report)?;
    Ok(report)
}

fn backfill_coordinators(
    conn: &Connection,
    report: &mut AgentOrgRunMigrationReport,
) -> SqliteResult<()> {
    let mut stmt = conn.prepare(
        "SELECT id, root_session_id, created_at
         FROM agent_org_runs
         WHERE root_session_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM agent_org_run_sessions mapping
               WHERE mapping.org_run_id=agent_org_runs.id
                 AND mapping.member_id='coordinator'
                 AND mapping.session_id=agent_org_runs.root_session_id
                 AND mapping.role='coordinator'
           )
         ORDER BY created_at, id",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    drop(stmt);

    for (run_id, session_id, created_at) in rows {
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT session_id, role FROM agent_org_run_sessions
                 WHERE org_run_id=?1 AND member_id=?2",
                params![&run_id, COORDINATOR_MEMBER_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((existing_session_id, role)) = existing {
            if existing_session_id != session_id
                || role != AgentOrgRunSessionRole::Coordinator.as_str()
            {
                report.coordinator_mapping_conflicts += 1;
                report.record_anomaly(format!(
                    "coordinator mapping conflict run={run_id} expected_session={session_id} existing_session={existing_session_id} role={role}"
                ));
            }
            continue;
        }
        let conflicting_worker: bool = conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM agent_org_run_sessions
                 WHERE session_id=?1 AND role='worker'
             )",
            [&session_id],
            |row| row.get(0),
        )?;
        if conflicting_worker {
            report.coordinator_mapping_conflicts += 1;
            report.record_anomaly(format!(
                "coordinator session is already owned as worker run={run_id} session={session_id}"
            ));
            continue;
        }
        conn.execute(
            "INSERT INTO agent_org_run_sessions (
                org_run_id, member_id, session_id, role, created_at
             ) VALUES (?1, ?2, ?3, 'coordinator', ?4)",
            params![run_id, COORDINATOR_MEMBER_ID, session_id, created_at],
        )?;
        report.coordinator_mappings_backfilled += 1;
    }
    Ok(())
}

#[derive(Debug)]
struct RustWorkerCandidate {
    session_id: String,
    member_id: String,
    agent_definition_id: String,
    root_session_id: String,
    created_at: String,
}

fn backfill_rust_workers(
    conn: &Connection,
    report: &mut AgentOrgRunMigrationReport,
) -> SqliteResult<()> {
    if !table_exists(conn, "agent_sessions")?
        || !column_exists(conn, "agent_sessions", "org_member_id")?
        || !column_exists(conn, "agent_sessions", "parent_session_id")?
        || !column_exists(conn, "agent_sessions", "agent_definition_id")?
    {
        return Ok(());
    }

    let mut stmt = conn.prepare(
        "SELECT session_id, org_member_id, agent_definition_id, parent_session_id, created_at
         FROM agent_sessions
         WHERE org_member_id IS NOT NULL
           AND org_member_id<>'coordinator'
           AND parent_session_id IS NOT NULL
           AND agent_definition_id IS NOT NULL
           AND parent_session_id IN (
               SELECT root_session_id FROM agent_org_runs
               WHERE root_session_id IS NOT NULL
           )
           AND NOT EXISTS (
               SELECT 1
               FROM agent_org_run_sessions mapping
               JOIN agent_org_runs mapped_run ON mapped_run.id=mapping.org_run_id
               WHERE mapping.session_id=agent_sessions.session_id
                 AND mapping.member_id=agent_sessions.org_member_id
                 AND mapping.role='worker'
                 AND mapped_run.root_session_id=agent_sessions.parent_session_id
           )
         ORDER BY created_at, session_id",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RustWorkerCandidate {
                session_id: row.get(0)?,
                member_id: row.get(1)?,
                agent_definition_id: row.get(2)?,
                root_session_id: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    drop(stmt);

    let has_turn_intents = table_exists(conn, "session_turn_intents")?
        && column_exists(conn, "session_turn_intents", "org_run_id")?;
    let mut grouped: HashMap<(String, String), Vec<RustWorkerCandidate>> = HashMap::new();

    for candidate in rows {
        let turn_run_ids = if has_turn_intents {
            let mut intent_stmt = conn.prepare(
                "SELECT DISTINCT org_run_id
                 FROM session_turn_intents
                 WHERE session_id=?1
                   AND org_run_id IS NOT NULL
                   AND status NOT IN ('stale', 'coalesced', 'rejected')
                 ORDER BY org_run_id
                 LIMIT ?2",
            )?;
            let run_ids = intent_stmt
                .query_map(
                    params![&candidate.session_id, (MAX_IDS_PER_ANOMALY + 1) as i64],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<SqliteResult<Vec<_>>>()?;
            run_ids
        } else {
            Vec::new()
        };

        let run_id = match turn_run_ids.as_slice() {
            [run_id] => {
                let run_root: Option<String> = conn
                    .query_row(
                        "SELECT root_session_id FROM agent_org_runs WHERE id=?1",
                        [run_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .flatten();
                if run_root.as_deref() != Some(candidate.root_session_id.as_str()) {
                    report.ambiguous_worker_sessions += 1;
                    report.record_anomaly(format!(
                        "turn intent run/root mismatch session={} member={} run={} parent_root={}",
                        candidate.session_id,
                        candidate.member_id,
                        run_id,
                        candidate.root_session_id
                    ));
                    continue;
                }
                run_id.clone()
            }
            [] => {
                let mut run_stmt = conn.prepare(
                    "SELECT id FROM agent_org_runs
                     WHERE root_session_id=?1
                     ORDER BY created_at, id
                     LIMIT 2",
                )?;
                let run_ids = run_stmt
                    .query_map([&candidate.root_session_id], |row| row.get::<_, String>(0))?
                    .collect::<SqliteResult<Vec<_>>>()?;
                if run_ids.len() != 1 {
                    report.ambiguous_worker_sessions += 1;
                    report.record_anomaly(format!(
                        "worker has no exact intent and root has {} runs session={} member={} root={}",
                        run_ids.len(),
                        candidate.session_id,
                        candidate.member_id,
                        candidate.root_session_id
                    ));
                    continue;
                }
                run_ids[0].clone()
            }
            _ => {
                report.ambiguous_worker_sessions += 1;
                let truncated = turn_run_ids.len() > MAX_IDS_PER_ANOMALY;
                report.record_anomaly(format!(
                    "worker turn intents disagree session={} member={} run_ids_sample=[{}] truncated={truncated}",
                    candidate.session_id,
                    candidate.member_id,
                    turn_run_ids[..turn_run_ids.len().min(MAX_IDS_PER_ANOMALY)].join(",")
                ));
                continue;
            }
        };

        match member_belongs_to_snapshot(
            conn,
            &run_id,
            &candidate.member_id,
            &candidate.agent_definition_id,
        )? {
            SnapshotMemberCheck::Allowed => {}
            SnapshotMemberCheck::MissingMember => {
                report.ambiguous_worker_sessions += 1;
                report.record_anomaly(format!(
                    "worker member is absent from run snapshot session={} member={} run={}",
                    candidate.session_id, candidate.member_id, run_id
                ));
                continue;
            }
            SnapshotMemberCheck::MismatchedAgent { expected_agent_id } => {
                report.ambiguous_worker_sessions += 1;
                report.record_anomaly(format!(
                    "worker agent contradicts run snapshot session={} member={} run={} persisted_agent={} expected_agent={expected_agent_id}",
                    candidate.session_id,
                    candidate.member_id,
                    run_id,
                    candidate.agent_definition_id
                ));
                continue;
            }
            SnapshotMemberCheck::Malformed(error) => {
                report.ambiguous_worker_sessions += 1;
                report.record_anomaly(format!(
                    "run snapshot is malformed; worker left unmapped session={} member={} run={} error={error}",
                    candidate.session_id, candidate.member_id, run_id
                ));
                continue;
            }
        }
        grouped
            .entry((run_id, candidate.member_id.clone()))
            .or_default()
            .push(candidate);
    }

    for ((run_id, member_id), candidates) in grouped {
        if candidates.len() != 1 {
            report.ambiguous_worker_sessions += candidates.len();
            report.record_anomaly(format!(
                "multiple Rust worker sessions claim one run member run={run_id} member={member_id} total={} sessions_sample=[{}]",
                candidates.len(),
                candidates
                    .iter()
                    .take(MAX_IDS_PER_ANOMALY)
                    .map(|candidate| candidate.session_id.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            ));
            continue;
        }
        let candidate = &candidates[0];
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT session_id, role FROM agent_org_run_sessions
                 WHERE org_run_id=?1 AND member_id=?2",
                params![&run_id, &member_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((existing_session_id, role)) = existing {
            if existing_session_id != candidate.session_id
                || role != AgentOrgRunSessionRole::Worker.as_str()
            {
                report.ambiguous_worker_sessions += 1;
                report.record_anomaly(format!(
                    "existing worker mapping conflicts run={run_id} member={member_id} expected_session={} existing_session={existing_session_id} role={role}",
                    candidate.session_id
                ));
            }
            continue;
        }
        match conn.execute(
            "INSERT INTO agent_org_run_sessions (
                org_run_id, member_id, session_id, role, created_at
             ) VALUES (?1, ?2, ?3, 'worker', ?4)",
            params![
                run_id,
                member_id,
                candidate.session_id,
                candidate.created_at
            ],
        ) {
            Ok(_) => report.worker_mappings_backfilled += 1,
            Err(error) => {
                report.ambiguous_worker_sessions += 1;
                report.record_anomaly(format!(
                    "worker mapping constraint rejected run={} member={} session={}: {}",
                    run_id, member_id, candidate.session_id, error
                ));
            }
        }
    }
    Ok(())
}

enum SnapshotMemberCheck {
    Allowed,
    MissingMember,
    MismatchedAgent { expected_agent_id: String },
    Malformed(String),
}

fn member_belongs_to_snapshot(
    conn: &Connection,
    run_id: &str,
    member_id: &str,
    agent_definition_id: &str,
) -> SqliteResult<SnapshotMemberCheck> {
    let snapshot_json: Option<String> = conn
        .query_row(
            "SELECT org_snapshot_json FROM agent_org_runs WHERE id=?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let Some(snapshot_json) = snapshot_json else {
        return Ok(SnapshotMemberCheck::Allowed);
    };
    let snapshot: OrgDefinition = match serde_json::from_str(&snapshot_json) {
        Ok(snapshot) => snapshot,
        Err(error) => return Ok(SnapshotMemberCheck::Malformed(error.to_string())),
    };
    let members = flatten_members(&snapshot.children, None);
    let mut matches = members
        .iter()
        .filter(|member| member.member_id == member_id);
    let Some(member) = matches.next() else {
        return Ok(SnapshotMemberCheck::MissingMember);
    };
    if matches.next().is_some() {
        return Ok(SnapshotMemberCheck::Malformed(format!(
            "duplicate member_id {member_id}"
        )));
    }
    if member.agent_id != agent_definition_id {
        return Ok(SnapshotMemberCheck::MismatchedAgent {
            expected_agent_id: member.agent_id.clone(),
        });
    }
    Ok(SnapshotMemberCheck::Allowed)
}

fn report_unsupported_cli_sessions(
    conn: &Connection,
    report: &mut AgentOrgRunMigrationReport,
) -> SqliteResult<()> {
    if !table_exists(conn, "code_sessions")?
        || !column_exists(conn, "code_sessions", "org_member_id")?
        || !column_exists(conn, "code_sessions", "parent_session_id")?
    {
        return Ok(());
    }
    report.unsupported_cli_sessions = conn.query_row(
        "SELECT COUNT(*) FROM code_sessions
         WHERE org_member_id IS NOT NULL
           AND (
               parent_session_id IN (SELECT root_session_id FROM agent_org_runs)
               OR session_id IN (SELECT root_session_id FROM agent_org_runs)
           )",
        [],
        |row| row.get(0),
    )?;
    if report.unsupported_cli_sessions == 0 {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT session_id, org_member_id, COALESCE(parent_session_id, session_id)
         FROM code_sessions
         WHERE org_member_id IS NOT NULL
           AND (
               parent_session_id IN (SELECT root_session_id FROM agent_org_runs)
               OR session_id IN (SELECT root_session_id FROM agent_org_runs)
           )
         ORDER BY session_id
         LIMIT ?1",
    )?;
    let rows = stmt.query_map([MAX_ANOMALY_SAMPLES as i64], |row| {
        Ok(format!(
            "unsupported historical CLI Agent Org session={} member={} root={}",
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?
        ))
    })?;
    for row in rows {
        report.record_anomaly(row?);
    }
    Ok(())
}
