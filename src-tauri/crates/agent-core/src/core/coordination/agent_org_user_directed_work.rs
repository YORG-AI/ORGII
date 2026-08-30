//! Source-neutral durable ownership for Agent Org user-directed work.
//!
//! Direct Member chat, Group mentions, and linked Member Inbox work share
//! this one delivery ledger. Source-specific modules may add behaviour (for
//! example, Direct Member intervention/yield), but they do not own a second
//! queue, lifecycle, or recovery authority.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use database::db::{get_connection, with_sessions_writer};

mod recovery;

#[cfg(test)]
pub(crate) use recovery::mark_started_unknown_after_restart;
pub(crate) use recovery::{mark_started_unknown_after_restart_after, recoverable_pending_after};

pub(crate) const USER_DIRECTED_POLICY_VERSION: i64 = 1;
pub(crate) const DEFAULT_MAX_GROUP_TARGETS: i64 = 10;
pub(crate) const DEFAULT_MAX_PENDING_PER_MEMBER: i64 = 32;
pub(crate) const DEFAULT_MAX_DELIVERIES_PER_ROOT: i64 = 8;
pub(crate) const DEFAULT_MAX_CASCADE_DEPTH: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UserDirectedSourceKind {
    DirectMember,
    GroupMention,
    MemberInbox,
}

impl UserDirectedSourceKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::DirectMember => "direct_member",
            Self::GroupMention => "group_mention",
            Self::MemberInbox => "member_inbox",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UserDirectedDeliveryStatus {
    Pending,
    Started,
    Completed,
    Failed,
    Cancelled,
    Abandoned,
    Unknown,
}

impl UserDirectedDeliveryStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Started => "started",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Abandoned => "abandoned",
            Self::Unknown => "unknown",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "started" => Self::Started,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "abandoned" => Self::Abandoned,
            "unknown" => Self::Unknown,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct NewUserDirectedDelivery<'a> {
    pub org_run_id: &'a str,
    pub session_id: &'a str,
    pub turn_intent_id: &'a str,
    pub root_authority_turn_id: &'a str,
    pub parent_delivery_id: Option<i64>,
    pub parent_inbox_id: Option<i64>,
    pub source_kind: UserDirectedSourceKind,
    pub source_event_id: Option<&'a str>,
    pub source_inbox_id: Option<i64>,
    pub dispatch_member_id: &'a str,
    pub member_dispatch_sequence: i64,
    pub depth: i64,
    pub delivery_ordinal: i64,
    pub dispatch_content: &'a str,
    pub display_content: &'a str,
    pub images: Option<&'a [String]>,
}

#[derive(Debug, Clone)]
pub(crate) struct NewLinkedMemberDelivery<'a> {
    pub org_run_id: &'a str,
    pub source_session_id: &'a str,
    pub source_turn_intent_id: &'a str,
    pub recipient_session_id: &'a str,
    pub recipient_member_id: &'a str,
    pub child_turn_intent_id: &'a str,
    pub source_inbox_id: i64,
    pub dispatch_content: &'a str,
    pub display_content: &'a str,
    pub images: Option<&'a [String]>,
}

