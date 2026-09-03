//! Write path for [`AgentInboxStore`]: message persistence, run-gated and
//! causation-idempotent inserts, and the shared transactional insert core.

use rusqlite::{params, Connection, OptionalExtension};

use crate::coordination::agent_org_payload_limits as limits;
use database::db::{get_connection, with_sessions_writer};

use super::record::row_to_record;
use super::{AgentInboxRecord, AgentInboxStore, InsertInboxParams};

impl AgentInboxStore {
    /// Resolve formal coordination rows that became impossible to execute
    /// while their Member's exact Provider Turn was still running.
    ///
    /// Writer cancellation/reassignment deliberately does not stop an old
    /// TaskExecution. Coordinator messages sent while that Turn is active are
    /// therefore persisted but cannot be drained until the Member becomes
    /// idle. If every Task owned by the Member is terminal or reassigned at
    /// that boundary, a new formal wake has no Task authority to bind to. Keep
    /// the original rows unread for audit, but record a lifecycle-owned
    /// cancellation so they no longer cause an impossible wake loop or block
    /// Team Quiescence forever.
    ///
    /// This is intentionally limited to formal message classes. User-directed
    /// Inbox rows have their own exact
    /// source authority and must never be swept by this fallback.
    pub(crate) fn resolve_obsolete_formal_rows_after_successful_member_turn(
        org_run_id: &str,
        member_id: &str,
    ) -> Result<usize, String> {
        const REASON: &str = "member_turn_finished_without_owned_formal_work";

        let resolved = with_sessions_writer(|| -> Result<usize, String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let has_owned_open_work: bool = tx
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM agent_org_runtime_tasks
                         WHERE org_run_id=?1 AND owner=?2
                           AND status IN ('pending','in_progress')
                     )",
                    params![org_run_id, member_id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;
            if has_owned_open_work {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(0);
            }

            let now = chrono::Utc::now().to_rfc3339();
            let resolved = tx
                .execute(
                    "INSERT OR IGNORE INTO agent_org_runtime_inbox_delivery_resolutions (
                         inbox_id,org_run_id,resolution_kind,resolved_by_member_id,reason,
                         replacement_inbox_id,replacement_task_id,created_at
                     )
                     SELECT inbox.id,inbox.org_run_id,'cancelled','system:lifecycle',
                            ?3,NULL,NULL,?4
                     FROM agent_org_runtime_inbox inbox
                     WHERE inbox.org_run_id=?1
                       AND inbox.recipient_member_id=?2
                       AND inbox.delivery_class='formal_work'
                       AND inbox.read_at IS NULL
                       AND inbox.payload_kind IN (
                           'plain','task_assigned','plan_approval_response','shutdown_request'
                       )
                       AND NOT EXISTS (
                           SELECT 1
                           FROM agent_org_runtime_inbox_delivery_resolutions resolution
                           WHERE resolution.inbox_id=inbox.id
                       )",
                    params![org_run_id, member_id, REASON, &now],
                )
                .map_err(|err| err.to_string())?;
            tx.execute(
                "DELETE FROM agent_org_runtime_inbox_materializations
                 WHERE inbox_id IN (
                     SELECT resolution.inbox_id
                     FROM agent_org_runtime_inbox_delivery_resolutions resolution
                     JOIN agent_org_runtime_inbox inbox ON inbox.id=resolution.inbox_id
                     WHERE resolution.org_run_id=?1
                       AND resolution.reason=?3
                       AND inbox.recipient_member_id=?2
                 )",
                params![org_run_id, member_id, REASON],
            )
            .map_err(|err| err.to_string())?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(resolved)
        })?;

        if resolved > 0 {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(org_run_id);
        }
        Ok(resolved)
    }

    /// Persist a message and return the inserted record. The caller is
    /// responsible for resolving display-name / broadcast targets to one or
    /// more concrete `AgentId`s before calling this — the store does not
    /// fan out by itself. The router owns that resolution.
    pub fn insert(params: InsertInboxParams) -> Result<AgentInboxRecord, String> {
        let changed_org_run_id = params.org_run_id.clone();
        let record = with_sessions_writer(|| -> Result<AgentInboxRecord, String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            Self::insert_in_tx(&conn, params)
        })?;
        if let Some(org_run_id) = changed_org_run_id {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&org_run_id);
        }
        Ok(record)
    }

    /// Persist a lifecycle-owned `MemberIdle` row and, in the same
    /// transaction, create a FormalTriggerReceipt only when the fact requires
    /// Coordinator action.
    ///
    /// Ordinary availability remains durable history without Provider work.
    /// A failed/unfinished member or the final worker boundary after every
    /// Task became terminal is actionable: the latter gives the Coordinator
    /// a fresh completion-candidate snapshot after the worker Turn itself has
    /// actually ended.
    pub(crate) fn insert_member_idle_if_run_running(
        params: InsertInboxParams,
    ) -> Result<Option<(AgentInboxRecord, bool)>, String> {
        let (member_id, reason, unfinished_task_ids) = match &params.message {
            super::AgentMessage::MemberIdle {
                member_id,
                reason,
                unfinished_task_ids,
                ..
            } => (
                member_id.clone(),
                reason.clone(),
                unfinished_task_ids.clone(),
            ),
            _ => {
                return Err(
                    "insert_member_idle_if_run_running requires MemberIdle payload".to_string(),
                )
            }
        };
        let run_id = params
            .org_run_id
            .as_deref()
            .ok_or_else(|| "insert_member_idle_if_run_running requires org_run_id".to_string())?
            .to_string();

        with_sessions_writer(|| -> Result<Option<(AgentInboxRecord, bool)>, String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let activation_generation: Option<i64> = tx
                .query_row(
                    "SELECT activation_generation
                     FROM agent_org_runtime_runs
                     WHERE id=?1 AND status='running'",
                    params![&run_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|err| err.to_string())?;
            let Some(activation_generation) = activation_generation else {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(None);
            };

            // The specialized owner below supplies the exact lifecycle
            // authority, so the generic Inbox metadata inference must not
            // create a second receipt for Failed MemberIdle.
            let record = Self::insert_in_tx_without_formal_trigger(&tx, params)?;
            let (task_count, open_task_count): (i64, i64) = tx
                .query_row(
                    "SELECT COUNT(*),
                            COALESCE(SUM(CASE WHEN status IN ('pending','in_progress')
                                              THEN 1 ELSE 0 END),0)
                     FROM agent_org_runtime_tasks
                     WHERE org_run_id=?1 AND activation_generation=?2",
                    params![&run_id, activation_generation],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|err| err.to_string())?;
            let all_tasks_terminal = task_count > 0 && open_task_count == 0;
            let actionable = matches!(reason, super::MemberIdleReason::Failed)
                || !unfinished_task_ids.is_empty()
                || all_tasks_terminal;

            if actionable {
                let task_id = if let Some(task_id) = unfinished_task_ids.first() {
                    Some(task_id.clone())
                } else {
                    tx.query_row(
                        "SELECT id
                         FROM agent_org_runtime_tasks
                         WHERE org_run_id=?1 AND activation_generation=?2 AND owner=?3
                         ORDER BY updated_at DESC,id DESC LIMIT 1",
                        params![&run_id, activation_generation, &member_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|err| err.to_string())?
                };
                let source_turn_intent_id = tx
                    .query_row(
                        "SELECT context.turn_intent_id
                         FROM agent_org_runtime_turn_contexts context
                         JOIN session_turn_intents intent
                           ON intent.session_id=context.session_id
                          AND intent.turn_intent_id=context.turn_intent_id
                         WHERE context.org_run_id=?1
                           AND context.participant_id=?2
                           AND context.turn_kind='task_execution'
                           AND intent.status IN (?3,?4,?5)
                         ORDER BY context.created_at DESC,context.turn_intent_id DESC
                         LIMIT 1",
                        params![
                            &run_id,
                            &member_id,
                            crate::foundation::session_bridge::IN_FLIGHT_TURN_INTENT_STATUSES[0],
                            crate::foundation::session_bridge::IN_FLIGHT_TURN_INTENT_STATUSES[1],
                            crate::foundation::session_bridge::IN_FLIGHT_TURN_INTENT_STATUSES[2],
                        ],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|err| err.to_string())?;
                let source_kind = if matches!(reason, super::MemberIdleReason::Failed) {
                    "task_failure"
                } else {
                    "formal_lifecycle"
                };
                crate::coordination::agent_org_formal_triggers::record_inbox_trigger_in_tx(
                    &tx,
                    &run_id,
                    record.id,
                    crate::coordination::agent_org_formal_triggers::InboxFormalTriggerSource {
                        source_kind,
                        task_id: task_id.as_deref(),
                        owner_member_id: Some(&member_id),
                        source_turn_intent_id: source_turn_intent_id.as_deref(),
                        task_output_digest: None,
                        plan_revision_id: None,
                        suppress_self_wake: false,
                    },
                )?;
            }

            tx.commit().map_err(|err| err.to_string())?;
            Ok(Some((record, actionable)))
        })
    }

    /// Persist a system-derived message at most once for a source inbox row.
    ///
    /// Inbox drain deliberately leaves source rows unread until the turn has
    /// been durably committed. A crash in that window replays the source row.
    /// `causation_inbox_id` makes the derived notification idempotent across
    /// that replay without making ordinary messages globally deduplicated.
    pub fn insert_once_for_causation(
        params: InsertInboxParams,
        causation_inbox_id: i64,
    ) -> Result<(AgentInboxRecord, bool), String> {
        if causation_inbox_id <= 0 {
            return Err("causation_inbox_id must be a positive inbox row id".into());
        }
        with_sessions_writer(|| -> Result<(AgentInboxRecord, bool), String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            Self::insert_in_tx_with_causation(&conn, params, Some(causation_inbox_id), true)
        })
    }

    /// Insert an inbox row using an existing writer transaction.
    ///
    /// This keeps state transitions such as "plan changes requested" and
    /// their durable feedback delivery atomic: a caller cannot commit the
    /// state change while losing the message that explains it.
    pub(crate) fn insert_in_tx(
        conn: &Connection,
        params: InsertInboxParams,
    ) -> Result<AgentInboxRecord, String> {
        Self::insert_in_tx_with_causation(conn, params, None, true)
            .map(|(record, _inserted)| record)
    }

    /// Insert a structured projection while the owning business transaction
    /// records its FormalTriggerReceipt explicitly. This is reserved for
    /// facts whose receipt must bind extra authority such as the exact source
    /// Turn or TaskOutput digest; the generic Inbox writer cannot infer those
    /// fields from transport metadata.
    pub(crate) fn insert_in_tx_without_formal_trigger(
        conn: &Connection,
        params: InsertInboxParams,
    ) -> Result<AgentInboxRecord, String> {
        Self::insert_in_tx_with_causation(conn, params, None, false)
            .map(|(record, _inserted)| record)
    }

    /// Insert an idempotent derived Inbox projection while leaving formal
    /// trigger creation to the owning business transaction. Task assignment
    /// uses this for the Coordinator-facing observation row so the receipt can
    /// carry the exact owner and source Turn instead of inferring either from
    /// transport metadata.
    pub(crate) fn insert_in_tx_for_causation_without_formal_trigger(
        conn: &Connection,
        params: InsertInboxParams,
        causation_inbox_id: i64,
    ) -> Result<(AgentInboxRecord, bool), String> {
        if causation_inbox_id <= 0 {
            return Err("causation_inbox_id must be a positive inbox row id".into());
        }
        Self::insert_in_tx_with_causation(conn, params, Some(causation_inbox_id), false)
    }

    fn insert_in_tx_with_causation(
        conn: &Connection,
        params: InsertInboxParams,
        causation_inbox_id: Option<i64>,
        create_formal_trigger: bool,
    ) -> Result<(AgentInboxRecord, bool), String> {
        limits::validate_required_text(
            "recipient_agent_id",
            &params.recipient_agent_id,
            limits::MESSAGE_IDENTIFIER_MAX_CHARS,
            limits::MESSAGE_IDENTIFIER_MAX_BYTES,
        )?;
        limits::validate_required_text(
            "sender_agent_id",
            &params.sender_agent_id,
            limits::MESSAGE_IDENTIFIER_MAX_CHARS,
            limits::MESSAGE_IDENTIFIER_MAX_BYTES,
        )?;
        for (field, value) in [
            ("recipient_member_id", params.recipient_member_id.as_deref()),
            ("sender_member_id", params.sender_member_id.as_deref()),
            ("org_run_id", params.org_run_id.as_deref()),
        ] {
            if let Some(value) = value {
                limits::validate_required_text(
                    field,
                    value,
                    limits::MESSAGE_IDENTIFIER_MAX_CHARS,
                    limits::MESSAGE_IDENTIFIER_MAX_BYTES,
                )?;
            }
        }
        if params.org_run_id.is_some() && params.recipient_member_id.is_none() {
            return Err(
                "Agent Org Inbox rows require recipient_member_id; legacy agent-only rows are read-only"
                    .to_string(),
            );
        }
        if let Some(org_run_id) = params.org_run_id.as_deref() {
            let status: Option<String> = conn
                .query_row(
                    "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
                    [org_run_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if status.as_deref() == Some("archived") {
                return Err(crate::coordination::agent_org_runs::mutation_blocked_error(
                    org_run_id, "archived",
                ));
            }
        }
        params.message.validate()?;

        let kind = params.message.kind_tag().to_string();
        let request_id = params.message.request_id().map(|r| r.0.clone());
        let payload_json = serde_json::to_string(&params.message)
            .map_err(|err| format!("serialize AgentMessage failed: {err}"))?;
        if payload_json.len() > limits::AGENT_INBOX_PAYLOAD_MAX_BYTES {
            return Err(format!(
                "Agent Inbox payload must be <= {} serialized bytes (got {} bytes)",
                limits::AGENT_INBOX_PAYLOAD_MAX_BYTES,
                payload_json.len()
            ));
        }
        let now = chrono::Utc::now().to_rfc3339();

        let insert_sql = if causation_inbox_id.is_some() {
            "INSERT OR IGNORE INTO agent_org_runtime_inbox (
                    recipient_agent_id,
                    recipient_member_id,
                    sender_agent_id,
                    sender_member_id,
                    org_run_id,
                    payload_kind,
                    payload_json,
                    request_id,
                    created_at,
                    read_at,
                    causation_inbox_id
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)"
        } else {
            "INSERT INTO agent_org_runtime_inbox (
                    recipient_agent_id,
                    recipient_member_id,
                    sender_agent_id,
                    sender_member_id,
                    org_run_id,
                    payload_kind,
                    payload_json,
                    request_id,
                    created_at,
                    read_at,
                    causation_inbox_id
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)"
        };
        let inserted = conn
            .execute(
                insert_sql,
                params![
                    &params.recipient_agent_id,
                    params.recipient_member_id.as_deref(),
                    &params.sender_agent_id,
                    params.sender_member_id.as_deref(),
                    params.org_run_id.as_deref(),
                    &kind,
                    &payload_json,
                    request_id.as_deref(),
                    &now,
                    causation_inbox_id,
                ],
            )
            .map_err(|err| err.to_string())?;

        if inserted == 0 {
            let source_id = causation_inbox_id.ok_or_else(|| {
                "ordinary Agent Inbox insert unexpectedly affected zero rows".to_string()
            })?;
            let existing = conn
                .query_row(
                    "SELECT id,
                            recipient_agent_id,
                            recipient_member_id,
                            sender_agent_id,
                            sender_member_id,
                            org_run_id,
                            payload_kind,
                            payload_json,
                            request_id,
                            created_at,
                            read_at
                     FROM agent_org_runtime_inbox
                     WHERE causation_inbox_id = ?1
                       AND payload_kind = ?2
                       AND recipient_agent_id = ?3
                       AND COALESCE(recipient_member_id, '') = COALESCE(?4, '')
                     LIMIT 1",
                    params![
                        source_id,
                        &kind,
                        &params.recipient_agent_id,
                        params.recipient_member_id.as_deref(),
                    ],
                    row_to_record,
                )
                .map_err(|err| {
                    format!(
                        "caused Agent Inbox insert was coalesced but existing row lookup failed: {err}"
                    )
                })?;
            return Ok((existing, false));
        }

        let id = conn.last_insert_rowid();
        if create_formal_trigger
            && params.recipient_member_id.as_deref()
                == Some(crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID)
        {
            if let Some(org_run_id) = params.org_run_id.as_deref() {
                if let Some(metadata) = formal_trigger_metadata(&params.message) {
                    let suppress_self_wake = matches!(
                        params.message,
                        crate::coordination::agent_inbox::AgentMessage::TaskAssigned { .. }
                            | crate::coordination::agent_inbox::AgentMessage::TaskCompleted { .. }
                            | crate::coordination::agent_inbox::AgentMessage::TaskTerminal { .. }
                    ) && params.sender_member_id.as_deref()
                        == Some(crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID);
                    crate::coordination::agent_org_formal_triggers::record_inbox_trigger_in_tx(
                        conn,
                        org_run_id,
                        id,
                        crate::coordination::agent_org_formal_triggers::InboxFormalTriggerSource {
                            source_kind: metadata.source_kind,
                            task_id: metadata.task_id,
                            owner_member_id: params.sender_member_id.as_deref(),
                            source_turn_intent_id: None,
                            task_output_digest: None,
                            plan_revision_id: metadata.plan_revision_id,
                            suppress_self_wake,
                        },
                    )?;
                    if suppress_self_wake {
                        conn.execute(
                            "UPDATE agent_org_runtime_inbox
                             SET read_at=?2 WHERE id=?1 AND read_at IS NULL",
                            rusqlite::params![id, chrono::Utc::now().to_rfc3339()],
                        )
                        .map_err(|error| error.to_string())?;
                    }
                }
            }
        }
        Ok((
            AgentInboxRecord {
                id,
                recipient_agent_id: params.recipient_agent_id,
                recipient_member_id: params.recipient_member_id,
                sender_agent_id: params.sender_agent_id,
                sender_member_id: params.sender_member_id,
                org_run_id: params.org_run_id,
                payload_kind: kind,
                payload_json,
                request_id,
                created_at: now,
                read_at: None,
            },
            true,
        ))
    }
}

