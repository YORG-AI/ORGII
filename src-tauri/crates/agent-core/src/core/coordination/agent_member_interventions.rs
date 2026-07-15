//! User-intervention state for Agent Org members.
//!
//! A member can temporarily be in direct conversation with the user. While this
//! state is active, turn-boundary inbox drain is paused so the user's follow-up
//! is processed before coworker messages or newly assigned work.

use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
use serde::Serialize;

use database::db::{get_connection, with_sessions_writer};

use super::agent_org_runs::COORDINATOR_MEMBER_ID;

pub const DEFAULT_INTERVENTION_TTL_SECS: i64 = 180;

/// Member intervention is a temporary user takeover of a worker session.
/// Coordinator/root chat is the normal Agent Org control surface, not a
/// takeover target.
pub fn can_enter_member_intervention(member_id: &str) -> bool {
    member_id != COORDINATOR_MEMBER_ID
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberInterventionStatus {
    UserIntervention,
}

impl MemberInterventionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserIntervention => "user_intervention",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "user_intervention" => Some(Self::UserIntervention),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMemberInterventionRecord {
    pub org_run_id: String,
    pub member_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub status: MemberInterventionStatus,
    pub reason: Option<String>,
    pub entered_at: String,
    pub last_user_activity_at: String,
    pub resume_after: String,
    pub cleared_at: Option<String>,
}

pub fn init_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_member_interventions (
            org_run_id TEXT NOT NULL,
            member_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL,
            reason TEXT,
            entered_at TEXT NOT NULL,
            last_user_activity_at TEXT NOT NULL,
            resume_after TEXT NOT NULL,
            cleared_at TEXT,
            PRIMARY KEY (org_run_id, member_id)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_member_interventions_session
            ON agent_member_interventions(session_id);
        CREATE INDEX IF NOT EXISTS idx_agent_member_interventions_active
            ON agent_member_interventions(org_run_id, cleared_at, resume_after);",
    )
}

#[derive(Debug, Clone)]
pub struct EnterMemberInterventionParams {
    pub org_run_id: String,
    pub member_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub reason: Option<String>,
    pub ttl_secs: i64,
}

pub struct AgentMemberInterventionStore;

