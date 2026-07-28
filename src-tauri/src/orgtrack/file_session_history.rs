//! File Session History projection: aggregates resource interactions into
//! the session/participant tree rendered by the file-history panel.
//!
//! Interactions are grouped by root session (via `parent_session_id`), then
//! by participant (main session vs. subagent actor) inside each root. Actor
//! resolution reconciles hook-only interactions (session + turn, no actor)
//! against `SessionActorRecord` lifecycle rows to recover the exact actor
//! when possible, falling back to correlated/session-only attribution.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use database::db::get_connection;
use orgtrack_core::canonical::{
    AttributionPrecision, ResourceInteractionRecord, SessionActorRecord, SessionRecord,
    RESOURCE_INTERACTION_SCHEMA_VERSION, SESSION_PROVENANCE_HOOK_ORIGIN,
};
use orgtrack_core::sources::imported_history::metadata::{
    SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP, SOURCE_CURSOR_IDE,
};
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
use tauri::Emitter;

use super::command_stats::record_orgtrack_command_call;
use super::{session_provenance, types};

fn drain_hook_inbox_and_emit(app: &tauri::AppHandle, context: &'static str) {
    match session_provenance::drain_hook_inbox() {
        Ok(drained) if drained > 0 => {
            let _ = app.emit(session_provenance::RESOURCE_INTERACTIONS_CHANGED_EVENT, ());
        }
        Ok(_) => {}
        Err(err) => {
            tracing::warn!(error = %err, context, "[SessionProvenance] Hook inbox drain failed");
        }
    }
}

#[derive(Debug)]
struct FileSessionHistoryAccumulator {
    session_id: String,
    transcript_session_id: Option<String>,
    parent_session_id: Option<String>,
    session_label: String,
    participant_kind: String,
    actor_id: Option<String>,
    actor_label: Option<String>,
    first_interaction_at: String,
    last_interaction_at: String,
    interaction_count: usize,
    action_counts: BTreeMap<String, usize>,
    actor_ids: BTreeSet<String>,
    capture_methods: BTreeSet<String>,
    attribution_precision: AttributionPrecision,
}

#[derive(Debug)]
struct FileSessionGroupAccumulator {
    session_id: String,
    transcript_session_id: Option<String>,
    session_label: String,
    source: String,
    workspace_path: Option<String>,
    first_interaction_at: String,
    last_interaction_at: String,
    interaction_count: usize,
    action_counts: BTreeMap<String, usize>,
    capture_methods: BTreeSet<String>,
    attribution_precision: AttributionPrecision,
    collaboration_origin: Option<orgtrack_core::canonical::CollaborationSessionOrigin>,
    participants: BTreeMap<String, FileSessionHistoryAccumulator>,
}

const DEFAULT_FILE_SESSION_HISTORY_PAGE_SIZE: usize = 30;
const MAX_FILE_SESSION_HISTORY_PAGE_SIZE: usize = 100;

