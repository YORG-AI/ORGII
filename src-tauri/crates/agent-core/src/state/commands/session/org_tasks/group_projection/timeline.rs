use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use database::db::get_connection;
use rusqlite::{
    named_params, params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension,
};

use super::*;

const MAX_STABLE_SOURCE_ID_BYTES: usize = 256;
const MAX_ORDER_TIMESTAMP_BYTES: usize = 96;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimelineRowKind {
    InitialUser,
    InitialReply,
    GroupRootUser,
    GroupRootReply,
    GroupMentionUser,
    GroupMentionReply,
    TaskEvent,
    TeamPaused,
    TeamResumed,
    MemberReturned,
    CompletionCertificate,
    FinalReport,
    FinalReportFailed,
    TeamArchived,
}

impl TimelineRowKind {
    fn parse(value: &str) -> Result<Self, String> {
        Ok(match value {
            "initial_user" => Self::InitialUser,
            "initial_reply" => Self::InitialReply,
            "group_root_user" => Self::GroupRootUser,
            "group_root_reply" => Self::GroupRootReply,
            "group_mention_user" => Self::GroupMentionUser,
            "group_mention_reply" => Self::GroupMentionReply,
            "task_event" => Self::TaskEvent,
            "team_paused" => Self::TeamPaused,
            "team_resumed" => Self::TeamResumed,
            "member_returned" => Self::MemberReturned,
            "completion_certificate" => Self::CompletionCertificate,
            "final_report" => Self::FinalReport,
            "final_report_failed" => Self::FinalReportFailed,
            "team_archived" => Self::TeamArchived,
            _ => return Err("group_projection_unknown_timeline_kind".to_string()),
        })
    }
}

#[derive(Debug, Clone)]
struct TimelineCandidate {
    order: AgentOrgGroupOrderKey,
    row_kind: TimelineRowKind,
    authority_id: String,
    event_id: Option<String>,
}

#[derive(Debug, Clone)]
struct HydratedTimelineRow {
    candidate: TimelineCandidate,
    initial_turn_intent_id: Option<String>,
    initial_message_id: Option<String>,
    initial_content: Option<String>,
    initial_intent_status: Option<String>,
    initial_root_session_id: Option<String>,
    context_session_id: Option<String>,
    context_turn_intent_id: Option<String>,
    context_source_kind: Option<String>,
    context_source_id: Option<String>,
    context_participant_id: Option<String>,
    context_intent_status: Option<String>,
    delivery_status: Option<String>,
    inbox_payload_json: Option<String>,
    exact_reply_exists: bool,
    task_event_type: Option<String>,
    task_id: Option<String>,
    previous_owner: Option<String>,
    next_owner: Option<String>,
    previous_status: Option<String>,
    next_status: Option<String>,
    task_subject: Option<String>,
    replaces_task_id: Option<String>,
    replaced_task_subject: Option<String>,
    intervention_member_id: Option<String>,
    completion_outcome: Option<String>,
    summary_session_id: Option<String>,
    summary_turn_intent_id: Option<String>,
    pause_episode_id: Option<String>,
    archive_receipt_id: Option<String>,
}

#[derive(Debug, Clone)]
struct TimelineEventRow {
    id: String,
    session_id: String,
    result_json: String,
    content: String,
    created_at: String,
}

pub(super) fn decode_cursor(raw: &str) -> Result<GroupProjectionCursor, String> {
    if raw.is_empty() || raw.len() > MAX_CURSOR_BYTES {
        return Err("invalid_group_projection_cursor".to_string());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| "invalid_group_projection_cursor".to_string())?;
    let cursor: GroupProjectionCursor = serde_json::from_slice(&bytes)
        .map_err(|_| "invalid_group_projection_cursor".to_string())?;
    if cursor.version != 2
        || cursor.created_at.is_empty()
        || cursor.created_at.len() > MAX_ORDER_TIMESTAMP_BYTES
        || cursor.source_rank == 0
        || cursor.stable_source_id.is_empty()
        || cursor.stable_source_id.len() > MAX_STABLE_SOURCE_ID_BYTES
        || cursor.item_ordinal > 1
    {
        return Err("invalid_group_projection_cursor".to_string());
    }
    Ok(cursor)
}