impl AgentMemberInterventionStore {
    pub fn enter(
        params: EnterMemberInterventionParams,
    ) -> Result<AgentMemberInterventionRecord, String> {
        if !can_enter_member_intervention(&params.member_id) {
            return Err(
                "coordinator is the normal Agent Org control surface and cannot enter member intervention"
                    .to_string(),
            );
        }
        let now = chrono::Utc::now();
        let now_text = now.to_rfc3339();
        let ttl_secs = if params.ttl_secs > 0 {
            params.ttl_secs
        } else {
            DEFAULT_INTERVENTION_TTL_SECS
        };
        let resume_after = (now + chrono::Duration::seconds(ttl_secs)).to_rfc3339();
        let status = MemberInterventionStatus::UserIntervention;

        with_sessions_writer(|| -> Result<(), String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            conn.execute(
                "INSERT INTO agent_member_interventions (
                org_run_id,
                member_id,
                agent_id,
                session_id,
                status,
                reason,
                entered_at,
                last_user_activity_at,
                resume_after,
                cleared_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)
            ON CONFLICT(org_run_id, member_id) DO UPDATE SET
                agent_id = excluded.agent_id,
                session_id = excluded.session_id,
                status = excluded.status,
                reason = excluded.reason,
                last_user_activity_at = excluded.last_user_activity_at,
                resume_after = excluded.resume_after,
                cleared_at = NULL",
                params![
                    params.org_run_id,
                    params.member_id,
                    params.agent_id,
                    params.session_id,
                    status.as_str(),
                    params.reason.as_deref(),
                    now_text,
                    now_text,
                    resume_after,
                ],
            )
            .map_err(|err| err.to_string())?;
            Ok(())
        })?;

        Self::get(&params.org_run_id, &params.member_id)?.ok_or_else(|| {
            format!(
                "agent_member_interventions upsert did not return row for run={} member={}",
                params.org_run_id, params.member_id
            )
        })
    }

    pub fn clear(org_run_id: &str, member_id: &str) -> Result<bool, String> {
        let now = chrono::Utc::now().to_rfc3339();
        with_sessions_writer(|| -> Result<bool, String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            let updated = conn
                .execute(
                    "UPDATE agent_member_interventions
                     SET cleared_at = ?3
                     WHERE org_run_id = ?1 AND member_id = ?2 AND cleared_at IS NULL",
                    params![org_run_id, member_id, now],
                )
                .map_err(|err| err.to_string())?;
            Ok(updated > 0)
        })
    }

    pub fn get(
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<AgentMemberInterventionRecord>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        conn.query_row(
            "SELECT org_run_id,
                    member_id,
                    agent_id,
                    session_id,
                    status,
                    reason,
                    entered_at,
                    last_user_activity_at,
                    resume_after,
                    cleared_at
             FROM agent_member_interventions
             WHERE org_run_id = ?1 AND member_id = ?2",
            params![org_run_id, member_id],
            row_to_intervention,
        )
        .optional()
        .map_err(|err| err.to_string())
    }

    pub fn active_for_member(
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<AgentMemberInterventionRecord>, String> {
        if member_id == COORDINATOR_MEMBER_ID {
            // Self-heal rows written by older builds where any direct root
            // message was incorrectly classified as a member takeover.
            let _ = Self::clear(org_run_id, member_id)?;
            return Ok(None);
        }
        let Some(record) = Self::get(org_run_id, member_id)? else {
            return Ok(None);
        };
        if record.cleared_at.is_some() {
            return Ok(None);
        }
        if !resume_after_is_future(&record.resume_after) {
            let _ = Self::clear(org_run_id, member_id)?;
            return Ok(None);
        }
        Ok(Some(record))
    }

    /// Clear all active interventions across all org runs. Called at app startup
    /// after `mark_stale_running_sessions_abandoned` runs: once member sessions
    /// are abandoned the TTL-gated intervention records become stale, but the
    /// 3-minute TTL can still be in the future. Clearing them eagerly prevents
    /// the `AgentOrgInterventionPinBar` from reappearing after restart.
    ///
    /// Returns the number of records cleared.
    pub fn clear_all_active_on_startup() -> Result<usize, String> {
        let now = chrono::Utc::now().to_rfc3339();
        with_sessions_writer(|| -> Result<usize, String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            let updated = conn
                .execute(
                    "UPDATE agent_member_interventions
                     SET cleared_at = ?1
                     WHERE cleared_at IS NULL",
                    params![now],
                )
                .map_err(|err| err.to_string())?;
            Ok(updated)
        })
    }

    pub fn list_active(org_run_id: &str) -> Result<Vec<AgentMemberInterventionRecord>, String> {
        // Do not let a legacy coordinator row block finality or reappear in the
        // UI after upgrading to the worker-only intervention invariant.
        let _ = Self::clear(org_run_id, COORDINATOR_MEMBER_ID)?;
        let conn = get_connection().map_err(|err| err.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut stmt = conn
            .prepare(
                "SELECT org_run_id,
                        member_id,
                        agent_id,
                        session_id,
                        status,
                        reason,
                        entered_at,
                        last_user_activity_at,
                        resume_after,
                        cleared_at
                 FROM agent_member_interventions
                 WHERE org_run_id = ?1
                   AND cleared_at IS NULL
                   AND resume_after > ?2
                 ORDER BY last_user_activity_at DESC",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map(params![org_run_id, now], row_to_intervention)
            .map_err(|err| err.to_string())?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(|err| err.to_string())?);
        }
        Ok(records)
    }
}

fn resume_after_is_future(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&chrono::Utc) > chrono::Utc::now())
        .unwrap_or(false)
}