struct FormalInboxTriggerMetadata<'a> {
    source_kind: &'static str,
    task_id: Option<&'a str>,
    plan_revision_id: Option<&'a str>,
}

/// Only structured facts that require Coordinator action become formal
/// triggers. Plain narration and routine MemberIdle availability remain
/// durable Inbox history without creating Provider work.
fn formal_trigger_metadata(
    message: &super::AgentMessage,
) -> Option<FormalInboxTriggerMetadata<'_>> {
    use super::AgentMessage;
    match message {
        AgentMessage::PlanApprovalRequest {
            source_task_id,
            plan_revision_id,
            ..
        } => Some(FormalInboxTriggerMetadata {
            source_kind: "plan_request",
            task_id: Some(source_task_id),
            plan_revision_id: Some(plan_revision_id),
        }),
        AgentMessage::PlanDecisionCommitted {
            source_task_id,
            plan_revision_id,
            ..
        } => Some(FormalInboxTriggerMetadata {
            source_kind: "plan_decision",
            task_id: Some(source_task_id),
            plan_revision_id: Some(plan_revision_id),
        }),
        AgentMessage::TaskAssigned { task_id, .. } => Some(FormalInboxTriggerMetadata {
            source_kind: "task_assignment",
            task_id: Some(task_id),
            plan_revision_id: None,
        }),
        AgentMessage::TaskAssignmentCommitted { task_id, .. } => Some(FormalInboxTriggerMetadata {
            source_kind: "task_assignment",
            task_id: Some(task_id),
            plan_revision_id: None,
        }),
        AgentMessage::TaskCompleted {
            task_id,
            plan_revision_id,
            ..
        } => Some(FormalInboxTriggerMetadata {
            source_kind: if plan_revision_id.is_some() {
                "plan_decision"
            } else {
                "task_output"
            },
            task_id: Some(task_id),
            plan_revision_id: plan_revision_id.as_deref(),
        }),
        AgentMessage::TaskTerminal {
            task_id,
            terminal_status,
            ..
        } => Some(FormalInboxTriggerMetadata {
            source_kind: match terminal_status {
                super::TaskTerminalStatus::Failed => "task_failure",
                super::TaskTerminalStatus::Cancelled => "task_cancellation",
            },
            task_id: Some(task_id),
            plan_revision_id: None,
        }),
        AgentMessage::ShutdownResponse { .. } => Some(FormalInboxTriggerMetadata {
            source_kind: "handoff_result",
            task_id: None,
            plan_revision_id: None,
        }),
        AgentMessage::MemberTerminated { .. } => Some(FormalInboxTriggerMetadata {
            source_kind: "formal_lifecycle",
            task_id: None,
            plan_revision_id: None,
        }),
        AgentMessage::MemberIdle {
            reason: super::MemberIdleReason::Failed,
            unfinished_task_ids,
            ..
        } => Some(FormalInboxTriggerMetadata {
            source_kind: "task_failure",
            task_id: unfinished_task_ids.first().map(String::as_str),
            plan_revision_id: None,
        }),
        AgentMessage::Plain { .. }
        | AgentMessage::ShutdownRequest { .. }
        | AgentMessage::PlanApprovalResponse { .. }
        | AgentMessage::MemberIdle { .. }
        | AgentMessage::ExecModeSetRequest { .. } => None,
    }
}