#[derive(Debug, Clone)]
pub(crate) struct NewLinkedCoordinatorDelivery<'a> {
    pub org_run_id: &'a str,
    pub source_session_id: &'a str,
    pub source_turn_intent_id: &'a str,
    pub coordinator_session_id: &'a str,
    pub child_turn_intent_id: &'a str,
    pub source_inbox_id: i64,
    pub dispatch_content: &'a str,
    pub display_content: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UserDirectedCoordinatorBinding {
    pub org_run_id: String,
    pub session_id: String,
    pub turn_intent_id: String,
    pub root_authority_turn_id: String,
    pub source_inbox_id: i64,
    pub depth: i64,
    pub delivery_ordinal: i64,
    pub status: UserDirectedDeliveryStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UserDirectedDeliveryRecord {
    pub delivery_id: i64,
    pub org_run_id: String,
    pub session_id: String,
    pub turn_intent_id: String,
    pub root_authority_turn_id: String,
    pub parent_delivery_id: Option<i64>,
    pub parent_inbox_id: Option<i64>,
    pub source_kind: UserDirectedSourceKind,
    pub source_event_id: Option<String>,
    pub source_inbox_id: Option<i64>,
    pub dispatch_member_id: String,
    pub member_dispatch_sequence: i64,
    pub depth: i64,
    pub delivery_ordinal: i64,
    pub request_digest: String,
    pub status: UserDirectedDeliveryStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecoverableUserDirectedDispatch {
    pub recovery_key: String,
    pub org_run_id: String,
    pub recipient_member_id: String,
    pub recipient_session_id: String,
    pub turn_intent_id: String,
    pub content: String,
    pub display_text: String,
    pub images: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct UserDirectedCausalReply {
    pub source_kind: String,
    pub source_inbox_id: Option<i64>,
    pub parent_inbox_id: Option<i64>,
    pub root_authority_turn_id: String,
    pub depth: i64,
    pub delivery_ordinal: i64,
}

pub(super) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_user_directed_roots (
            org_run_id TEXT NOT NULL,
            root_authority_turn_id TEXT NOT NULL CHECK(length(trim(root_authority_turn_id)) > 0),
            policy_version INTEGER NOT NULL CHECK(policy_version >= 1),
            max_deliveries INTEGER NOT NULL CHECK(max_deliveries >= 1),
            max_cascade_depth INTEGER NOT NULL CHECK(max_cascade_depth >= 0),
            next_delivery_ordinal INTEGER NOT NULL CHECK(next_delivery_ordinal >= 2),
            created_at TEXT NOT NULL,
            PRIMARY KEY(org_run_id, root_authority_turn_id),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_org_runtime_user_directed_deliveries (
            delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
            org_run_id TEXT NOT NULL,
            session_id TEXT NOT NULL CHECK(length(trim(session_id)) > 0),
            turn_intent_id TEXT NOT NULL CHECK(length(trim(turn_intent_id)) > 0),
            root_authority_turn_id TEXT NOT NULL CHECK(length(trim(root_authority_turn_id)) > 0),
            parent_delivery_id INTEGER,
            parent_inbox_id INTEGER,
            source_kind TEXT NOT NULL
                CHECK(source_kind IN ('direct_member','group_mention','member_inbox')),
            source_event_id TEXT,
            source_inbox_id INTEGER,
            dispatch_member_id TEXT NOT NULL CHECK(length(trim(dispatch_member_id)) > 0),
            member_dispatch_sequence INTEGER NOT NULL CHECK(member_dispatch_sequence >= 1),
            depth INTEGER NOT NULL CHECK(depth >= 0),
            delivery_ordinal INTEGER NOT NULL CHECK(delivery_ordinal >= 1),
            request_digest TEXT NOT NULL
                CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
            dispatch_content TEXT NOT NULL CHECK(length(trim(dispatch_content)) > 0),
            display_content TEXT NOT NULL CHECK(length(trim(display_content)) > 0),
            images_json TEXT NOT NULL DEFAULT '[]'
                CHECK(json_valid(images_json)=1 AND json_type(images_json)='array'),
            status TEXT NOT NULL
                CHECK(status IN ('pending','started','completed','failed','cancelled','abandoned','unknown')),
            created_at TEXT NOT NULL,
            started_at TEXT,
            terminal_at TEXT,
            failure_reason TEXT,
            UNIQUE(session_id, turn_intent_id),
            UNIQUE(org_run_id, root_authority_turn_id, delivery_ordinal),
            FOREIGN KEY(org_run_id, root_authority_turn_id)
                REFERENCES agent_org_runtime_user_directed_roots(org_run_id, root_authority_turn_id)
                ON DELETE CASCADE,
            FOREIGN KEY(session_id, turn_intent_id)
                REFERENCES agent_org_runtime_turn_contexts(session_id, turn_intent_id)
                ON DELETE CASCADE,
            FOREIGN KEY(parent_delivery_id)
                REFERENCES agent_org_runtime_user_directed_deliveries(delivery_id) ON DELETE RESTRICT,
            FOREIGN KEY(source_inbox_id)
                REFERENCES agent_org_runtime_inbox(id) ON DELETE RESTRICT,
            FOREIGN KEY(parent_inbox_id)
                REFERENCES agent_org_runtime_inbox(id) ON DELETE RESTRICT,
            CHECK(
                (source_kind='direct_member'
                 AND source_event_id IS NOT NULL
                 AND source_inbox_id IS NULL AND parent_delivery_id IS NULL
                 AND parent_inbox_id IS NULL
                 AND depth=0 AND root_authority_turn_id=turn_intent_id)
                OR
                (source_kind='group_mention'
                 AND source_event_id IS NULL
                 AND source_inbox_id IS NOT NULL AND parent_delivery_id IS NULL
                 AND parent_inbox_id IS NULL
                 AND depth=0 AND root_authority_turn_id=turn_intent_id)
                OR
                (source_kind='member_inbox'
                 AND source_event_id IS NULL
                 AND source_inbox_id IS NOT NULL AND parent_delivery_id IS NOT NULL
                 AND depth>=1)
            ),
            CHECK(
                (status='pending' AND started_at IS NULL AND terminal_at IS NULL AND failure_reason IS NULL)
                OR
                (status='started' AND started_at IS NOT NULL AND terminal_at IS NULL AND failure_reason IS NULL)
                OR
                (status IN ('completed','cancelled') AND started_at IS NOT NULL AND terminal_at IS NOT NULL)
                OR
                (status IN ('failed','abandoned','unknown') AND terminal_at IS NOT NULL)
            )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_runtime_udw_source_inbox
            ON agent_org_runtime_user_directed_deliveries(source_inbox_id)
            WHERE source_inbox_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_udw_member_fifo
            ON agent_org_runtime_user_directed_deliveries(
                org_run_id, dispatch_member_id, member_dispatch_sequence
            ) WHERE status IN ('pending','started');
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_udw_pending_recovery
            ON agent_org_runtime_user_directed_deliveries(delivery_id)
            WHERE status='pending';

        CREATE TABLE IF NOT EXISTS agent_org_runtime_user_directed_coordinator_bindings (
            binding_id INTEGER PRIMARY KEY AUTOINCREMENT,
            org_run_id TEXT NOT NULL,
            session_id TEXT NOT NULL CHECK(length(trim(session_id)) > 0),
            turn_intent_id TEXT NOT NULL CHECK(length(trim(turn_intent_id)) > 0),
            root_authority_turn_id TEXT NOT NULL CHECK(length(trim(root_authority_turn_id)) > 0),
            parent_delivery_id INTEGER NOT NULL,
            parent_inbox_id INTEGER,
            source_inbox_id INTEGER NOT NULL,
            depth INTEGER NOT NULL CHECK(depth >= 1),
            delivery_ordinal INTEGER NOT NULL CHECK(delivery_ordinal >= 2),
            request_digest TEXT NOT NULL
                CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
            dispatch_content TEXT NOT NULL CHECK(length(trim(dispatch_content)) > 0),
            display_content TEXT NOT NULL CHECK(length(trim(display_content)) > 0),
            status TEXT NOT NULL
                CHECK(status IN ('pending','started','completed','failed','cancelled','abandoned','unknown')),
            created_at TEXT NOT NULL,
            started_at TEXT,
            terminal_at TEXT,
            failure_reason TEXT,
            UNIQUE(session_id,turn_intent_id),
            UNIQUE(source_inbox_id),
            UNIQUE(org_run_id,root_authority_turn_id,delivery_ordinal),
            FOREIGN KEY(org_run_id,root_authority_turn_id)
                REFERENCES agent_org_runtime_user_directed_roots(org_run_id,root_authority_turn_id)
                ON DELETE CASCADE,
            FOREIGN KEY(session_id,turn_intent_id)
                REFERENCES agent_org_runtime_turn_contexts(session_id,turn_intent_id)
                ON DELETE CASCADE,
            FOREIGN KEY(parent_delivery_id)
                REFERENCES agent_org_runtime_user_directed_deliveries(delivery_id) ON DELETE RESTRICT,
            FOREIGN KEY(parent_inbox_id) REFERENCES agent_org_runtime_inbox(id) ON DELETE RESTRICT,
            FOREIGN KEY(source_inbox_id) REFERENCES agent_org_runtime_inbox(id) ON DELETE RESTRICT,
            CHECK(parent_inbox_id IS NULL OR parent_inbox_id<>source_inbox_id),
            CHECK(
                (status='pending' AND started_at IS NULL AND terminal_at IS NULL AND failure_reason IS NULL)
                OR
                (status='started' AND started_at IS NOT NULL AND terminal_at IS NULL AND failure_reason IS NULL)
                OR
                (status IN ('completed','cancelled') AND started_at IS NOT NULL AND terminal_at IS NOT NULL)
                OR
                (status IN ('failed','abandoned','unknown') AND terminal_at IS NOT NULL)
            )
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_udw_coordinator_pending
            ON agent_org_runtime_user_directed_coordinator_bindings(binding_id)
            WHERE status='pending';",
    )
}

pub(crate) fn canonical_delivery_digest(
    request: &NewUserDirectedDelivery<'_>,
) -> Result<String, String> {
    let value = serde_json::json!({
        "org_run_id": request.org_run_id,
        "session_id": request.session_id,
        "turn_intent_id": request.turn_intent_id,
        "root_authority_turn_id": request.root_authority_turn_id,
        "parent_delivery_id": request.parent_delivery_id,
        "parent_inbox_id": request.parent_inbox_id,
        "source_kind": request.source_kind.as_str(),
        "source_event_id": request.source_event_id,
        "source_inbox_id": request.source_inbox_id,
        "dispatch_member_id": request.dispatch_member_id,
        "member_dispatch_sequence": request.member_dispatch_sequence,
        "depth": request.depth,
        "delivery_ordinal": request.delivery_ordinal,
        "dispatch_content": request.dispatch_content,
        "display_content": request.display_content,
        "images": request.images.unwrap_or(&[]),
    });
    let encoded = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

pub(crate) fn insert_root_delivery_with_connection(
    conn: &Connection,
    request: &NewUserDirectedDelivery<'_>,
) -> Result<(UserDirectedDeliveryRecord, bool), String> {
    if request.depth != 0
        || request.delivery_ordinal != 1
        || request.root_authority_turn_id != request.turn_intent_id
        || !matches!(
            request.source_kind,
            UserDirectedSourceKind::DirectMember | UserDirectedSourceKind::GroupMention
        )
    {
        return Err("user_directed_root_invalid: root delivery identity is not canonical".into());
    }
    validate_non_empty(request)?;
    let digest = canonical_delivery_digest(request)?;
    if let Some(existing) =
        get_by_turn_with_connection(conn, request.session_id, request.turn_intent_id)?
    {
        if existing.request_digest == digest {
            return Ok((existing, true));
        }
        return Err("user_directed_idempotency_conflict: Turn identity was reused".into());
    }

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_user_directed_roots (
            org_run_id,root_authority_turn_id,policy_version,max_deliveries,
            max_cascade_depth,next_delivery_ordinal,created_at
         ) VALUES (?1,?2,?3,?4,?5,2,?6)
         ON CONFLICT(org_run_id,root_authority_turn_id) DO NOTHING",
        params![
            request.org_run_id,
            request.root_authority_turn_id,
            USER_DIRECTED_POLICY_VERSION,
            DEFAULT_MAX_DELIVERIES_PER_ROOT,
            DEFAULT_MAX_CASCADE_DEPTH,
            &now,
        ],
    )
    .map_err(|error| error.to_string())?;
    insert_delivery(conn, request, &digest, &now)?;
    let record = get_by_turn_with_connection(conn, request.session_id, request.turn_intent_id)?
        .ok_or_else(|| {
            "user_directed_delivery_missing: accepted delivery disappeared".to_string()
        })?;
    Ok((record, false))
}

pub(crate) fn insert_linked_member_delivery_with_connection(
    conn: &Connection,
    request: &NewLinkedMemberDelivery<'_>,
) -> Result<UserDirectedDeliveryRecord, String> {
    let parent = get_by_turn_with_connection(
        conn,
        request.source_session_id,
        request.source_turn_intent_id,
    )?
    .ok_or_else(|| "linked_inbox_stale_source: caller has no UDW delivery".to_string())?;
    if parent.org_run_id != request.org_run_id
        || parent.status != UserDirectedDeliveryStatus::Started
    {
        return Err(
            "linked_inbox_stale_source: caller delivery is not the current started UDW".to_string(),
        );
    }
    let parent_inbox_id = parent.source_inbox_id;
    let root_limits: Option<i64> = conn
        .query_row(
            "SELECT max_cascade_depth
             FROM agent_org_runtime_user_directed_roots
             WHERE org_run_id=?1 AND root_authority_turn_id=?2",
            params![request.org_run_id, &parent.root_authority_turn_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let max_depth = root_limits
        .ok_or_else(|| "linked_inbox_stale_source: root receipt is missing".to_string())?;
    let depth = parent.depth + 1;
    if depth > max_depth {
        return Err(format!(
            "linked_inbox_depth_limit: depth {depth} exceeds root limit {max_depth}"
        ));
    }
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM agent_org_runtime_user_directed_deliveries
             WHERE org_run_id=?1 AND dispatch_member_id=?2
               AND status IN ('pending','started')",
            params![request.org_run_id, request.recipient_member_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if pending >= DEFAULT_MAX_PENDING_PER_MEMBER {
        return Err(format!(
            "user_directed_queue_full: Member {} already has {pending} pending/started deliveries (cap {DEFAULT_MAX_PENDING_PER_MEMBER})",
            request.recipient_member_id
        ));
    }

    let admission =
        crate::coordination::agent_org_turn_contexts::AgentOrgTurnAdmission::member_inbox(
            request.org_run_id,
            request.recipient_session_id,
            request.child_turn_intent_id,
            Some(request.child_turn_intent_id.to_string()),
            request.recipient_member_id,
            request.source_inbox_id,
            &parent.root_authority_turn_id,
        );
    let context =
        crate::coordination::agent_org_turn_contexts::accept_with_connection(conn, &admission)?;
    let sequence = context.member_dispatch_sequence.ok_or_else(|| {
        "agent_org_turn_context_invalid: linked UDW has no Member FIFO sequence".to_string()
    })?;
    let delivery_ordinal: Option<i64> = conn
        .query_row(
            "UPDATE agent_org_runtime_user_directed_roots
             SET next_delivery_ordinal=next_delivery_ordinal+1
             WHERE org_run_id=?1 AND root_authority_turn_id=?2
               AND next_delivery_ordinal<=max_deliveries+1
             RETURNING next_delivery_ordinal-1",
            params![request.org_run_id, &parent.root_authority_turn_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let delivery_ordinal = delivery_ordinal.ok_or_else(|| {
        "linked_inbox_delivery_limit: root delivery budget is exhausted".to_string()
    })?;
    let child = NewUserDirectedDelivery {
        org_run_id: request.org_run_id,
        session_id: request.recipient_session_id,
        turn_intent_id: request.child_turn_intent_id,
        root_authority_turn_id: &parent.root_authority_turn_id,
        parent_delivery_id: Some(parent.delivery_id),
        parent_inbox_id,
        source_kind: UserDirectedSourceKind::MemberInbox,
        source_event_id: None,
        source_inbox_id: Some(request.source_inbox_id),
        dispatch_member_id: request.recipient_member_id,
        member_dispatch_sequence: sequence,
        depth,
        delivery_ordinal,
        dispatch_content: request.dispatch_content,
        display_content: request.display_content,
        images: request.images,
    };
    validate_non_empty(&child)?;
    let digest = canonical_delivery_digest(&child)?;
    let now = chrono::Utc::now().to_rfc3339();
    insert_delivery(conn, &child, &digest, &now)?;
    get_by_turn_with_connection(
        conn,
        request.recipient_session_id,
        request.child_turn_intent_id,
    )?
    .ok_or_else(|| "linked_inbox_delivery_missing: accepted child disappeared".to_string())
}

pub(crate) fn insert_linked_coordinator_delivery_with_connection(
    conn: &Connection,
    request: &NewLinkedCoordinatorDelivery<'_>,
) -> Result<UserDirectedCoordinatorBinding, String> {
    let parent = get_by_turn_with_connection(
        conn,
        request.source_session_id,
        request.source_turn_intent_id,
    )?
    .ok_or_else(|| "linked_inbox_stale_source: caller has no UDW delivery".to_string())?;
    if parent.org_run_id != request.org_run_id
        || parent.status != UserDirectedDeliveryStatus::Started
    {
        return Err(
            "linked_inbox_stale_source: caller delivery is not the current started UDW".to_string(),
        );
    }
    let parent_inbox_id = parent.source_inbox_id;
    let max_depth: Option<i64> = conn
        .query_row(
            "SELECT max_cascade_depth
             FROM agent_org_runtime_user_directed_roots
             WHERE org_run_id=?1 AND root_authority_turn_id=?2",
            params![request.org_run_id, &parent.root_authority_turn_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let max_depth = max_depth
        .ok_or_else(|| "linked_inbox_stale_source: root receipt is missing".to_string())?;
    let depth = parent.depth + 1;
    if depth > max_depth {
        return Err(format!(
            "linked_inbox_depth_limit: depth {depth} exceeds root limit {max_depth}"
        ));
    }
    let delivery_ordinal: Option<i64> = conn
        .query_row(
            "UPDATE agent_org_runtime_user_directed_roots
             SET next_delivery_ordinal=next_delivery_ordinal+1
             WHERE org_run_id=?1 AND root_authority_turn_id=?2
               AND next_delivery_ordinal<=max_deliveries+1
             RETURNING next_delivery_ordinal-1",
            params![request.org_run_id, &parent.root_authority_turn_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let delivery_ordinal = delivery_ordinal.ok_or_else(|| {
        "linked_inbox_delivery_limit: root delivery budget is exhausted".to_string()
    })?;

    let admission =
        crate::coordination::agent_org_turn_contexts::AgentOrgTurnAdmission::coordinator_member_inbox(
            request.org_run_id,
            request.coordinator_session_id,
            request.child_turn_intent_id,
            Some(request.child_turn_intent_id.to_string()),
            request.source_inbox_id,
            &parent.root_authority_turn_id,
        );
    crate::coordination::agent_org_turn_contexts::accept_with_connection(conn, &admission)?;
    let digest_value = serde_json::json!({
        "org_run_id": request.org_run_id,
        "session_id": request.coordinator_session_id,
        "turn_intent_id": request.child_turn_intent_id,
        "root_authority_turn_id": parent.root_authority_turn_id,
        "parent_delivery_id": parent.delivery_id,
        "parent_inbox_id": parent_inbox_id,
        "source_inbox_id": request.source_inbox_id,
        "depth": depth,
        "delivery_ordinal": delivery_ordinal,
        "dispatch_content": request.dispatch_content,
        "display_content": request.display_content,
    });
    let encoded = serde_json::to_vec(&digest_value).map_err(|error| error.to_string())?;
    let digest = format!("{:x}", Sha256::digest(encoded));
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_user_directed_coordinator_bindings (
            org_run_id,session_id,turn_intent_id,root_authority_turn_id,
            parent_delivery_id,parent_inbox_id,source_inbox_id,depth,delivery_ordinal,request_digest,
            dispatch_content,display_content,status,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'pending',?13)",
        params![
            request.org_run_id,
            request.coordinator_session_id,
            request.child_turn_intent_id,
            &parent.root_authority_turn_id,
            parent.delivery_id,
            parent_inbox_id,
            request.source_inbox_id,
            depth,
            delivery_ordinal,
            digest,
            request.dispatch_content,
            request.display_content,
            &now,
        ],
    )
    .map_err(map_constraint_error)?;
    get_coordinator_binding_with_connection(
        conn,
        request.coordinator_session_id,
        request.child_turn_intent_id,
    )?
    .ok_or_else(|| "linked_coordinator_binding_missing: accepted binding disappeared".to_string())
}

fn get_coordinator_binding_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<UserDirectedCoordinatorBinding>, String> {
    conn.query_row(
        "SELECT org_run_id,session_id,turn_intent_id,root_authority_turn_id,
                source_inbox_id,depth,delivery_ordinal,status
         FROM agent_org_runtime_user_directed_coordinator_bindings
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![session_id, turn_intent_id],
        |row| {
            let status_raw: String = row.get(7)?;
            let status = UserDirectedDeliveryStatus::parse(&status_raw)
                .ok_or(rusqlite::Error::InvalidQuery)?;
            Ok(UserDirectedCoordinatorBinding {
                org_run_id: row.get(0)?,
                session_id: row.get(1)?,
                turn_intent_id: row.get(2)?,
                root_authority_turn_id: row.get(3)?,
                source_inbox_id: row.get(4)?,
                depth: row.get(5)?,
                delivery_ordinal: row.get(6)?,
                status,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn insert_delivery(
    conn: &Connection,
    request: &NewUserDirectedDelivery<'_>,
    digest: &str,
    now: &str,
) -> Result<(), String> {
    let images_json =
        serde_json::to_string(request.images.unwrap_or(&[])).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO agent_org_runtime_user_directed_deliveries (
            org_run_id,session_id,turn_intent_id,root_authority_turn_id,
            parent_delivery_id,parent_inbox_id,source_kind,source_event_id,source_inbox_id,
            dispatch_member_id,member_dispatch_sequence,depth,delivery_ordinal,
            request_digest,dispatch_content,display_content,images_json,status,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'pending',?18)",
        params![
            request.org_run_id,
            request.session_id,
            request.turn_intent_id,
            request.root_authority_turn_id,
            request.parent_delivery_id,
            request.parent_inbox_id,
            request.source_kind.as_str(),
            request.source_event_id,
            request.source_inbox_id,
            request.dispatch_member_id,
            request.member_dispatch_sequence,
            request.depth,
            request.delivery_ordinal,
            digest,
            request.dispatch_content,
            request.display_content,
            images_json,
            now,
        ],
    )
    .map_err(map_constraint_error)?;
    Ok(())
}

pub(crate) fn get_by_turn_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<UserDirectedDeliveryRecord>, String> {
    conn.query_row(
        "SELECT delivery_id,org_run_id,session_id,turn_intent_id,
                root_authority_turn_id,parent_delivery_id,parent_inbox_id,source_kind,source_event_id,
                source_inbox_id,dispatch_member_id,member_dispatch_sequence,depth,
                delivery_ordinal,request_digest,status
         FROM agent_org_runtime_user_directed_deliveries
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![session_id, turn_intent_id],
        row_to_delivery,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn status_by_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<UserDirectedDeliveryStatus>, String> {
    let conn = get_connection().map_err(|error| error.to_string())?;
    if let Some(record) = get_by_turn_with_connection(&conn, session_id, turn_intent_id)? {
        return Ok(Some(record.status));
    }
    Ok(
        get_coordinator_binding_with_connection(&conn, session_id, turn_intent_id)?
            .map(|binding| binding.status),
    )
}

pub(crate) fn causal_reply_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<UserDirectedCausalReply>, String> {
    let conn = get_connection().map_err(|error| error.to_string())?;
    if let Some(record) = get_by_turn_with_connection(&conn, session_id, turn_intent_id)? {
        return Ok(Some(UserDirectedCausalReply {
            source_kind: record.source_kind.as_str().to_string(),
            source_inbox_id: record.source_inbox_id,
            parent_inbox_id: record.parent_inbox_id,
            root_authority_turn_id: record.root_authority_turn_id,
            depth: record.depth,
            delivery_ordinal: record.delivery_ordinal,
        }));
    }
    conn.query_row(
        "SELECT source_inbox_id,parent_inbox_id,root_authority_turn_id,
                depth,delivery_ordinal
         FROM agent_org_runtime_user_directed_coordinator_bindings
         WHERE session_id=?1 AND turn_intent_id=?2",
        params![session_id, turn_intent_id],
        |row| {
            Ok(UserDirectedCausalReply {
                source_kind: UserDirectedSourceKind::MemberInbox.as_str().to_string(),
                source_inbox_id: Some(row.get(0)?),
                parent_inbox_id: row.get(1)?,
                root_authority_turn_id: row.get(2)?,
                depth: row.get(3)?,
                delivery_ordinal: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

/// Atomically claim the exact pending UDW delivery immediately before
/// Provider execution. The scheduler remains the runtime owner; this ledger
/// prevents a stale or replayed scheduler callback from starting side effects.
pub(crate) fn mark_turn_started_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<bool, String> {
    let Some(record) = get_by_turn_with_connection(conn, session_id, turn_intent_id)? else {
        let binding = get_coordinator_binding_with_connection(conn, session_id, turn_intent_id)?
            .ok_or_else(|| {
                "user_directed_stale_source: delivery/binding receipt is missing".to_string()
            })?;
        if binding.status != UserDirectedDeliveryStatus::Pending {
            return Ok(false);
        }
        let changed = conn
            .execute(
                "UPDATE agent_org_runtime_user_directed_coordinator_bindings AS binding
                 SET status='started',started_at=?3
                 WHERE binding.session_id=?1 AND binding.turn_intent_id=?2
                   AND binding.status='pending'
                   AND NOT EXISTS (
                       SELECT 1
                       FROM agent_org_runtime_user_directed_coordinator_bindings earlier
                       WHERE earlier.org_run_id=binding.org_run_id
                         AND earlier.binding_id<binding.binding_id
                         AND earlier.status IN ('pending','started')
                   )",
                params![session_id, turn_intent_id, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            requeue_running_turn_intent(conn, session_id, turn_intent_id)?;
        }
        if changed == 1 {
            claim_exact_source_inbox(
                conn,
                &binding.org_run_id,
                binding.source_inbox_id,
                crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID,
            )?;
        }
        return Ok(changed == 1);
    };
    if record.status != UserDirectedDeliveryStatus::Pending {
        return Ok(false);
    }
    if !crate::coordination::agent_org_turn_contexts::member_dispatch_is_fifo_head_with_connection(
        conn,
        &record.org_run_id,
        &record.dispatch_member_id,
        record.member_dispatch_sequence,
        record.source_kind == UserDirectedSourceKind::DirectMember,
    )? {
        requeue_running_turn_intent(conn, session_id, turn_intent_id)?;
        return Ok(false);
    }

    let now = chrono::Utc::now().to_rfc3339();
    let changed = conn
        .execute(
            "UPDATE agent_org_runtime_user_directed_deliveries AS delivery
             SET status='started',started_at=?3
             WHERE delivery.session_id=?1 AND delivery.turn_intent_id=?2
               AND delivery.status='pending'
               AND NOT EXISTS (
                   SELECT 1
                   FROM agent_org_runtime_user_directed_deliveries earlier
                   WHERE earlier.org_run_id=delivery.org_run_id
                     AND earlier.dispatch_member_id=delivery.dispatch_member_id
                     AND earlier.member_dispatch_sequence<delivery.member_dispatch_sequence
                     AND earlier.status IN ('pending','started')
               )",
            params![session_id, turn_intent_id, &now],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        requeue_running_turn_intent(conn, session_id, turn_intent_id)?;
        return Ok(false);
    }

    if record.source_kind == UserDirectedSourceKind::DirectMember
        && !crate::coordination::agent_member_interventions::AgentMemberInterventionStore::mark_turn_running_with_connection(
            conn,
            session_id,
            turn_intent_id,
        )?
    {
        conn.execute(
            "UPDATE agent_org_runtime_user_directed_deliveries
             SET status='pending',started_at=NULL
             WHERE session_id=?1 AND turn_intent_id=?2 AND status='started'",
            params![session_id, turn_intent_id],
        )
        .map_err(|error| error.to_string())?;
        return Ok(false);
    }
    if let Some(source_inbox_id) = record.source_inbox_id {
        claim_exact_source_inbox(
            conn,
            &record.org_run_id,
            source_inbox_id,
            &record.dispatch_member_id,
        )?;
    }
    Ok(true)
}

fn requeue_running_turn_intent(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE session_turn_intents SET status='queued',updated_at=?3
         WHERE session_id=?1 AND turn_intent_id=?2 AND status='running'",
        params![session_id, turn_intent_id, chrono::Utc::now().to_rfc3339()],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn claim_exact_source_inbox(
    conn: &Connection,
    org_run_id: &str,
    source_inbox_id: i64,
    recipient_member_id: &str,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE agent_org_runtime_inbox
             SET read_at=COALESCE(read_at,?4)
             WHERE id=?1 AND org_run_id=?2 AND recipient_member_id=?3
               AND delivery_class='user_directed'",
            params![
                source_inbox_id,
                org_run_id,
                recipient_member_id,
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err(
            "user_directed_stale_source: exact source Inbox is missing or changed".to_string(),
        );
    }
    Ok(())
}

pub(crate) fn mark_turn_terminal(
    session_id: &str,
    turn_intent_id: &str,
    status: UserDirectedDeliveryStatus,
    failure_reason: Option<&str>,
) -> Result<bool, String> {
    if !matches!(
        status,
        UserDirectedDeliveryStatus::Completed
            | UserDirectedDeliveryStatus::Failed
            | UserDirectedDeliveryStatus::Cancelled
            | UserDirectedDeliveryStatus::Abandoned
            | UserDirectedDeliveryStatus::Unknown
    ) {
        return Err("user_directed_terminal_invalid: status is not terminal".to_string());
    }
    let (changed, org_run_id) = with_sessions_writer(|| {
        let mut conn = get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let member_record = get_by_turn_with_connection(&tx, session_id, turn_intent_id)?;
        if member_record.is_none() {
            let binding = get_coordinator_binding_with_connection(&tx, session_id, turn_intent_id)?
                .ok_or_else(|| {
                    "user_directed_stale_source: delivery/binding receipt is missing".to_string()
                })?;
            if matches!(
                binding.status,
                UserDirectedDeliveryStatus::Completed
                    | UserDirectedDeliveryStatus::Failed
                    | UserDirectedDeliveryStatus::Cancelled
                    | UserDirectedDeliveryStatus::Abandoned
                    | UserDirectedDeliveryStatus::Unknown
            ) {
                if binding.status != status {
                    return Err(
                        "user_directed_terminal_conflict: terminal status changed on replay"
                            .to_string(),
                    );
                }
                tx.commit().map_err(|error| error.to_string())?;
                return Ok((false, binding.org_run_id));
            }
            let now = chrono::Utc::now().to_rfc3339();
            let changed = tx
                .execute(
                    "UPDATE agent_org_runtime_user_directed_coordinator_bindings
                     SET status=?3,started_at=COALESCE(started_at,?4),terminal_at=?4,
                         failure_reason=?5
                     WHERE session_id=?1 AND turn_intent_id=?2
                       AND status IN ('pending','started')",
                    params![
                        session_id,
                        turn_intent_id,
                        status.as_str(),
                        &now,
                        failure_reason,
                    ],
                )
                .map_err(|error| error.to_string())?;
            if changed != 1 {
                return Err(
                    "user_directed_terminal_conflict: Coordinator binding changed concurrently"
                        .to_string(),
                );
            }
            let intent_status = match status {
                UserDirectedDeliveryStatus::Completed => "completed",
                UserDirectedDeliveryStatus::Cancelled => "cancelled",
                UserDirectedDeliveryStatus::Failed
                | UserDirectedDeliveryStatus::Abandoned
                | UserDirectedDeliveryStatus::Unknown => "failed",
                _ => unreachable!("validated terminal status"),
            };
            tx.execute(
                "UPDATE session_turn_intents SET status=?3,updated_at=?4
                 WHERE session_id=?1 AND turn_intent_id=?2
                   AND status IN ('queued','running')",
                params![session_id, turn_intent_id, intent_status, &now],
            )
            .map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            return Ok((true, binding.org_run_id));
        }
        let record = member_record.expect("checked member delivery above");
        if matches!(
            record.status,
            UserDirectedDeliveryStatus::Completed
                | UserDirectedDeliveryStatus::Failed
                | UserDirectedDeliveryStatus::Cancelled
                | UserDirectedDeliveryStatus::Abandoned
                | UserDirectedDeliveryStatus::Unknown
        ) {
            if record.status != status {
                return Err(
                    "user_directed_terminal_conflict: terminal status changed on replay"
                        .to_string(),
                );
            }
            tx.commit().map_err(|error| error.to_string())?;
            return Ok((false, record.org_run_id));
        }

        let now = chrono::Utc::now().to_rfc3339();
        let changed = tx
            .execute(
                "UPDATE agent_org_runtime_user_directed_deliveries
                 SET status=?3,started_at=COALESCE(started_at,?4),terminal_at=?4,
                     failure_reason=?5
                 WHERE session_id=?1 AND turn_intent_id=?2
                   AND status IN ('pending','started')",
                params![
                    session_id,
                    turn_intent_id,
                    status.as_str(),
                    &now,
                    failure_reason,
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("user_directed_terminal_conflict: delivery changed concurrently".into());
        }

        let intent_status = match status {
            UserDirectedDeliveryStatus::Completed => "completed",
            UserDirectedDeliveryStatus::Cancelled => "cancelled",
            UserDirectedDeliveryStatus::Failed
            | UserDirectedDeliveryStatus::Abandoned
            | UserDirectedDeliveryStatus::Unknown => "failed",
            _ => unreachable!("validated terminal status"),
        };
        tx.execute(
            "UPDATE session_turn_intents
             SET status=?3,updated_at=?4
             WHERE session_id=?1 AND turn_intent_id=?2
               AND status IN ('queued','running')",
            params![session_id, turn_intent_id, intent_status, &now],
        )
        .map_err(|error| error.to_string())?;

        if record.source_kind == UserDirectedSourceKind::DirectMember {
            let direct_status = match status {
                UserDirectedDeliveryStatus::Unknown => "abandoned",
                _ => status.as_str(),
            };
            crate::coordination::agent_member_interventions::update_chain_status_with_connection(
                &tx,
                session_id,
                turn_intent_id,
                direct_status,
                failure_reason,
            )?;
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok((true, record.org_run_id))
    })?;

    if changed {
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&org_run_id);
    }
    Ok(changed)
}

/// Return the next durable UDW FIFO item after any Agent Org Turn on the same
/// runtime finishes. This closes commit-before-kick holes in both directions:
/// a formal Task/Root Turn can release queued UDW, and a UDW Turn can release
/// the next UDW before the formal Inbox wake is rechecked.
pub(crate) fn next_pending_after_terminal(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<RecoverableUserDirectedDispatch>, String> {
    let conn = get_connection().map_err(|error| error.to_string())?;
    let owner: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT org_run_id,participant_id,dispatch_member_id
             FROM agent_org_runtime_turn_contexts
             WHERE session_id=?1 AND turn_intent_id=?2",
            params![session_id, turn_intent_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((org_run_id, participant_id, dispatch_member_id)) = owner else {
        return Ok(None);
    };
    let raw: Option<(String, String, String, String, String, String, String)> =
        if let Some(dispatch_member_id) = dispatch_member_id {
            conn.query_row(
                "SELECT delivery.org_run_id,delivery.dispatch_member_id,
                        delivery.session_id,delivery.turn_intent_id,
                        delivery.dispatch_content,delivery.display_content,
                        delivery.images_json
                 FROM agent_org_runtime_user_directed_deliveries delivery
                 JOIN agent_org_runtime_turn_contexts context
                   ON context.session_id=delivery.session_id
                  AND context.turn_intent_id=delivery.turn_intent_id
                 JOIN session_turn_intents intent
                   ON intent.session_id=delivery.session_id
                  AND intent.turn_intent_id=delivery.turn_intent_id
                 JOIN agent_org_runtime_runs run ON run.id=delivery.org_run_id
                 WHERE delivery.org_run_id=?1
                   AND delivery.dispatch_member_id=?2
                   AND delivery.status='pending'
                   AND context.turn_kind='user_directed_work'
                   AND intent.status='queued'
                   AND run.status IN ('running','idle','paused')
                 ORDER BY delivery.member_dispatch_sequence,delivery.delivery_id
                 LIMIT 1",
                params![org_run_id, dispatch_member_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?
        } else if participant_id == crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID {
            conn.query_row(
                "SELECT binding.org_run_id,'coordinator',binding.session_id,
                        binding.turn_intent_id,binding.dispatch_content,
                        binding.display_content,'[]'
                 FROM agent_org_runtime_user_directed_coordinator_bindings binding
                 JOIN agent_org_runtime_turn_contexts context
                   ON context.session_id=binding.session_id
                  AND context.turn_intent_id=binding.turn_intent_id
                 JOIN session_turn_intents intent
                   ON intent.session_id=binding.session_id
                  AND intent.turn_intent_id=binding.turn_intent_id
                 JOIN agent_org_runtime_runs run ON run.id=binding.org_run_id
                 WHERE binding.org_run_id=?1 AND binding.status='pending'
                   AND context.turn_kind='coordinator'
                   AND context.source_kind='member_inbox'
                   AND intent.status='queued'
                   AND run.status IN ('running','idle','paused')
                 ORDER BY binding.binding_id
                 LIMIT 1",
                [&org_run_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?
        } else {
            None
        };
    let Some((
        org_run_id,
        recipient_member_id,
        recipient_session_id,
        next_turn_intent_id,
        content,
        display_text,
        images_json,
    )) = raw
    else {
        return Ok(None);
    };
    let images: Vec<String> =
        serde_json::from_str(&images_json).map_err(|error| error.to_string())?;
    Ok(Some(RecoverableUserDirectedDispatch {
        recovery_key: String::new(),
        org_run_id,
        recipient_member_id,
        recipient_session_id,
        turn_intent_id: next_turn_intent_id,
        content,
        display_text,
        images: (!images.is_empty()).then_some(images),
    }))
}

pub(crate) fn dispatch_owner_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<(String, String)>, String> {
    let conn = get_connection().map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT org_run_id,dispatch_member_id
         FROM agent_org_runtime_turn_contexts
         WHERE session_id=?1 AND turn_intent_id=?2
           AND dispatch_member_id IS NOT NULL",
        params![session_id, turn_intent_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn row_to_delivery(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserDirectedDeliveryRecord> {
    let source_raw: String = row.get(7)?;
    let status_raw: String = row.get(15)?;
    let source_kind = match source_raw.as_str() {
        "direct_member" => UserDirectedSourceKind::DirectMember,
        "group_mention" => UserDirectedSourceKind::GroupMention,
        "member_inbox" => UserDirectedSourceKind::MemberInbox,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    let status =
        UserDirectedDeliveryStatus::parse(&status_raw).ok_or(rusqlite::Error::InvalidQuery)?;
    Ok(UserDirectedDeliveryRecord {
        delivery_id: row.get(0)?,
        org_run_id: row.get(1)?,
        session_id: row.get(2)?,
        turn_intent_id: row.get(3)?,
        root_authority_turn_id: row.get(4)?,
        parent_delivery_id: row.get(5)?,
        parent_inbox_id: row.get(6)?,
        source_kind,
        source_event_id: row.get(8)?,
        source_inbox_id: row.get(9)?,
        dispatch_member_id: row.get(10)?,
        member_dispatch_sequence: row.get(11)?,
        depth: row.get(12)?,
        delivery_ordinal: row.get(13)?,
        request_digest: row.get(14)?,
        status,
    })
}

fn validate_non_empty(request: &NewUserDirectedDelivery<'_>) -> Result<(), String> {
    if request.org_run_id.trim().is_empty()
        || request.session_id.trim().is_empty()
        || request.turn_intent_id.trim().is_empty()
        || request.root_authority_turn_id.trim().is_empty()
        || request.dispatch_member_id.trim().is_empty()
        || request.dispatch_content.trim().is_empty()
        || request.display_content.trim().is_empty()
        || request.member_dispatch_sequence < 1
    {
        return Err("user_directed_delivery_invalid: required value is empty".into());
    }
    Ok(())
}

fn map_constraint_error(error: rusqlite::Error) -> String {
    if let rusqlite::Error::SqliteFailure(code, _) = &error {
        if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
            || code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
        {
            return "user_directed_idempotency_conflict: durable identity already exists".into();
        }
    }
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_rejects_invalid_source_combinations() {
        let conn = Connection::open_in_memory().expect("open database");
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE agent_org_runtime_runs(id TEXT PRIMARY KEY);
             CREATE TABLE agent_org_runtime_inbox(id INTEGER PRIMARY KEY);
             CREATE TABLE agent_org_runtime_turn_contexts(
                session_id TEXT NOT NULL, turn_intent_id TEXT NOT NULL,
                UNIQUE(session_id,turn_intent_id)
             );",
        )
        .expect("create dependencies");
        create_schema(&conn).expect("create UDW schema");
        conn.execute("INSERT INTO agent_org_runtime_runs(id) VALUES ('run')", [])
            .expect("insert run");
        conn.execute(
            "INSERT INTO agent_org_runtime_turn_contexts(session_id,turn_intent_id)
             VALUES ('session','turn')",
            [],
        )
        .expect("insert context");
        conn.execute(
            "INSERT INTO agent_org_runtime_user_directed_roots(
                org_run_id,root_authority_turn_id,policy_version,max_deliveries,
                max_cascade_depth,next_delivery_ordinal,created_at
             ) VALUES ('run','turn',1,8,2,2,'now')",
            [],
        )
        .expect("insert root");
        let error = conn
            .execute(
                "INSERT INTO agent_org_runtime_user_directed_deliveries(
                    org_run_id,session_id,turn_intent_id,root_authority_turn_id,
                    source_kind,source_event_id,dispatch_member_id,
                    member_dispatch_sequence,depth,delivery_ordinal,request_digest,
                    dispatch_content,display_content,status,created_at
                 ) VALUES ('run','session','turn','turn','group_mention','event',
                           'member',1,0,1,?1,'body','body','pending','now')",
                [&"a".repeat(64)],
            )
            .expect_err("invalid Group source must fail");
        assert!(matches!(error, rusqlite::Error::SqliteFailure(_, _)));
    }
}