fn row_to_intervention(row: &rusqlite::Row<'_>) -> SqliteResult<AgentMemberInterventionRecord> {
    let status_raw: String = row.get(4)?;
    let status = MemberInterventionStatus::parse(&status_raw).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(
            4,
            format!("status={status_raw}"),
            rusqlite::types::Type::Text,
        )
    })?;
    Ok(AgentMemberInterventionRecord {
        org_run_id: row.get(0)?,
        member_id: row.get(1)?,
        agent_id: row.get(2)?,
        session_id: row.get(3)?,
        status,
        reason: row.get(5)?,
        entered_at: row.get(6)?,
        last_user_activity_at: row.get(7)?,
        resume_after: row.get(8)?,
        cleared_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> test_helpers::test_env::SandboxGuard {
        let sandbox = test_helpers::test_env::sandbox();
        let conn = get_connection().expect("db connection");
        init_schema(&conn).expect("schema");
        conn.execute("DELETE FROM agent_member_interventions", [])
            .expect("clear");
        sandbox
    }

    #[test]
    fn enter_upserts_active_record_by_member_id() {
        let _sandbox = setup();
        let first = AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: "run-1".into(),
            member_id: "member-a".into(),
            agent_id: "agent-a".into(),
            session_id: "session-a".into(),
            reason: Some("user".into()),
            ttl_secs: 60,
        })
        .expect("enter first");
        let second = AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: "run-1".into(),
            member_id: "member-a".into(),
            agent_id: "agent-a".into(),
            session_id: "session-b".into(),
            reason: Some("again".into()),
            ttl_secs: 60,
        })
        .expect("enter second");

        assert_eq!(first.member_id, "member-a");
        assert_eq!(second.session_id, "session-b");
        assert_eq!(
            AgentMemberInterventionStore::active_for_member("run-1", "member-a")
                .expect("active")
                .expect("record")
                .session_id,
            "session-b"
        );
    }

    #[test]
    fn coordinator_cannot_enter_member_intervention() {
        let _sandbox = setup();
        let error = AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: "run-1".into(),
            member_id: COORDINATOR_MEMBER_ID.into(),
            agent_id: "builtin:sde".into(),
            session_id: "root-session".into(),
            reason: Some("direct_user_chat".into()),
            ttl_secs: 60,
        })
        .expect_err("coordinator must not enter member intervention");

        assert!(error.contains("cannot enter member intervention"));
    }

    #[test]
    fn legacy_coordinator_intervention_is_cleared_on_read() {
        let _sandbox = setup();
        let now = chrono::Utc::now();
        let conn = get_connection().expect("db connection");
        conn.execute(
            "INSERT INTO agent_member_interventions (
                org_run_id, member_id, agent_id, session_id, status, reason,
                entered_at, last_user_activity_at, resume_after, cleared_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, NULL)",
            params![
                "run-legacy",
                COORDINATOR_MEMBER_ID,
                "builtin:sde",
                "root-session",
                MemberInterventionStatus::UserIntervention.as_str(),
                "direct_user_chat",
                now.to_rfc3339(),
                (now + chrono::Duration::minutes(3)).to_rfc3339(),
            ],
        )
        .expect("insert legacy coordinator intervention");

        assert!(AgentMemberInterventionStore::active_for_member(
            "run-legacy",
            COORDINATOR_MEMBER_ID
        )
        .expect("read legacy intervention")
        .is_none());
        assert!(
            AgentMemberInterventionStore::get("run-legacy", COORDINATOR_MEMBER_ID)
                .expect("get cleared legacy intervention")
                .expect("legacy row remains for audit")
                .cleared_at
                .is_some()
        );
    }

    #[test]
    fn clear_hides_active_record() {
        let _sandbox = setup();
        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: "run-1".into(),
            member_id: "member-a".into(),
            agent_id: "agent-a".into(),
            session_id: "session-a".into(),
            reason: None,
            ttl_secs: 60,
        })
        .expect("enter");

        assert!(AgentMemberInterventionStore::clear("run-1", "member-a").expect("clear"));
        assert!(
            AgentMemberInterventionStore::active_for_member("run-1", "member-a")
                .expect("active")
                .is_none()
        );
    }

    #[test]
    fn list_active_excludes_cleared_and_expired_records() {
        let _sandbox = setup();
        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: "run-1".into(),
            member_id: "member-a".into(),
            agent_id: "agent-a".into(),
            session_id: "session-a".into(),
            reason: None,
            ttl_secs: 60,
        })
        .expect("enter active");
        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: "run-1".into(),
            member_id: "member-b".into(),
            agent_id: "agent-b".into(),
            session_id: "session-b".into(),
            reason: None,
            ttl_secs: 60,
        })
        .expect("enter cleared");
        AgentMemberInterventionStore::clear("run-1", "member-b").expect("clear");

        let active = AgentMemberInterventionStore::list_active("run-1").expect("list active");
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].member_id, "member-a");
    }

    #[test]
    fn active_for_member_returns_none_after_ttl_expires() {
        let _sandbox = setup();
        let conn = get_connection().expect("db connection");

        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: "run-1".into(),
            member_id: "member-ttl".into(),
            agent_id: "agent-a".into(),
            session_id: "session-a".into(),
            reason: None,
            ttl_secs: 1,
        })
        .expect("enter");

        // Backdated resume_after to simulate expiry without sleeping.
        let expired = (chrono::Utc::now() - chrono::Duration::seconds(10)).to_rfc3339();
        conn.execute(
            "UPDATE agent_member_interventions SET resume_after = ?1 WHERE org_run_id = ?2 AND member_id = ?3",
            rusqlite::params![expired, "run-1", "member-ttl"],
        )
        .expect("backdate");

        assert!(
            AgentMemberInterventionStore::active_for_member("run-1", "member-ttl")
                .expect("active")
                .is_none(),
            "expired intervention must not be returned as active"
        );

        let record =
            AgentMemberInterventionStore::get("run-1", "member-ttl").expect("get after expiry");
        assert!(
            record.map(|r| r.cleared_at.is_some()).unwrap_or(false),
            "expired intervention must be auto-cleared"
        );
    }

    #[test]
    fn two_members_can_share_agent_id_without_colliding() {
        let _sandbox = setup();
        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: "run-1".into(),
            member_id: "member-a".into(),
            agent_id: "agent-shared".into(),
            session_id: "session-a".into(),
            reason: None,
            ttl_secs: 60,
        })
        .expect("enter a");
        AgentMemberInterventionStore::enter(EnterMemberInterventionParams {
            org_run_id: "run-1".into(),
            member_id: "member-b".into(),
            agent_id: "agent-shared".into(),
            session_id: "session-b".into(),
            reason: None,
            ttl_secs: 60,
        })
        .expect("enter b");

        let active = AgentMemberInterventionStore::list_active("run-1").expect("list active");
        assert_eq!(active.len(), 2);
    }
}