pub(super) fn encode_cursor(order: &AgentOrgGroupOrderKey) -> Result<String, String> {
    let raw = serde_json::to_vec(&GroupProjectionCursor {
        version: 2,
        created_at: order.created_at.clone(),
        source_rank: order.source_rank,
        stable_source_id: order.stable_source_id.clone(),
        item_ordinal: order.item_ordinal,
    })
    .map_err(|_| "group_projection_cursor_encode_failed".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

pub(super) fn load_projection_page(
    session_id: &str,
    cursor: Option<GroupProjectionCursor>,
    limit: usize,
) -> Result<AgentOrgGroupProjectionPage, String> {
    let conn = get_connection().map_err(|error| error.to_string())?;
    let context = resolve_context(&conn, session_id)?;
    load_projection_page_with_connection(&conn, &context, cursor, limit)
}

pub(super) fn load_projection_page_with_connection(
    conn: &Connection,
    context: &AgentOrgRunContext,
    cursor: Option<GroupProjectionCursor>,
    limit: usize,
) -> Result<AgentOrgGroupProjectionPage, String> {
    let candidates = load_candidates(conn, &context.run_id, cursor.as_ref(), limit)?;
    let hydrated = hydrate_candidates(conn, &context.run_id, &candidates)?;
    let events = load_events(conn, &hydrated)?;
    let mut keyed = hydrated
        .iter()
        .enumerate()
        .map(|(index, row)| project_row(context, row, events.get(&index)))
        .collect::<Vec<_>>();
    keyed.sort_by(|left, right| compare_order(&left.order, &right.order));
    let mut has_more = keyed.len() > limit;
    if has_more {
        let overflow = keyed.len() - limit;
        keyed.drain(0..overflow);
    }
    let mut page = AgentOrgGroupProjectionPage {
        run_id: context.run_id.clone(),
        items: keyed.iter().map(|entry| entry.item.clone()).collect(),
        has_more,
        next_cursor: None,
    };
    finalize_page_bounds(&mut page, &mut keyed, &mut has_more)?;
    Ok(page)
}

fn compare_order(
    left: &AgentOrgGroupOrderKey,
    right: &AgentOrgGroupOrderKey,
) -> std::cmp::Ordering {
    (
        &left.created_at,
        left.source_rank,
        &left.stable_source_id,
        left.item_ordinal,
    )
        .cmp(&(
            &right.created_at,
            right.source_rank,
            &right.stable_source_id,
            right.item_ordinal,
        ))
}

pub(super) fn finalize_page_bounds(
    page: &mut AgentOrgGroupProjectionPage,
    keyed: &mut Vec<KeyedItem>,
    has_more: &mut bool,
) -> Result<(), String> {
    loop {
        page.has_more = *has_more;
        page.next_cursor = if *has_more {
            keyed
                .first()
                .map(|entry| encode_cursor(&entry.order))
                .transpose()?
        } else {
            None
        };
        let serialized = serde_json::to_vec(page)
            .map_err(|_| "group_projection_serialize_failed".to_string())?;
        if serialized.len() <= MAX_PAGE_BYTES {
            return Ok(());
        }
        if page.items.len() <= 1 || keyed.len() <= 1 {
            return Err("group_projection_item_too_large".to_string());
        }
        page.items.remove(0);
        keyed.remove(0);
        *has_more = true;
    }
}

/// Query 1/4: resolve any Team-owned Session to the canonical run snapshot.
fn resolve_context(conn: &Connection, session_id: &str) -> Result<AgentOrgRunContext, String> {
    let run = conn
        .query_row(
            "WITH RECURSIVE ancestry(session_id,parent_session_id,depth) AS (
               SELECT session_id,parent_session_id,0
               FROM agent_sessions WHERE session_id=?1
               UNION ALL
               SELECT parent.session_id,parent.parent_session_id,ancestry.depth+1
               FROM agent_sessions parent
               JOIN ancestry ON parent.session_id=ancestry.parent_session_id
               WHERE ancestry.depth<64
             )
             SELECT run.id,run.org_id,run.coordinator_agent_id,run.root_session_id,
                    run.org_snapshot_json,run.entry_mode,run.status,
                    run.activation_generation,run.has_initial_work,run.work_item_id,
                    run.project_slug,run.routine_fire_id,run.summary,run.last_error,
                    run.failure_json,run.last_activity_outcome,run.created_at,
                    run.updated_at,run.idled_at,run.archived_at,run.archive_receipt_id
             FROM agent_org_runtime_runs run
             JOIN ancestry ON ancestry.session_id=run.root_session_id
             ORDER BY ancestry.depth ASC,run.created_at DESC
             LIMIT 1",
            params![session_id],
            row_to_run,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "agent_org_group_projection_not_found".to_string())?;
    context_for_run_record(&run).map_err(|_| "agent_org_group_projection_invalid_run".to_string())
}

/// Query 2/4: select only the public facts in this page. Every UNION branch is
/// scoped by `org_run_id`; private Direct/Linked Inbox rows have no branch.
fn load_candidates(
    conn: &Connection,
    run_id: &str,
    cursor: Option<&GroupProjectionCursor>,
    limit: usize,
) -> Result<Vec<TimelineCandidate>, String> {
    let sql = r#"
        WITH candidates(created_at,source_rank,stable_source_id,item_ordinal,row_kind,authority_id,event_id) AS (
          SELECT initial.created_at,10,initial.message_id,0,'initial_user',initial.message_id,NULL
          FROM agent_org_runtime_initial_inputs initial
          WHERE initial.org_run_id=:run_id
          UNION ALL
          SELECT reply.created_at,10,initial.message_id,1,'initial_reply',initial.message_id,reply.id
          FROM agent_org_runtime_initial_inputs initial
          JOIN agent_org_runtime_runs run ON run.id=initial.org_run_id
          JOIN events reply ON reply.id=(
            SELECT candidate.id
            FROM events candidate INDEXED BY idx_events_agent_org_initial_reply
            WHERE candidate.session_id=run.root_session_id
              AND CASE WHEN json_valid(candidate.result_json)
                       THEN json_type(candidate.result_json,'$.agent_org_initial_reply.message_id')='text'
                        AND json_type(candidate.result_json,'$.agent_org_initial_reply.turn_intent_id')='text'
                       ELSE 0 END
              AND json_extract(candidate.result_json,'$.agent_org_initial_reply.message_id')=initial.message_id
              AND json_extract(candidate.result_json,'$.agent_org_initial_reply.turn_intent_id')=initial.turn_intent_id
            ORDER BY candidate.history_sequence DESC,candidate.rowid DESC,candidate.id DESC
            LIMIT 1
          )
          WHERE initial.org_run_id=:run_id
          UNION ALL
          SELECT context.created_at,20,printf('%020lld',context.context_id),0,
                 CASE context.source_kind WHEN 'group_root' THEN 'group_root_user' ELSE 'group_mention_user' END,
                 CAST(context.context_id AS TEXT),
                 CASE context.source_kind WHEN 'group_root' THEN context.source_id ELSE NULL END
          FROM agent_org_runtime_turn_contexts context
          WHERE context.org_run_id=:run_id
            AND context.source_kind IN ('group_root','group_mention')
          UNION ALL
          SELECT reply.created_at,20,printf('%020lld',context.context_id),1,
                 'group_root_reply',CAST(context.context_id AS TEXT),reply.id
          FROM agent_org_runtime_turn_contexts context
          JOIN events reply ON reply.id=(
            SELECT candidate.id
            FROM events candidate INDEXED BY idx_events_agent_org_group_root_reply
            WHERE candidate.session_id=context.session_id
              AND CASE WHEN json_valid(candidate.result_json)
                       THEN json_type(candidate.result_json,'$.agent_org_group_root_reply.source_event_id')='text'
                       ELSE 0 END
              AND json_extract(candidate.result_json,'$.agent_org_group_root_reply.source_event_id')=context.source_id
            ORDER BY candidate.history_sequence DESC,candidate.rowid DESC,candidate.id DESC
            LIMIT 1
          )
          WHERE context.org_run_id=:run_id AND context.source_kind='group_root'
          UNION ALL
          SELECT reply.created_at,20,printf('%020lld',context.context_id),1,
                 'group_mention_reply',CAST(context.context_id AS TEXT),reply.id
          FROM agent_org_runtime_turn_contexts context
          JOIN events reply ON reply.id=(
            SELECT candidate.id
            FROM events candidate INDEXED BY idx_events_agent_org_group_mention_reply
            WHERE candidate.session_id=context.session_id
              AND CASE WHEN json_valid(candidate.result_json)
                       THEN json_extract(candidate.result_json,'$.agent_org_user_directed_reply.source_kind')='group_mention'
                       ELSE 0 END
              AND CAST(json_extract(candidate.result_json,'$.agent_org_user_directed_reply.source_inbox_id') AS INTEGER)=CAST(context.source_id AS INTEGER)
            ORDER BY candidate.history_sequence DESC,candidate.rowid DESC,candidate.id DESC
            LIMIT 1
          )
          WHERE context.org_run_id=:run_id AND context.source_kind='group_mention'
          UNION ALL
          SELECT event.created_at,30,event.id,0,'task_event',event.id,NULL
          FROM agent_org_runtime_task_events event
          WHERE event.org_run_id=:run_id
            AND (
              event.event_type='created'
              OR (event.previous_status IS NOT event.next_status
                  AND event.next_status IN ('in_progress','completed','failed','cancelled'))
              OR (event.previous_owner IS NOT event.next_owner
                  AND event.next_owner IS NOT NULL
                  AND event.event_type<>'created')
            )
          UNION ALL
          SELECT episode.created_at,40,episode.episode_id,0,'team_paused',episode.episode_id,NULL
          FROM agent_org_runtime_pause_episodes episode
          WHERE episode.org_run_id=:run_id
          UNION ALL
          SELECT episode.resumed_at,40,episode.episode_id,1,'team_resumed',episode.episode_id,NULL
          FROM agent_org_runtime_pause_episodes episode
          WHERE episode.org_run_id=:run_id AND episode.resumed_at IS NOT NULL
          UNION ALL
          SELECT intervention.cleared_at,50,
                 intervention.intervention_receipt_id || ':' || printf('%020lld',intervention.cleared_revision),
                 0,'member_returned',intervention.intervention_receipt_id,NULL
          FROM agent_org_runtime_member_interventions intervention
          WHERE intervention.org_run_id=:run_id
            AND intervention.status='cleared'
            AND intervention.cleared_at IS NOT NULL
            AND intervention.cleared_revision IS NOT NULL
          UNION ALL
          SELECT certificate.created_at,60,certificate.id,0,'completion_certificate',certificate.id,NULL
          FROM agent_org_runtime_run_completion_certificates certificate
          WHERE certificate.org_run_id=:run_id
          UNION ALL
          SELECT event.created_at,61,receipt.receipt_id,0,'final_report',receipt.receipt_id,event.id
          FROM agent_org_runtime_final_summary_receipts receipt
          JOIN events event
            ON event.id=receipt.event_id
           AND event.session_id=receipt.coordinator_session_id
          WHERE receipt.org_run_id=:run_id AND receipt.status='persisted'
          UNION ALL
          SELECT receipt.terminal_at,61,receipt.receipt_id,0,'final_report_failed',receipt.receipt_id,NULL
          FROM agent_org_runtime_final_summary_receipts receipt
          WHERE receipt.org_run_id=:run_id AND receipt.status='failed'
          UNION ALL
          SELECT archive.archived_at,70,archive.archive_receipt_id,0,'team_archived',archive.archive_receipt_id,NULL
          FROM agent_org_runtime_archive_episodes archive
          WHERE archive.org_run_id=:run_id
        )
        SELECT created_at,source_rank,stable_source_id,item_ordinal,row_kind,authority_id,event_id
        FROM candidates
        WHERE :cursor_created IS NULL
           OR created_at<:cursor_created
           OR (created_at=:cursor_created AND source_rank<:cursor_rank)
           OR (created_at=:cursor_created AND source_rank=:cursor_rank
               AND stable_source_id<:cursor_stable)
           OR (created_at=:cursor_created AND source_rank=:cursor_rank
               AND stable_source_id=:cursor_stable AND item_ordinal<:cursor_ordinal)
        ORDER BY created_at DESC,source_rank DESC,stable_source_id DESC,item_ordinal DESC
        LIMIT :fetch_limit
    "#;
    let mut stmt = conn.prepare(sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(
            named_params! {
                ":run_id": run_id,
                ":cursor_created": cursor.map(|value| value.created_at.as_str()),
                ":cursor_rank": cursor.map(|value| i64::from(value.source_rank)),
                ":cursor_stable": cursor.map(|value| value.stable_source_id.as_str()),
                ":cursor_ordinal": cursor.map(|value| i64::from(value.item_ordinal)),
                ":fetch_limit": (limit + 1) as i64,
            },
            |row| {
                let source_rank = u16::try_from(row.get::<_, i64>(1)?).map_err(|_| {
                    rusqlite::Error::IntegralValueOutOfRange(1, row.get::<_, i64>(1).unwrap_or(-1))
                })?;
                let item_ordinal = u8::try_from(row.get::<_, i64>(3)?).map_err(|_| {
                    rusqlite::Error::IntegralValueOutOfRange(3, row.get::<_, i64>(3).unwrap_or(-1))
                })?;
                let row_kind_raw: String = row.get(4)?;
                let row_kind = TimelineRowKind::parse(&row_kind_raw).map_err(|_| {
                    rusqlite::Error::InvalidColumnType(4, row_kind_raw, rusqlite::types::Type::Text)
                })?;
                Ok(TimelineCandidate {
                    order: AgentOrgGroupOrderKey {
                        created_at: row.get(0)?,
                        source_rank,
                        stable_source_id: row.get(2)?,
                        item_ordinal,
                    },
                    row_kind,
                    authority_id: row.get(5)?,
                    event_id: row.get(6)?,
                })
            },
        )
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

/// Query 3/4: hydrate the selected authorities in one batch. This query never
/// reads raw Direct/Linked Inbox text because only Group context rows join it.
fn hydrate_candidates(
    conn: &Connection,
    run_id: &str,
    candidates: &[TimelineCandidate],
) -> Result<Vec<HydratedTimelineRow>, String> {
    if candidates.is_empty() {
        conn.query_row("SELECT 1", [], |_| Ok(()))
            .map_err(|error| error.to_string())?;
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("(?,?,?,?,?)", candidates.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        r#"
        WITH requested(row_index,row_kind,authority_id,event_id,org_run_id) AS (VALUES {placeholders})
        SELECT requested.row_index,
               initial.turn_intent_id,initial.message_id,initial.content,
               initial_intent.status,initial_run.root_session_id,
               context.session_id,context.turn_intent_id,context.source_kind,
               context.source_id,context.participant_id,context_intent.status,
               delivery.status,inbox.payload_json,
               CASE
                 WHEN requested.row_kind='group_root_user' THEN EXISTS(
                   SELECT 1 FROM events reply INDEXED BY idx_events_agent_org_group_root_reply
                   WHERE reply.session_id=context.session_id
                     AND CASE WHEN json_valid(reply.result_json)
                              THEN json_type(reply.result_json,'$.agent_org_group_root_reply.source_event_id')='text'
                              ELSE 0 END
                     AND json_extract(reply.result_json,'$.agent_org_group_root_reply.source_event_id')=context.source_id
                 )
                 WHEN requested.row_kind='group_mention_user' THEN EXISTS(
                   SELECT 1 FROM events reply INDEXED BY idx_events_agent_org_group_mention_reply
                   WHERE reply.session_id=context.session_id
                     AND CASE WHEN json_valid(reply.result_json)
                              THEN json_extract(reply.result_json,'$.agent_org_user_directed_reply.source_kind')='group_mention'
                              ELSE 0 END
                     AND CAST(json_extract(reply.result_json,'$.agent_org_user_directed_reply.source_inbox_id') AS INTEGER)=CAST(context.source_id AS INTEGER)
                 )
                 ELSE 0
               END,
               task_event.event_type,task_event.task_id,task_event.previous_owner,
               task_event.next_owner,task_event.previous_status,task_event.next_status,
               task.subject,task.replaces_task_id,replaced.subject,
               intervention.member_id,certificate.outcome,
               summary.coordinator_session_id,summary.turn_intent_id,
               pause.episode_id,archive.archive_receipt_id
        FROM requested
        LEFT JOIN agent_org_runtime_initial_inputs initial
          ON requested.row_kind IN ('initial_user','initial_reply')
         AND initial.org_run_id=requested.org_run_id
         AND initial.message_id=requested.authority_id
        LEFT JOIN agent_org_runtime_runs initial_run
          ON initial_run.id=initial.org_run_id
        LEFT JOIN session_turn_intents initial_intent
          ON initial_intent.session_id=initial_run.root_session_id
         AND initial_intent.turn_intent_id=initial.turn_intent_id
        LEFT JOIN agent_org_runtime_turn_contexts context
          ON requested.row_kind IN (
               'group_root_user','group_root_reply','group_mention_user','group_mention_reply'
             )
         AND context.context_id=CAST(requested.authority_id AS INTEGER)
         AND context.org_run_id=requested.org_run_id
        LEFT JOIN session_turn_intents context_intent
          ON context_intent.session_id=context.session_id
         AND context_intent.turn_intent_id=context.turn_intent_id
        LEFT JOIN agent_org_runtime_user_directed_deliveries delivery
          ON delivery.session_id=context.session_id
         AND delivery.turn_intent_id=context.turn_intent_id
        LEFT JOIN agent_org_runtime_inbox inbox
          ON context.source_kind='group_mention'
         AND inbox.id=CAST(context.source_id AS INTEGER)
         AND inbox.org_run_id=requested.org_run_id
         AND inbox.recipient_member_id=context.participant_id
         AND inbox.sender_agent_id='_user'
         AND inbox.delivery_class='user_directed'
        LEFT JOIN agent_org_runtime_task_events task_event
          ON requested.row_kind='task_event'
         AND task_event.id=requested.authority_id
         AND task_event.org_run_id=requested.org_run_id
        LEFT JOIN agent_org_runtime_tasks task
          ON task.org_run_id=task_event.org_run_id AND task.id=task_event.task_id
        LEFT JOIN agent_org_runtime_tasks replaced
          ON replaced.org_run_id=task.org_run_id AND replaced.id=task.replaces_task_id
        LEFT JOIN agent_org_runtime_pause_episodes pause
          ON requested.row_kind IN ('team_paused','team_resumed')
         AND pause.episode_id=requested.authority_id
         AND pause.org_run_id=requested.org_run_id
        LEFT JOIN agent_org_runtime_member_interventions intervention
          ON requested.row_kind='member_returned'
         AND intervention.intervention_receipt_id=requested.authority_id
         AND intervention.org_run_id=requested.org_run_id
         AND intervention.status='cleared'
        LEFT JOIN agent_org_runtime_run_completion_certificates certificate
          ON requested.row_kind='completion_certificate'
         AND certificate.id=requested.authority_id
         AND certificate.org_run_id=requested.org_run_id
        LEFT JOIN agent_org_runtime_final_summary_receipts summary
          ON requested.row_kind IN ('final_report','final_report_failed')
         AND summary.receipt_id=requested.authority_id
         AND summary.org_run_id=requested.org_run_id
        LEFT JOIN agent_org_runtime_archive_episodes archive
          ON requested.row_kind='team_archived'
         AND archive.archive_receipt_id=requested.authority_id
         AND archive.org_run_id=requested.org_run_id
        ORDER BY requested.row_index ASC
        "#
    );
    let mut values = Vec::with_capacity(candidates.len() * 5);
    for (index, candidate) in candidates.iter().enumerate() {
        values.push(SqlValue::Integer(index as i64));
        values.push(SqlValue::Text(
            row_kind_wire(candidate.row_kind).to_string(),
        ));
        values.push(SqlValue::Text(candidate.authority_id.clone()));
        values.push(
            candidate
                .event_id
                .clone()
                .map_or(SqlValue::Null, SqlValue::Text),
        );
        values.push(SqlValue::Text(run_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(values), |row| {
            let index = usize::try_from(row.get::<_, i64>(0)?).map_err(|_| {
                rusqlite::Error::IntegralValueOutOfRange(0, row.get::<_, i64>(0).unwrap_or(-1))
            })?;
            Ok((
                index,
                HydratedTimelineRow {
                    candidate: candidates[index].clone(),
                    initial_turn_intent_id: row.get(1)?,
                    initial_message_id: row.get(2)?,
                    initial_content: row.get(3)?,
                    initial_intent_status: row.get(4)?,
                    initial_root_session_id: row.get(5)?,
                    context_session_id: row.get(6)?,
                    context_turn_intent_id: row.get(7)?,
                    context_source_kind: row.get(8)?,
                    context_source_id: row.get(9)?,
                    context_participant_id: row.get(10)?,
                    context_intent_status: row.get(11)?,
                    delivery_status: row.get(12)?,
                    inbox_payload_json: row.get(13)?,
                    exact_reply_exists: row.get::<_, i64>(14)? != 0,
                    task_event_type: row.get(15)?,
                    task_id: row.get(16)?,
                    previous_owner: row.get(17)?,
                    next_owner: row.get(18)?,
                    previous_status: row.get(19)?,
                    next_status: row.get(20)?,
                    task_subject: row.get(21)?,
                    replaces_task_id: row.get(22)?,
                    replaced_task_subject: row.get(23)?,
                    intervention_member_id: row.get(24)?,
                    completion_outcome: row.get(25)?,
                    summary_session_id: row.get(26)?,
                    summary_turn_intent_id: row.get(27)?,
                    pause_episode_id: row.get(28)?,
                    archive_receipt_id: row.get(29)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut hydrated = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    hydrated.sort_by_key(|(index, _)| *index);
    if hydrated.len() != candidates.len()
        || hydrated
            .iter()
            .enumerate()
            .any(|(expected, (actual, _))| expected != *actual)
    {
        return Err("group_projection_hydration_mismatch".to_string());
    }
    Ok(hydrated.into_iter().map(|(_, row)| row).collect())
}

/// Query 4/4: read only exact EventStore ids selected by the authority query.
fn load_events(
    conn: &Connection,
    rows: &[HydratedTimelineRow],
) -> Result<HashMap<usize, TimelineEventRow>, String> {
    let requested = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let event_id = row.candidate.event_id.as_ref()?;
            let session_id = expected_event_session(row)?;
            Some((index, event_id, session_id))
        })
        .collect::<Vec<_>>();
    if requested.is_empty() {
        conn.query_row("SELECT 1", [], |_| Ok(()))
            .map_err(|error| error.to_string())?;
        return Ok(HashMap::new());
    }
    let placeholders = std::iter::repeat_n("(?,?,?)", requested.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "WITH requested(row_index,event_id,session_id) AS (VALUES {placeholders})
         SELECT requested.row_index,event.id,event.session_id,event.result_json,
                event.content,event.created_at
         FROM requested
         JOIN events event
           ON event.id=requested.event_id AND event.session_id=requested.session_id"
    );
    let mut values = Vec::with_capacity(requested.len() * 3);
    for (index, event_id, session_id) in requested {
        values.push(SqlValue::Integer(index as i64));
        values.push(SqlValue::Text(event_id.clone()));
        values.push(SqlValue::Text(session_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let mapped = stmt
        .query_map(params_from_iter(values), |row| {
            Ok((
                usize::try_from(row.get::<_, i64>(0)?).map_err(|_| {
                    rusqlite::Error::IntegralValueOutOfRange(0, row.get::<_, i64>(0).unwrap_or(-1))
                })?,
                TimelineEventRow {
                    id: row.get(1)?,
                    session_id: row.get(2)?,
                    result_json: row.get(3)?,
                    content: row.get(4)?,
                    created_at: row.get(5)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    mapped
        .collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(|error| error.to_string())
}

fn expected_event_session(row: &HydratedTimelineRow) -> Option<&str> {
    match row.candidate.row_kind {
        TimelineRowKind::InitialReply => row.initial_root_session_id.as_deref(),
        TimelineRowKind::GroupRootUser
        | TimelineRowKind::GroupRootReply
        | TimelineRowKind::GroupMentionReply => row.context_session_id.as_deref(),
        TimelineRowKind::FinalReport => row.summary_session_id.as_deref(),
        _ => None,
    }
}

fn project_row(
    context: &AgentOrgRunContext,
    row: &HydratedTimelineRow,
    event: Option<&TimelineEventRow>,
) -> KeyedItem {
    let order = row.candidate.order.clone();
    let item = match row.candidate.row_kind {
        TimelineRowKind::InitialUser => project_initial_user(context, row),
        TimelineRowKind::InitialReply => project_initial_reply(context, row, event),
        TimelineRowKind::GroupRootUser | TimelineRowKind::GroupMentionUser => {
            project_group_user(context, row, event)
        }
        TimelineRowKind::GroupRootReply | TimelineRowKind::GroupMentionReply => {
            project_group_reply(context, row, event)
        }
        TimelineRowKind::FinalReport => project_final_report(context, row, event),
        TimelineRowKind::TaskEvent
        | TimelineRowKind::TeamPaused
        | TimelineRowKind::TeamResumed
        | TimelineRowKind::MemberReturned
        | TimelineRowKind::CompletionCertificate
        | TimelineRowKind::FinalReportFailed
        | TimelineRowKind::TeamArchived => project_activity(context, row),
    };
    KeyedItem { order, item }
}

fn project_initial_user(
    context: &AgentOrgRunContext,
    row: &HydratedTimelineRow,
) -> AgentOrgGroupProjectionItem {
    let (Some(turn_intent_id), Some(message_id), Some(text)) = (
        row.initial_turn_intent_id.as_ref(),
        row.initial_message_id.as_ref(),
        bounded_text(row.initial_content.as_deref()),
    ) else {
        return diagnostic(row, "initial_input_unavailable");
    };
    AgentOrgGroupProjectionItem::Conversation(AgentOrgGroupConversationItem {
        id: format!("timeline:initial:{message_id}:0"),
        kind: AgentOrgGroupConversationKind::UserMessage,
        order: row.candidate.order.clone(),
        turn_intent_id: turn_intent_id.clone(),
        route: AgentOrgGroupRoute::Coordinator,
        target_member_id: COORDINATOR_MEMBER_ID.to_string(),
        target_name: context.coordinator_name.clone(),
        responder_member_id: None,
        responder_name: None,
        source_ref: AgentOrgGroupSourceRef::InitialInput {
            id: message_id.clone(),
        },
        reply_to_item_id: None,
        text: text.to_string(),
        created_at: row.candidate.order.created_at.clone(),
        state: row
            .initial_intent_status
            .as_deref()
            .and_then(non_actionable_state),
        error_code: None,
        can_stop: false,
        retry_mode: None,
    })
}

fn project_initial_reply(
    context: &AgentOrgRunContext,
    row: &HydratedTimelineRow,
    event: Option<&TimelineEventRow>,
) -> AgentOrgGroupProjectionItem {
    let (Some(turn_intent_id), Some(message_id), Some(event)) = (
        row.initial_turn_intent_id.as_ref(),
        row.initial_message_id.as_ref(),
        event,
    ) else {
        return diagnostic(row, "initial_reply_unavailable");
    };
    let marker_matches = parse_json(&event.result_json).is_some_and(|value| {
        value
            .pointer("/agent_org_initial_reply/message_id")
            .and_then(serde_json::Value::as_str)
            == Some(message_id.as_str())
            && value
                .pointer("/agent_org_initial_reply/turn_intent_id")
                .and_then(serde_json::Value::as_str)
                == Some(turn_intent_id.as_str())
    });
    let Some(text) = marker_matches.then(|| reply_text(event)).flatten() else {
        return diagnostic(row, "initial_reply_unavailable");
    };
    AgentOrgGroupProjectionItem::Conversation(AgentOrgGroupConversationItem {
        id: format!("timeline:initial:{message_id}:1"),
        kind: AgentOrgGroupConversationKind::AssistantReply,
        order: row.candidate.order.clone(),
        turn_intent_id: turn_intent_id.clone(),
        route: AgentOrgGroupRoute::Coordinator,
        target_member_id: COORDINATOR_MEMBER_ID.to_string(),
        target_name: context.coordinator_name.clone(),
        responder_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        responder_name: Some(context.coordinator_name.clone()),
        source_ref: AgentOrgGroupSourceRef::Event {
            id: event.id.clone(),
        },
        reply_to_item_id: Some(format!("timeline:initial:{message_id}:0")),
        text,
        created_at: event.created_at.clone(),
        state: Some(AgentOrgGroupDisplayState::Answered),
        error_code: None,
        can_stop: false,
        retry_mode: None,
    })
}

fn project_group_user(
    context: &AgentOrgRunContext,
    row: &HydratedTimelineRow,
    event: Option<&TimelineEventRow>,
) -> AgentOrgGroupProjectionItem {
    let (
        Some(session_id),
        Some(turn_intent_id),
        Some(source_kind),
        Some(source_id),
        Some(participant_id),
    ) = (
        row.context_session_id.as_ref(),
        row.context_turn_intent_id.as_ref(),
        row.context_source_kind.as_deref(),
        row.context_source_id.as_ref(),
        row.context_participant_id.as_ref(),
    )
    else {
        return diagnostic(row, "source_unavailable");
    };
    let (text, source_ref) = match source_kind {
        "group_root" => {
            let Some(event) = event.filter(|event| event.session_id == *session_id) else {
                return diagnostic(row, "source_unavailable");
            };
            let Some(text) = source_event_text(event) else {
                return diagnostic(row, "source_unavailable");
            };
            (
                text,
                AgentOrgGroupSourceRef::Event {
                    id: source_id.clone(),
                },
            )
        }
        "group_mention" => {
            let Some(text) = row.inbox_payload_json.as_deref().and_then(group_inbox_text) else {
                return diagnostic(row, "source_unavailable");
            };
            let Ok(id) = source_id.parse::<i64>() else {
                return diagnostic(row, "source_unavailable");
            };
            (text, AgentOrgGroupSourceRef::Inbox { id })
        }
        _ => return diagnostic(row, "source_unavailable"),
    };
    let status = row
        .delivery_status
        .as_deref()
        .or(row.context_intent_status.as_deref())
        .unwrap_or("failed");
    let (state, can_stop, retry_mode) = display_state(status, row.exact_reply_exists);
    AgentOrgGroupProjectionItem::Conversation(AgentOrgGroupConversationItem {
        id: format!("timeline:group:{}:0", row.candidate.authority_id),
        kind: AgentOrgGroupConversationKind::UserMessage,
        order: row.candidate.order.clone(),
        turn_intent_id: turn_intent_id.clone(),
        route: if source_kind == "group_root" {
            AgentOrgGroupRoute::Coordinator
        } else {
            AgentOrgGroupRoute::Member
        },
        target_member_id: participant_id.clone(),
        target_name: participant_name(context, participant_id),
        responder_member_id: None,
        responder_name: None,
        source_ref,
        reply_to_item_id: None,
        text,
        created_at: row.candidate.order.created_at.clone(),
        state: Some(state),
        error_code: None,
        can_stop,
        retry_mode,
    })
}

fn project_group_reply(
    context: &AgentOrgRunContext,
    row: &HydratedTimelineRow,
    event: Option<&TimelineEventRow>,
) -> AgentOrgGroupProjectionItem {
    let (
        Some(turn_intent_id),
        Some(source_kind),
        Some(source_id),
        Some(participant_id),
        Some(event),
    ) = (
        row.context_turn_intent_id.as_ref(),
        row.context_source_kind.as_deref(),
        row.context_source_id.as_ref(),
        row.context_participant_id.as_ref(),
        event,
    )
    else {
        return diagnostic(row, "reply_unavailable");
    };
    let marker_matches = parse_json(&event.result_json).is_some_and(|value| match source_kind {
        "group_root" => {
            value
                .pointer("/agent_org_group_root_reply/source_event_id")
                .and_then(serde_json::Value::as_str)
                == Some(source_id.as_str())
        }
        "group_mention" => {
            value
                .pointer("/agent_org_user_directed_reply/source_kind")
                .and_then(serde_json::Value::as_str)
                == Some("group_mention")
                && value
                    .pointer("/agent_org_user_directed_reply/source_inbox_id")
                    .and_then(serde_json::Value::as_i64)
                    == source_id.parse::<i64>().ok()
        }
        _ => false,
    });
    let Some(text) = marker_matches.then(|| reply_text(event)).flatten() else {
        return diagnostic(row, "reply_unavailable");
    };
    let status = row
        .delivery_status
        .as_deref()
        .or(row.context_intent_status.as_deref())
        .unwrap_or("failed");
    let (state, _, _) = display_state(status, true);
    let target_name = participant_name(context, participant_id);
    AgentOrgGroupProjectionItem::Conversation(AgentOrgGroupConversationItem {
        id: format!("timeline:group:{}:1", row.candidate.authority_id),
        kind: AgentOrgGroupConversationKind::AssistantReply,
        order: row.candidate.order.clone(),
        turn_intent_id: turn_intent_id.clone(),
        route: if source_kind == "group_root" {
            AgentOrgGroupRoute::Coordinator
        } else {
            AgentOrgGroupRoute::Member
        },
        target_member_id: participant_id.clone(),
        target_name: target_name.clone(),
        responder_member_id: Some(participant_id.clone()),
        responder_name: Some(target_name),
        source_ref: if source_kind == "group_root" {
            AgentOrgGroupSourceRef::Event {
                id: source_id.clone(),
            }
        } else {
            AgentOrgGroupSourceRef::Inbox {
                id: source_id.parse().unwrap_or_default(),
            }
        },
        reply_to_item_id: Some(format!("timeline:group:{}:0", row.candidate.authority_id)),
        text,
        created_at: event.created_at.clone(),
        state: Some(state),
        error_code: None,
        can_stop: false,
        retry_mode: None,
    })
}

fn project_final_report(
    context: &AgentOrgRunContext,
    row: &HydratedTimelineRow,
    event: Option<&TimelineEventRow>,
) -> AgentOrgGroupProjectionItem {
    let (Some(turn_intent_id), Some(event)) = (row.summary_turn_intent_id.as_ref(), event) else {
        return diagnostic(row, "final_report_unavailable");
    };
    let Some(text) = reply_text(event) else {
        return diagnostic(row, "final_report_unavailable");
    };
    AgentOrgGroupProjectionItem::Conversation(AgentOrgGroupConversationItem {
        id: format!("timeline:summary:{}", row.candidate.authority_id),
        kind: AgentOrgGroupConversationKind::AssistantReply,
        order: row.candidate.order.clone(),
        turn_intent_id: turn_intent_id.clone(),
        route: AgentOrgGroupRoute::Coordinator,
        target_member_id: COORDINATOR_MEMBER_ID.to_string(),
        target_name: context.coordinator_name.clone(),
        responder_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        responder_name: Some(context.coordinator_name.clone()),
        source_ref: AgentOrgGroupSourceRef::Event {
            id: event.id.clone(),
        },
        reply_to_item_id: None,
        text,
        created_at: event.created_at.clone(),
        state: Some(AgentOrgGroupDisplayState::Answered),
        error_code: None,
        can_stop: false,
        retry_mode: None,
    })
}

fn project_activity(
    context: &AgentOrgRunContext,
    row: &HydratedTimelineRow,
) -> AgentOrgGroupProjectionItem {
    let mut activity = AgentOrgGroupActivityItem {
        id: format!(
            "timeline:{}:{}",
            row_kind_wire(row.candidate.row_kind),
            row.candidate.authority_id
        ),
        kind: "team_activity",
        order: row.candidate.order.clone(),
        activity_kind: AgentOrgGroupActivityKind::TeamPaused,
        created_at: row.candidate.order.created_at.clone(),
        member_id: None,
        member_name: None,
        previous_member_id: None,
        previous_member_name: None,
        task_id: None,
        task_subject: None,
        replaced_task_id: None,
        replaced_task_subject: None,
        outcome: None,
        public_error_code: None,
    };
    match row.candidate.row_kind {
        TimelineRowKind::TaskEvent => {
            let (Some(event_type), Some(task_id), Some(subject)) = (
                row.task_event_type.as_deref(),
                row.task_id.as_ref(),
                bounded_text(row.task_subject.as_deref()),
            ) else {
                return diagnostic(row, "task_activity_unavailable");
            };
            activity.activity_kind = if event_type == "created" {
                if row.replaces_task_id.is_some() {
                    AgentOrgGroupActivityKind::TaskReplacementCreated
                } else {
                    AgentOrgGroupActivityKind::TaskCreated
                }
            } else {
                match row.next_status.as_deref() {
                    Some("in_progress")
                        if row.previous_status.as_deref() != Some("in_progress") =>
                    {
                        AgentOrgGroupActivityKind::TaskStarted
                    }
                    Some("completed") if row.previous_status.as_deref() != Some("completed") => {
                        AgentOrgGroupActivityKind::TaskCompleted
                    }
                    Some("failed") if row.previous_status.as_deref() != Some("failed") => {
                        AgentOrgGroupActivityKind::TaskFailed
                    }
                    Some("cancelled") if row.previous_status.as_deref() != Some("cancelled") => {
                        AgentOrgGroupActivityKind::TaskCancelled
                    }
                    _ if row.next_owner.is_some() && row.previous_owner != row.next_owner => {
                        AgentOrgGroupActivityKind::TaskReassigned
                    }
                    _ => return diagnostic(row, "task_activity_unavailable"),
                }
            };
            activity.task_id = Some(task_id.clone());
            activity.task_subject = Some(subject.to_string());
            activity.replaced_task_id = row.replaces_task_id.clone();
            activity.replaced_task_subject =
                bounded_text(row.replaced_task_subject.as_deref()).map(str::to_string);
            activity.member_id = row.next_owner.clone();
            activity.member_name = row
                .next_owner
                .as_deref()
                .map(|member| participant_name(context, member));
            if activity.activity_kind == AgentOrgGroupActivityKind::TaskReassigned {
                activity.previous_member_id = row.previous_owner.clone();
                activity.previous_member_name = row
                    .previous_owner
                    .as_deref()
                    .map(|member| participant_name(context, member));
            }
            if activity.activity_kind == AgentOrgGroupActivityKind::TaskFailed {
                activity.public_error_code = Some("task_failed".to_string());
            }
        }
        TimelineRowKind::TeamPaused => {
            if row.pause_episode_id.is_none() {
                return diagnostic(row, "pause_activity_unavailable");
            }
            activity.activity_kind = AgentOrgGroupActivityKind::TeamPaused;
        }
        TimelineRowKind::TeamResumed => {
            if row.pause_episode_id.is_none() {
                return diagnostic(row, "resume_activity_unavailable");
            }
            activity.activity_kind = AgentOrgGroupActivityKind::TeamResumed;
        }
        TimelineRowKind::MemberReturned => {
            let Some(member_id) = row.intervention_member_id.as_ref() else {
                return diagnostic(row, "member_return_activity_unavailable");
            };
            activity.activity_kind = AgentOrgGroupActivityKind::MemberReturned;
            activity.member_id = Some(member_id.clone());
            activity.member_name = Some(participant_name(context, member_id));
        }
        TimelineRowKind::CompletionCertificate => {
            let Some(outcome) = row.completion_outcome.as_ref() else {
                return diagnostic(row, "completion_activity_unavailable");
            };
            activity.activity_kind = AgentOrgGroupActivityKind::CompletionCertified;
            activity.outcome = Some(outcome.clone());
        }
        TimelineRowKind::FinalReportFailed => {
            activity.activity_kind = AgentOrgGroupActivityKind::FinalReportFailed;
            activity.public_error_code = Some("final_report_failed".to_string());
        }
        TimelineRowKind::TeamArchived => {
            if row.archive_receipt_id.is_none() {
                return diagnostic(row, "archive_activity_unavailable");
            }
            activity.activity_kind = AgentOrgGroupActivityKind::TeamArchived;
        }
        _ => return diagnostic(row, "activity_unavailable"),
    }
    AgentOrgGroupProjectionItem::Activity(activity)
}

fn diagnostic(row: &HydratedTimelineRow, error_code: &str) -> AgentOrgGroupProjectionItem {
    AgentOrgGroupProjectionItem::Diagnostic(AgentOrgGroupDiagnosticItem {
        id: format!(
            "timeline:diagnostic:{}:{}:{}",
            row.candidate.order.source_rank,
            row.candidate.order.stable_source_id,
            row.candidate.order.item_ordinal
        ),
        kind: "diagnostic",
        order: row.candidate.order.clone(),
        created_at: row.candidate.order.created_at.clone(),
        error_code: error_code.to_string(),
    })
}

fn participant_name(context: &AgentOrgRunContext, participant_id: &str) -> String {
    context
        .participant_display_name(participant_id)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| participant_id.to_string())
}

fn source_event_text(event: &TimelineEventRow) -> Option<String> {
    let parsed = parse_json(&event.result_json)?;
    bounded_text(
        parsed
            .pointer("/message/content")
            .and_then(serde_json::Value::as_str),
    )
    .map(str::to_string)
}

fn group_inbox_text(raw: &str) -> Option<String> {
    let parsed = parse_json(raw)?;
    bounded_text(parsed.get("text").and_then(serde_json::Value::as_str)).map(str::to_string)
}

fn reply_text(event: &TimelineEventRow) -> Option<String> {
    parse_json(&event.result_json)
        .and_then(|value| {
            bounded_text(value.get("content").and_then(serde_json::Value::as_str))
                .map(str::to_string)
        })
        .or_else(|| bounded_text(Some(&event.content)).map(str::to_string))
}

fn parse_json(raw: &str) -> Option<serde_json::Value> {
    (raw.len() <= MAX_EVENT_JSON_BYTES)
        .then(|| serde_json::from_str(raw).ok())
        .flatten()
}

fn bounded_text(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.trim().is_empty() && text.chars().count() <= MAX_VISIBLE_TEXT_CHARS)
}

fn non_actionable_state(status: &str) -> Option<AgentOrgGroupDisplayState> {
    Some(match status {
        "queued" | "pending" | "optimistic" => AgentOrgGroupDisplayState::Queued,
        "started" | "running" => AgentOrgGroupDisplayState::Running,
        "completed" => AgentOrgGroupDisplayState::Answered,
        "cancelled" | "stale" => AgentOrgGroupDisplayState::Cancelled,
        "unknown" => AgentOrgGroupDisplayState::Unknown,
        _ => AgentOrgGroupDisplayState::Failed,
    })
}

fn display_state(
    status: &str,
    has_reply: bool,
) -> (
    AgentOrgGroupDisplayState,
    bool,
    Option<AgentOrgGroupRetryMode>,
) {
    match status {
        "pending" | "queued" | "optimistic" => (
            AgentOrgGroupDisplayState::Queued,
            true,
            Some(AgentOrgGroupRetryMode::Rekick),
        ),
        "started" | "running" => (AgentOrgGroupDisplayState::Running, true, None),
        "completed" if has_reply => (AgentOrgGroupDisplayState::Answered, false, None),
        "completed" => (
            AgentOrgGroupDisplayState::Failed,
            false,
            Some(AgentOrgGroupRetryMode::NewTurn),
        ),
        "cancelled" | "stale" => (
            AgentOrgGroupDisplayState::Cancelled,
            false,
            Some(AgentOrgGroupRetryMode::NewTurn),
        ),
        "unknown" => (
            AgentOrgGroupDisplayState::Unknown,
            false,
            Some(AgentOrgGroupRetryMode::NewTurnWithConfirmation),
        ),
        _ => (
            AgentOrgGroupDisplayState::Failed,
            false,
            Some(AgentOrgGroupRetryMode::NewTurn),
        ),
    }
}

fn row_kind_wire(kind: TimelineRowKind) -> &'static str {
    match kind {
        TimelineRowKind::InitialUser => "initial_user",
        TimelineRowKind::InitialReply => "initial_reply",
        TimelineRowKind::GroupRootUser => "group_root_user",
        TimelineRowKind::GroupRootReply => "group_root_reply",
        TimelineRowKind::GroupMentionUser => "group_mention_user",
        TimelineRowKind::GroupMentionReply => "group_mention_reply",
        TimelineRowKind::TaskEvent => "task_event",
        TimelineRowKind::TeamPaused => "team_paused",
        TimelineRowKind::TeamResumed => "team_resumed",
        TimelineRowKind::MemberReturned => "member_returned",
        TimelineRowKind::CompletionCertificate => "completion_certificate",
        TimelineRowKind::FinalReport => "final_report",
        TimelineRowKind::FinalReportFailed => "final_report_failed",
        TimelineRowKind::TeamArchived => "team_archived",
    }
}