#[tauri::command]
pub async fn orgtrack_get_file_session_history(
    app: tauri::AppHandle,
    repo_path: String,
    file_path: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<types::FileSessionHistory, String> {
    record_orgtrack_command_call("orgtrack_get_file_session_history");
    tokio::task::spawn_blocking(move || {
        // Make newly emitted hook events visible in the same request that the
        // user uses to open the file history panel.
        drain_hook_inbox_and_emit(&app, "file_session_history");

        let resolved = session_provenance::resolve_file_resource(&repo_path, &file_path);
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let limit = limit
            .unwrap_or(DEFAULT_FILE_SESSION_HISTORY_PAGE_SIZE)
            .clamp(1, MAX_FILE_SESSION_HISTORY_PAGE_SIZE);
        let offset = offset.unwrap_or_default();
        let mut interaction_page = store.list_file_resource_interactions_page(
            resolved.repository_id.as_deref(),
            &resolved.workspace_path,
            &resolved.repo_relative_path,
            limit,
            offset,
        )?;
        let mut sessions = project_file_session_history(
            &store,
            std::mem::take(&mut interaction_page.interactions),
        )?;
        // Capture the revision before starting historical discovery. The
        // background worker may immediately acquire a write lock while it
        // refreshes provider caches; placing this cheap read afterward makes
        // a cold foreground request wait behind work it intentionally queued.
        let mut revision = store.get_file_resource_revision(
            resolved.repository_id.as_deref(),
            &resolved.workspace_path,
            &resolved.repo_relative_path,
        )?;
        // Scheduling is intentionally after the foreground read. Backfill
        // owns a separate DB connection and never delays this response.
        let backfill = session_provenance::request_historical_backfill(
            &repo_path,
            &resolved.repo_relative_path,
        );
        // A shared backfill can finish between the foreground read and the
        // job snapshot. Re-read on terminal success so the client never sees
        // stale rows paired with a status that tells it to stop polling.
        if matches!(backfill.status.as_str(), "complete" | "partial") {
            interaction_page = store.list_file_resource_interactions_page(
                resolved.repository_id.as_deref(),
                &resolved.workspace_path,
                &resolved.repo_relative_path,
                limit,
                offset,
            )?;
            sessions = project_file_session_history(
                &store,
                std::mem::take(&mut interaction_page.interactions),
            )?;
            revision = store.get_file_resource_revision(
                resolved.repository_id.as_deref(),
                &resolved.workspace_path,
                &resolved.repo_relative_path,
            )?;
        }
        Ok(types::FileSessionHistory {
            schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
            file_path: resolved.repo_relative_path,
            revision,
            page: types::FileSessionHistoryPage {
                offset: interaction_page.offset,
                limit: interaction_page.limit,
                total_sessions: interaction_page.total_sessions,
                has_more: interaction_page
                    .offset
                    .saturating_add(interaction_page.limit)
                    < interaction_page.total_sessions,
            },
            backfill,
            sessions,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Index an already-authorized, locally cached collaboration replay into the
/// same Session Blame read model used by native and external sessions.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn orgtrack_index_collaboration_session(
    app: tauri::AppHandle,
    local_session_id: String,
    source_session_id: String,
    title: String,
    workspace_path: String,
    source_workspace_path: Option<String>,
    org_id: String,
    session_row_id: String,
    owner_member_id: String,
    owner_display_name: String,
) -> Result<usize, String> {
    record_orgtrack_command_call("orgtrack_index_collaboration_session");
    let indexed = tokio::task::spawn_blocking(move || {
        session_provenance::index_collaboration_replay(
            &local_session_id,
            &source_session_id,
            &title,
            &workspace_path,
            source_workspace_path.as_deref(),
            &org_id,
            &session_row_id,
            &owner_member_id,
            &owner_display_name,
        )
    })
    .await
    .map_err(|err| err.to_string())??;
    if indexed > 0 {
        let _ = app.emit(session_provenance::RESOURCE_INTERACTIONS_CHANGED_EVENT, ());
    }
    Ok(indexed)
}

/// Drop only the derived Session Blame rows for a discarded Team Session.
#[tauri::command]
pub async fn orgtrack_delete_collaboration_session(
    app: tauri::AppHandle,
    local_session_id: String,
) -> Result<(), String> {
    record_orgtrack_command_call("orgtrack_delete_collaboration_session");
    tokio::task::spawn_blocking(move || {
        session_provenance::delete_collaboration_replay(&local_session_id)
    })
    .await
    .map_err(|err| err.to_string())??;
    let _ = app.emit(session_provenance::RESOURCE_INTERACTIONS_CHANGED_EVENT, ());
    Ok(())
}

pub(super) fn project_file_session_history(
    store: &dyn RecordStore,
    interactions: Vec<ResourceInteractionRecord>,
) -> Result<Vec<types::FileSessionHistorySession>, String> {
    let interactions = strongest_resource_interactions(interactions);
    let mut grouped: BTreeMap<String, FileSessionGroupAccumulator> = BTreeMap::new();
    let mut session_cache: HashMap<String, Option<SessionRecord>> = HashMap::new();
    for mut interaction in interactions {
        if !session_cache.contains_key(&interaction.session_id) {
            session_cache.insert(
                interaction.session_id.clone(),
                store.get_session(&interaction.session_id)?,
            );
        }
        let session = session_cache
            .get(&interaction.session_id)
            .and_then(Option::as_ref)
            .cloned();
        let (effective_actor_id, actor_session, actor_type) =
            resolve_interaction_actor(store, &mut session_cache, &interaction)?;
        if interaction.actor_id.is_none() && effective_actor_id.is_some() {
            // A unique actor found through turn/lifecycle timing is stronger
            // than session-only attribution, but it is not a direct tool-event
            // actor ID. Transcript reconciliation may later supersede it with
            // exact attribution.
            interaction.attribution_precision = interaction
                .attribution_precision
                .max(AttributionPrecision::Correlated);
        }
        let target_session = actor_session.as_ref().or(session.as_ref());
        let origin_session_id = target_session
            .and_then(|session| session.parent_session_id.clone())
            .or_else(|| {
                session
                    .as_ref()
                    .and_then(|session| session.parent_session_id.clone())
            })
            .unwrap_or_else(|| interaction.session_id.clone());
        if !session_cache.contains_key(&origin_session_id) {
            session_cache.insert(
                origin_session_id.clone(),
                store.get_session(&origin_session_id)?,
            );
        }
        let origin_session = session_cache
            .get(&origin_session_id)
            .and_then(Option::as_ref)
            .cloned();
        let target_session_id = actor_session
            .as_ref()
            .map(|session| session.session_id.clone())
            .unwrap_or_else(|| interaction.session_id.clone());
        let is_subagent = effective_actor_id.is_some()
            || target_session.is_some_and(|session| session.parent_session_id.is_some());
        let participant_id =
            if target_session.is_some_and(|session| session.parent_session_id.is_some()) {
                target_session_id.clone()
            } else if let Some(actor_id) = effective_actor_id.as_ref() {
                format!("{origin_session_id}::actor::{actor_id}")
            } else {
                format!("{origin_session_id}::session")
            };
        let actor_label = is_subagent.then(|| {
            actor_session
                .as_ref()
                .or_else(|| target_session.filter(|session| session.parent_session_id.is_some()))
                .map(|session| session.title.clone())
                .filter(|title| !title.trim().is_empty())
                .or_else(|| actor_type.clone())
                .or_else(|| effective_actor_id.clone())
                .unwrap_or_else(|| target_session_id.clone())
        });
        let transcript_session_id = if is_subagent {
            actor_session
                .as_ref()
                .or_else(|| target_session.filter(|session| session.parent_session_id.is_some()))
                .filter(|session| session_has_replayable_transcript(session))
                .map(|session| session.session_id.clone())
        } else {
            target_session
                .filter(|session| session_has_replayable_transcript(session))
                .map(|session| session.session_id.clone())
        };
        let group = grouped.entry(origin_session_id.clone()).or_insert_with(|| {
            FileSessionGroupAccumulator {
                session_id: origin_session_id.clone(),
                transcript_session_id: origin_session
                    .as_ref()
                    .filter(|session| session_has_replayable_transcript(session))
                    .map(|session| session.session_id.clone()),
                session_label: origin_session
                    .as_ref()
                    .or(session.as_ref())
                    .map(|session| session.title.clone())
                    .filter(|title| !title.trim().is_empty())
                    .unwrap_or_else(|| origin_session_id.clone()),
                source: origin_session
                    .as_ref()
                    .or(session.as_ref())
                    .map(|session| session.source.clone())
                    .unwrap_or_else(|| interaction.source.clone()),
                workspace_path: origin_session
                    .as_ref()
                    .or(session.as_ref())
                    .and_then(|session| session.workspace_path.clone()),
                first_interaction_at: interaction.occurred_at.clone(),
                last_interaction_at: interaction.occurred_at.clone(),
                interaction_count: 0,
                action_counts: BTreeMap::new(),
                capture_methods: BTreeSet::new(),
                attribution_precision: interaction.attribution_precision,
                collaboration_origin: origin_session
                    .as_ref()
                    .or(session.as_ref())
                    .and_then(|session| session.collaboration_origin.clone()),
                participants: BTreeMap::new(),
            }
        });
        update_file_session_aggregate(
            &mut group.first_interaction_at,
            &mut group.last_interaction_at,
            &mut group.interaction_count,
            &mut group.action_counts,
            &mut group.capture_methods,
            &mut group.attribution_precision,
            &interaction,
        );
        let entry = group.participants.entry(participant_id).or_insert_with(|| {
            FileSessionHistoryAccumulator {
                session_id: target_session_id,
                transcript_session_id,
                parent_session_id: is_subagent.then_some(origin_session_id),
                session_label: target_session
                    .map(|session| session.title.clone())
                    .filter(|title| !title.trim().is_empty())
                    .unwrap_or_else(|| interaction.session_id.clone()),
                participant_kind: if is_subagent {
                    "subagent".to_string()
                } else {
                    "session".to_string()
                },
                actor_id: effective_actor_id.clone(),
                actor_label,
                first_interaction_at: interaction.occurred_at.clone(),
                last_interaction_at: interaction.occurred_at.clone(),
                interaction_count: 0,
                action_counts: BTreeMap::new(),
                actor_ids: BTreeSet::new(),
                capture_methods: BTreeSet::new(),
                attribution_precision: interaction.attribution_precision,
            }
        });
        update_file_session_aggregate(
            &mut entry.first_interaction_at,
            &mut entry.last_interaction_at,
            &mut entry.interaction_count,
            &mut entry.action_counts,
            &mut entry.capture_methods,
            &mut entry.attribution_precision,
            &interaction,
        );
        if let Some(actor_id) = effective_actor_id {
            entry.actor_ids.insert(actor_id);
        }
    }

    let mut sessions = grouped
        .into_values()
        .map(|entry| {
            let root_replay_target = entry
                .transcript_session_id
                .as_deref()
                .unwrap_or(&entry.session_id)
                .to_string();
            // The root already aggregates every interaction. A participant
            // that resolves back to the same replay identity would be a
            // duplicate row, regardless of whether a provider called it a
            // main agent or subagent.
            let participants = entry
                .participants
                .into_iter()
                .filter(|(_, participant)| {
                    let participant_replay_target = participant
                        .transcript_session_id
                        .as_deref()
                        .unwrap_or(&participant.session_id);
                    participant_replay_target != root_replay_target
                })
                .map(
                    |(entry_id, participant)| types::FileSessionHistoryParticipant {
                        entry_id,
                        session_id: participant.session_id,
                        transcript_session_id: participant.transcript_session_id,
                        parent_session_id: participant.parent_session_id,
                        session_label: participant.session_label,
                        participant_kind: participant.participant_kind,
                        actor_id: participant.actor_id,
                        actor_label: participant.actor_label,
                        first_interaction_at: participant.first_interaction_at,
                        last_interaction_at: participant.last_interaction_at,
                        interaction_count: participant.interaction_count,
                        action_counts: participant.action_counts,
                        actor_ids: participant.actor_ids.into_iter().collect(),
                        capture_methods: participant.capture_methods.into_iter().collect(),
                        attribution_precision: participant
                            .attribution_precision
                            .as_str()
                            .to_string(),
                    },
                )
                .collect();
            types::FileSessionHistorySession {
                session_id: entry.session_id,
                transcript_session_id: entry.transcript_session_id,
                session_label: entry.session_label,
                source: entry.source,
                workspace_path: entry.workspace_path,
                first_interaction_at: entry.first_interaction_at,
                last_interaction_at: entry.last_interaction_at,
                interaction_count: entry.interaction_count,
                action_counts: entry.action_counts,
                capture_methods: entry.capture_methods.into_iter().collect(),
                attribution_precision: entry.attribution_precision.as_str().to_string(),
                collaboration_origin: entry.collaboration_origin,
                participants,
            }
        })
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| {
        right
            .last_interaction_at
            .cmp(&left.last_interaction_at)
            .then(left.session_id.cmp(&right.session_id))
    });
    Ok(sessions)
}

fn session_has_replayable_transcript(session: &SessionRecord) -> bool {
    session.metadata.origin.as_deref() != Some(SESSION_PROVENANCE_HOOK_ORIGIN)
}

fn update_file_session_aggregate(
    first_interaction_at: &mut String,
    last_interaction_at: &mut String,
    interaction_count: &mut usize,
    action_counts: &mut BTreeMap<String, usize>,
    capture_methods: &mut BTreeSet<String>,
    attribution_precision: &mut AttributionPrecision,
    interaction: &ResourceInteractionRecord,
) {
    if interaction.occurred_at < *first_interaction_at {
        *first_interaction_at = interaction.occurred_at.clone();
    }
    if interaction.occurred_at > *last_interaction_at {
        *last_interaction_at = interaction.occurred_at.clone();
    }
    *interaction_count += 1;
    *action_counts
        .entry(interaction.action.as_str().to_string())
        .or_default() += 1;
    capture_methods.insert(interaction.capture_method.as_str().to_string());
    *attribution_precision = (*attribution_precision).max(interaction.attribution_precision);
}

fn strongest_resource_interactions(
    interactions: Vec<ResourceInteractionRecord>,
) -> Vec<ResourceInteractionRecord> {
    let mut correlated = BTreeMap::<String, ResourceInteractionRecord>::new();
    let mut uncorrelated = Vec::new();
    for interaction in interactions {
        let Some(source_event_id) = interaction.source_event_id.as_ref() else {
            uncorrelated.push(interaction);
            continue;
        };
        let key = format!(
            "{}\0{}\0{}\0{}",
            interaction.source,
            source_event_id,
            interaction.resource_id,
            interaction.action.as_str()
        );
        match correlated.entry(key) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(interaction);
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                if interaction_strength(&interaction) > interaction_strength(entry.get()) {
                    entry.insert(interaction);
                }
            }
        }
    }
    uncorrelated.extend(correlated.into_values());
    uncorrelated
}

fn interaction_strength(
    interaction: &ResourceInteractionRecord,
) -> (AttributionPrecision, bool, u8) {
    let capture_rank = match interaction.capture_method {
        orgtrack_core::canonical::ResourceInteractionCaptureMethod::Native => 3,
        orgtrack_core::canonical::ResourceInteractionCaptureMethod::Reconciled => 2,
        orgtrack_core::canonical::ResourceInteractionCaptureMethod::Hook => 1,
    };
    (
        interaction.attribution_precision,
        interaction.actor_id.is_some(),
        capture_rank,
    )
}

fn resolve_interaction_actor(
    store: &dyn RecordStore,
    session_cache: &mut HashMap<String, Option<SessionRecord>>,
    interaction: &ResourceInteractionRecord,
) -> Result<(Option<String>, Option<SessionRecord>, Option<String>), String> {
    if let Some(actor_id) = interaction.actor_id.as_deref() {
        let actor_record = match store.get_session_actor(
            &interaction.source,
            &interaction.session_id,
            actor_id,
        )? {
            Some(record) => Some(record),
            None => store
                .get_session_actor_by_transcript_session_id(
                    &interaction.source,
                    &interaction.session_id,
                )?
                .filter(|record| record.actor_id == actor_id),
        };
        let actor_session = if let Some(transcript_session_id) = actor_record
            .as_ref()
            .and_then(|record| record.transcript_session_id.as_deref())
        {
            cached_session(store, session_cache, transcript_session_id)?
        } else {
            resolve_actor_session(store, session_cache, &interaction.source, actor_id)?
        };
        return Ok((
            Some(actor_id.to_string()),
            actor_session,
            actor_record.and_then(|record| record.actor_type),
        ));
    }

    let Some(turn_id) = interaction.turn_id.as_deref() else {
        return Ok((None, None, None));
    };
    let matching_turn = store
        .list_session_actors(&interaction.source, &interaction.session_id)?
        .into_iter()
        .filter(|record| record.turn_id.as_deref() == Some(turn_id))
        .collect::<Vec<_>>();
    let active = matching_turn
        .iter()
        .filter(|record| actor_was_active(record, &interaction.occurred_at))
        .collect::<Vec<_>>();
    let actor = if active.len() == 1 {
        Some(active[0])
    } else if matching_turn.len() == 1 {
        matching_turn.first()
    } else {
        None
    };
    let Some(actor) = actor else {
        return Ok((None, None, None));
    };
    let actor_session = if let Some(transcript_session_id) = actor.transcript_session_id.as_deref()
    {
        cached_session(store, session_cache, transcript_session_id)?
    } else {
        None
    };
    Ok((
        Some(actor.actor_id.clone()),
        actor_session,
        actor.actor_type.clone(),
    ))
}

fn actor_was_active(record: &SessionActorRecord, occurred_at: &str) -> bool {
    record
        .started_at
        .as_deref()
        .is_none_or(|started_at| started_at <= occurred_at)
        && record
            .stopped_at
            .as_deref()
            .is_none_or(|stopped_at| stopped_at >= occurred_at)
}

fn cached_session(
    store: &dyn RecordStore,
    session_cache: &mut HashMap<String, Option<SessionRecord>>,
    session_id: &str,
) -> Result<Option<SessionRecord>, String> {
    if !session_cache.contains_key(session_id) {
        session_cache.insert(session_id.to_string(), store.get_session(session_id)?);
    }
    Ok(session_cache.get(session_id).and_then(Clone::clone))
}

fn resolve_actor_session(
    store: &dyn RecordStore,
    session_cache: &mut HashMap<String, Option<SessionRecord>>,
    source: &str,
    actor_id: &str,
) -> Result<Option<SessionRecord>, String> {
    let mut candidates = vec![actor_id.to_string()];
    match source {
        SOURCE_CLAUDE_CODE => {
            candidates.push(orgtrack_core::sources::claude_code::canonical_session_id(
                actor_id,
            ));
            if !actor_id.starts_with("agent-") {
                // Claude hook `agent_id` is the bare sidechain ID while the
                // history importer uses the JSONL stem (`agent-{id}`).
                candidates.push(orgtrack_core::sources::claude_code::canonical_session_id(
                    &format!("agent-{actor_id}"),
                ));
            }
        }
        SOURCE_CODEX_APP => {
            candidates.push(orgtrack_core::sources::codex::canonical_session_id(
                actor_id,
            ));
        }
        SOURCE_CURSOR_IDE => {
            candidates.push(orgtrack_core::sources::cursor_ide::canonical_session_id(
                actor_id,
            ));
        }
        _ => {}
    };
    for candidate in candidates {
        if !session_cache.contains_key(&candidate) {
            session_cache.insert(candidate.clone(), store.get_session(&candidate)?);
        }
        if let Some(session) = session_cache.get(&candidate).and_then(Option::as_ref) {
            return Ok(Some(session.clone()));
        }
    }
    Ok(None)
}
