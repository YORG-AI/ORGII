pub mod exporter;
pub mod external_cli_detection;
pub mod extraction_scheduler;
pub mod history_commands;
pub mod impact_indexer;
pub mod importer;
pub mod paths;
pub mod session_provenance;
pub mod types;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use database::db::get_connection;
use orgtrack_core::canonical::{
    AgentMetadata, AttributionPrecision, CommitLinkRecord, ResourceInteractionRecord,
    SessionActorRecord, SessionCheckpointFileStateRecord, SessionCheckpointRecord,
    SessionDiffChunkRecord, SessionEditArtifactRecord, SessionFinalDiffRecord, SessionRecord,
    RESOURCE_INTERACTION_SCHEMA_VERSION, SESSION_PROVENANCE_HOOK_ORIGIN, SOURCE_ORGII_RUST_AGENTS,
};
use orgtrack_core::edit_extraction::final_diff_from_chunks;
use orgtrack_core::policy::{source_tier_policy, SourceTierPolicy};
use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
use orgtrack_core::projectors::stats::{session_summaries, CoreSessionSummary};
use orgtrack_core::repo_sync::paths::record_id;
use orgtrack_core::sources::imported_history::metadata::{
    SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP, SOURCE_CURSOR_IDE,
};
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
use serde::Serialize;
use tauri::Emitter;
use types::OrgtrackTier;

const ORGTRACK_CALL_LOG_WINDOW: Duration = Duration::from_secs(30);
const ORGTRACK_CALL_LOG_THRESHOLD: u64 = 10;

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
struct CommandCallStats {
    window_started_at: Instant,
    count: u64,
}

static ORGTRACK_CALL_STATS: OnceLock<Mutex<HashMap<&'static str, CommandCallStats>>> =
    OnceLock::new();

fn record_orgtrack_command_call(command: &'static str) {
    let stats = ORGTRACK_CALL_STATS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = match stats.lock() {
        Ok(guard) => guard,
        Err(err) => {
            tracing::warn!(
                command,
                error = %err,
                "[orgtrack] command frequency tracker mutex poisoned"
            );
            return;
        }
    };

    let now = Instant::now();
    let entry = guard.entry(command).or_insert_with(|| CommandCallStats {
        window_started_at: now,
        count: 0,
    });

    if entry.window_started_at.elapsed() >= ORGTRACK_CALL_LOG_WINDOW {
        if entry.count >= ORGTRACK_CALL_LOG_THRESHOLD {
            tracing::warn!(
                command,
                calls = entry.count,
                window_secs = ORGTRACK_CALL_LOG_WINDOW.as_secs(),
                "[orgtrack] high command invocation rate"
            );
        }
        entry.window_started_at = now;
        entry.count = 0;
    }

    entry.count = entry.count.saturating_add(1);
}

#[tauri::command]
pub async fn orgtrack_initialize(
    repo_path: String,
    tier: Option<String>,
    allow_raw_trajectory: Option<bool>,
) -> Result<types::OrgtrackExportResult, String> {
    record_orgtrack_command_call("orgtrack_initialize");
    let tier = validate_tier(tier.as_deref(), allow_raw_trajectory)?;
    tokio::task::spawn_blocking(move || {
        exporter::initialize_orgtrack(&PathBuf::from(repo_path), tier)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_export(
    repo_path: String,
    tier: Option<String>,
    allow_raw_trajectory: Option<bool>,
) -> Result<types::OrgtrackExportResult, String> {
    record_orgtrack_command_call("orgtrack_export");
    let tier = validate_tier(tier.as_deref(), allow_raw_trajectory)?;
    tokio::task::spawn_blocking(move || exporter::export_orgtrack(&PathBuf::from(repo_path), tier))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_sync_core_repo(repo_path: String) -> Result<types::OrgtrackIndex, String> {
    record_orgtrack_command_call("orgtrack_sync_core_repo");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        orgtrack_core::repo_sync::sync_repo_from_store(&store, &PathBuf::from(repo_path))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_file_timeline(
    repo_path: String,
    file_path: String,
) -> Result<Option<types::OrgtrackFileTimeline>, String> {
    record_orgtrack_command_call("orgtrack_get_file_timeline");
    tokio::task::spawn_blocking(move || {
        importer::read_file_timeline(&PathBuf::from(repo_path), &file_path)
    })
    .await
    .map_err(|err| err.to_string())?
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

/// Cheap freshness probe for an open Session Blame panel. The revision is
/// advanced by SQLite triggers, so this remains correct across every writer
/// and after process restarts without retaining an in-memory cache.
#[tauri::command]
pub async fn orgtrack_get_file_session_history_revision(
    app: tauri::AppHandle,
    repo_path: String,
    file_path: String,
) -> Result<u64, String> {
    record_orgtrack_command_call("orgtrack_get_file_session_history_revision");
    tokio::task::spawn_blocking(move || {
        drain_hook_inbox_and_emit(&app, "file_session_history_revision");
        let resolved = session_provenance::resolve_file_resource(&repo_path, &file_path);
        let conn = get_connection().map_err(|err| err.to_string())?;
        SqliteRecordStore::new(&conn).get_file_resource_revision(
            resolved.repository_id.as_deref(),
            &resolved.workspace_path,
            &resolved.repo_relative_path,
        )
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

fn project_file_session_history(
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
        .into_iter()
        .map(|(_, entry)| {
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

#[tauri::command]
pub async fn orgtrack_get_session_summaries(
    workspace_path: Option<String>,
) -> Result<Vec<CoreSessionSummary>, String> {
    record_orgtrack_command_call("orgtrack_get_session_summaries");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let sessions = store.list_sessions(workspace_path.as_deref())?;
        let final_diffs = store.list_final_diffs(None, None)?;
        let commit_links = store.list_commit_links()?;
        let mut summaries = session_summaries(sessions, final_diffs, commit_links);
        apply_runtime_impact_overrides(&mut summaries)?;
        Ok(summaries)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_summary(
    session_id: String,
) -> Result<Option<CoreSessionSummary>, String> {
    record_orgtrack_command_call("orgtrack_get_session_summary");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let sessions: Vec<_> = store
            .list_sessions(None)?
            .into_iter()
            .filter(|session| session.session_id == session_id)
            .collect();
        if sessions.is_empty() {
            return Ok(None);
        }
        let final_diffs = store.list_final_diffs(None, Some(&session_id))?;
        let commit_links = store.list_commit_links_for_session(&session_id)?;
        let mut summaries = session_summaries(sessions, final_diffs, commit_links);
        apply_runtime_impact_overrides(&mut summaries)?;
        Ok(summaries.pop())
    })
    .await
    .map_err(|err| err.to_string())?
}

fn apply_runtime_impact_overrides(summaries: &mut [CoreSessionSummary]) -> Result<(), String> {
    for summary in summaries {
        if summary.source != SOURCE_ORGII_RUST_AGENTS {
            continue;
        }
        if let Some(impact) = impact_indexer::get_session_impact(&summary.session_id)? {
            summary.files_changed = impact.files_changed.max(0) as usize;
            summary.lines_added = impact.lines_added.max(0) as i32;
            summary.lines_removed = impact.lines_removed.max(0) as i32;
        }
    }
    Ok(())
}

/// Delete a session's derived orgtrack artifacts (final diffs, edit artifacts,
/// diff chunks, file changes, checkpoints, commit links) WITHOUT recomputing.
///
/// Used by checkpoint-restore to drop diff rows that no longer match the rewound
/// event stream. This is a pure invalidation, not an analysis pass: the Diff (N)
/// panel reads live from these tables, so clearing them makes it show the clean
/// post-checkpoint state. Subsequent real edits repopulate the tables via the
/// live runtime path.
#[tauri::command]
pub async fn orgtrack_delete_session_artifacts(session_id: String) -> Result<(), String> {
    record_orgtrack_command_call("orgtrack_delete_session_artifacts");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        store.delete_session_artifacts(SOURCE_ORGII_RUST_AGENTS, &session_id)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_source_tier_policy(source: String) -> Result<SourceTierPolicy, String> {
    record_orgtrack_command_call("orgtrack_get_source_tier_policy");
    Ok(source_tier_policy(&source))
}

#[tauri::command]
pub async fn orgtrack_get_extraction_memory_gate(
) -> Result<extraction_scheduler::ExtractionMemoryGateState, String> {
    record_orgtrack_command_call("orgtrack_get_extraction_memory_gate");
    Ok(extraction_scheduler::evaluate_memory_gate(
        &extraction_scheduler::ExtractionMemoryGateConfig::default(),
    ))
}

#[tauri::command]
pub async fn orgtrack_get_session_edit_artifacts(
    source: Option<String>,
    session_id: Option<String>,
) -> Result<Vec<SessionEditArtifactRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_session_edit_artifacts");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        store.list_edit_artifacts(source.as_deref(), session_id.as_deref())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_diff_chunks(
    source: Option<String>,
    session_id: Option<String>,
) -> Result<Vec<SessionDiffChunkRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_session_diff_chunks");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        store.list_diff_chunks(source.as_deref(), session_id.as_deref())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_final_diffs(
    source: Option<String>,
    session_id: Option<String>,
) -> Result<Vec<SessionFinalDiffRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_session_final_diffs");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let final_diffs = store.list_final_diffs(source.as_deref(), session_id.as_deref())?;
        let final_diffs = if let Some(session_id) = session_id.as_deref() {
            let chunks = store.list_diff_chunks(source.as_deref(), Some(session_id))?;
            repair_collapsed_final_diffs(final_diffs, &chunks)
        } else {
            final_diffs
        };
        Ok(final_diffs
            .into_iter()
            .filter(|diff| !is_temporary_diff_path(&diff.file_path))
            .collect())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackDiffReplayPreview {
    pub final_diffs: Vec<SessionFinalDiffRecord>,
    pub submission_commits: Vec<OrgtrackSubmissionCommit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackSubmissionCommit {
    pub sha: String,
    #[serde(rename = "short_sha")]
    pub short_sha: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<serde_json::Value>,
    #[serde(rename = "repoId", skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    #[serde(rename = "repoPath", skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    pub origin: String,
}

fn commit_link_to_submission_commit(
    link: CommitLinkRecord,
    repo_id: &Option<String>,
    repo_path: &Option<String>,
) -> OrgtrackSubmissionCommit {
    let short_sha = link.commit_sha.chars().take(7).collect::<String>();
    OrgtrackSubmissionCommit {
        sha: link.commit_sha,
        short_sha: short_sha.clone(),
        summary: short_sha,
        author: None,
        repo_id: repo_id.clone(),
        repo_path: repo_path.clone(),
        origin: "created".to_string(),
    }
}

fn is_temporary_diff_path(file_path: &str) -> bool {
    let path = Path::new(file_path);
    path.starts_with("/tmp")
        || path
            .components()
            .any(|component| component.as_os_str() == "scratchpad")
}

fn repair_collapsed_final_diffs(
    final_diffs: Vec<SessionFinalDiffRecord>,
    chunks: &[SessionDiffChunkRecord],
) -> Vec<SessionFinalDiffRecord> {
    let mut chunk_stats_by_file: HashMap<&str, (usize, i32, i32)> = HashMap::new();
    let mut chunks_by_file: HashMap<&str, Vec<SessionDiffChunkRecord>> = HashMap::new();
    for chunk in chunks {
        let stats = chunk_stats_by_file
            .entry(chunk.file_path.as_str())
            .or_insert((0, 0, 0));
        stats.0 += 1;
        stats.1 += chunk.lines_added;
        stats.2 += chunk.lines_removed;
        chunks_by_file
            .entry(chunk.file_path.as_str())
            .or_default()
            .push(chunk.clone());
    }

    final_diffs
        .into_iter()
        .map(|diff| {
            let Some((chunk_count, chunk_lines_added, chunk_lines_removed)) =
                chunk_stats_by_file.get(diff.file_path.as_str())
            else {
                return diff;
            };
            let is_collapsed = *chunk_count > 1
                && (diff.lines_added + diff.lines_removed)
                    < (*chunk_lines_added + *chunk_lines_removed)
                && (diff.lines_added < *chunk_lines_added
                    || diff.lines_removed < *chunk_lines_removed);
            if !is_collapsed {
                return diff;
            }
            chunks_by_file
                .get(diff.file_path.as_str())
                .and_then(|file_chunks| {
                    final_diff_from_chunks(
                        &diff.source,
                        &diff.session_id,
                        &diff.file_path,
                        file_chunks,
                    )
                })
                .unwrap_or(diff)
        })
        .collect()
}

#[tauri::command]
pub async fn orgtrack_get_diff_replay_preview(
    source: Option<String>,
    session_id: Option<String>,
    repo_id: Option<String>,
    repo_path: Option<String>,
) -> Result<OrgtrackDiffReplayPreview, String> {
    record_orgtrack_command_call("orgtrack_get_diff_replay_preview");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let mut final_diffs = store.list_final_diffs(source.as_deref(), session_id.as_deref())?;
        if let Some(session_id) = session_id.as_deref() {
            let chunks = store.list_diff_chunks(source.as_deref(), Some(session_id))?;
            final_diffs = repair_collapsed_final_diffs(final_diffs, &chunks);
        }
        let final_diffs = final_diffs
            .into_iter()
            .filter(|diff| !is_temporary_diff_path(&diff.file_path))
            .collect();
        let commit_links = store.list_commit_links()?;
        let commit_links = match session_id {
            Some(session_id) => commit_links
                .into_iter()
                .filter(|link| {
                    link.session_ids
                        .iter()
                        .any(|linked_id| linked_id == &session_id)
                })
                .collect(),
            None => commit_links,
        };
        let submission_commits = commit_links
            .into_iter()
            .map(|link| commit_link_to_submission_commit(link, &repo_id, &repo_path))
            .collect();

        Ok(OrgtrackDiffReplayPreview {
            final_diffs,
            submission_commits,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_commit_links(
    session_id: Option<String>,
) -> Result<Vec<CommitLinkRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_session_commit_links");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let commit_links = store.list_commit_links()?;
        Ok(match session_id {
            Some(session_id) => commit_links
                .into_iter()
                .filter(|link| {
                    link.session_ids
                        .iter()
                        .any(|linked_id| linked_id == &session_id)
                })
                .collect(),
            None => commit_links,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Debug-only: seed an orgtrack commit link for WDIO Submissions-tab specs.
///
/// Commit links are normally derived from a real provider run parsing a
/// `git commit` / `git push` shell event — an async path WDIO specs cannot
/// reach. This wire writes a `CommitLinkRecord` directly (camelCase JSON,
/// `observed_in_terminal_output` reachability) so
/// `orgtrack_get_session_commit_links` returns it and the Submissions tab
/// renders the commit exactly like a live push. Returns Err in release builds.
#[tauri::command]
pub async fn debug_seed_commit_link(session_id: String, commit_sha: String) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("debug_seed_commit_link is only available in debug builds".into());
    }
    if session_id.is_empty() || commit_sha.is_empty() {
        return Err("debug_seed_commit_link: `session_id` and `commit_sha` are required".into());
    }
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let record_id = record_id(&["debug_seed_commit_link", &session_id, &commit_sha]);
        store.upsert_commit_link(&CommitLinkRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id,
            commit_sha,
            file_paths: Vec::new(),
            session_ids: vec![session_id],
            reachability_state: "observed_in_terminal_output".to_string(),
            linked_at: chrono::Utc::now().to_rfc3339(),
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Debug-only: seed an orgtrack final-diff record for WDIO Diff-tab-content specs.
///
/// The extraction scheduler produces `SessionFinalDiffRecord` entries from
/// real edit events; because that path requires a live agent run, WDIO specs
/// cannot seed diff-tab content through it. This wire writes a record with
/// the same shape, but only a `diff` unified-diff string (no old_content /
/// new_content), replicating the bug shape where orgtrack consolidation stores
/// only the unified diff. Returns Err in release builds.
#[tauri::command]
pub async fn debug_seed_final_diff(
    session_id: String,
    source: String,
    file_path: String,
    diff: String,
) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("debug_seed_final_diff is only available in debug builds".into());
    }
    if session_id.is_empty() || source.is_empty() || file_path.is_empty() || diff.is_empty() {
        return Err("debug_seed_final_diff: all fields are required".into());
    }
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        // Seed a minimal session record so on-demand reanalysis
        // (`analyze_requested`) can find this session in `list_sessions` and
        // act on it. Without a session row the reanalyze loop skips it and the
        // seeded residue would never reconcile — which is exactly the path the
        // restore-checkpoint Diff-reconcile spec exercises.
        store.upsert_session(&SessionRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            source: source.clone(),
            source_session_id: session_id.clone(),
            session_id: session_id.clone(),
            title: String::new(),
            status: None,
            created_at: Some(chrono::Utc::now().to_rfc3339()),
            updated_at: Some(chrono::Utc::now().to_rfc3339()),
            completed_at: None,
            workspace_path: None,
            branch: None,
            parent_session_id: None,
            org_member_id: None,
            collaboration_origin: None,
            metadata: AgentMetadata::default(),
        })?;
        let record_id = record_id(&["debug_seed_final_diff", &session_id, &file_path]);
        let words: Vec<&str> = diff.lines().collect();
        let lines_added = words
            .iter()
            .filter(|l| l.starts_with('+') && !l.starts_with("+++"))
            .count() as i32;
        let lines_removed = words
            .iter()
            .filter(|l| l.starts_with('-') && !l.starts_with("---"))
            .count() as i32;
        store.upsert_final_diff(&SessionFinalDiffRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id,
            source,
            session_id,
            file_path,
            baseline_event_id: None,
            final_event_id: None,
            old_content: None,
            new_content: None,
            diff: Some(diff),
            lines_added,
            lines_removed,
            is_deleted: false,
            quality: orgtrack_core::canonical::ArtifactQuality::PatchReversible,
            differs_from_summed_chunks: false,
            computed_at: chrono::Utc::now().to_rfc3339(),
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_checkpoints(
    source: Option<String>,
    session_id: Option<String>,
) -> Result<Vec<SessionCheckpointRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_session_checkpoints");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        store.list_session_checkpoints(source.as_deref(), session_id.as_deref())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_checkpoint_file_states(
    checkpoint_id: String,
) -> Result<Vec<SessionCheckpointFileStateRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_checkpoint_file_states");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        store.list_checkpoint_file_states(&checkpoint_id)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{is_temporary_diff_path, project_file_session_history};
    use orgtrack_core::canonical::{
        AgentMetadata, AttributionPrecision, CollaborationSessionOrigin, ResourceAction,
        ResourceInteractionCaptureMethod, ResourceInteractionOutcome, ResourceInteractionRecord,
        SessionActorRecord, SessionRecord, RESOURCE_INTERACTION_SCHEMA_VERSION,
        SESSION_ACTOR_SCHEMA_VERSION, SESSION_PROVENANCE_HOOK_ORIGIN,
    };
    use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
    use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
    use rusqlite::Connection;

    #[test]
    fn hides_tmp_and_scratchpad_diff_paths() {
        assert!(is_temporary_diff_path("/tmp/stale_probe.txt"));
        assert!(is_temporary_diff_path(
            "/private/var/folders/sj/orgii-501/project/sdeagent-id/scratchpad/stale_probe.txt"
        ));
        assert!(!is_temporary_diff_path(
            "/Users/vinceorz/Projects/ORG2/src/main.ts"
        ));
        assert!(!is_temporary_diff_path(
            "/Users/vinceorz/Downloads/notes.txt"
        ));
    }

    #[test]
    fn file_session_history_groups_actions_and_preserves_strongest_attribution() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        SqliteRecordStore::init_tables(&conn).expect("initialize orgtrack schema");
        let store = SqliteRecordStore::new(&conn);
        store
            .upsert_session(&SessionRecord {
                schema_version: ORGTRACK_SCHEMA_VERSION,
                source: "codex_app".to_string(),
                source_session_id: "source-1".to_string(),
                session_id: "session-1".to_string(),
                title: "Implement provenance".to_string(),
                status: None,
                created_at: None,
                updated_at: None,
                completed_at: None,
                workspace_path: Some("/repo".to_string()),
                branch: None,
                parent_session_id: None,
                org_member_id: None,
                collaboration_origin: Some(CollaborationSessionOrigin {
                    org_id: "org-1".to_string(),
                    session_row_id: "org-1:user-1:source-1".to_string(),
                    source_session_id: "source-1".to_string(),
                    owner_member_id: "user-1".to_string(),
                    owner_display_name: "Teammate".to_string(),
                }),
                metadata: AgentMetadata {
                    origin: Some(SESSION_PROVENANCE_HOOK_ORIGIN.to_string()),
                    ..AgentMetadata::default()
                },
            })
            .expect("upsert session");

        let interaction = |id: &str,
                           action: ResourceAction,
                           at: &str,
                           actor: Option<&str>,
                           precision: AttributionPrecision| {
            ResourceInteractionRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                interaction_id: id.to_string(),
                source: "codex_app".to_string(),
                source_session_id: Some("source-1".to_string()),
                source_event_id: Some(id.to_string()),
                session_id: "session-1".to_string(),
                turn_id: None,
                actor_id: actor.map(str::to_string),
                resource_id: "resource-1".to_string(),
                action,
                outcome: ResourceInteractionOutcome::Succeeded,
                occurred_at: at.to_string(),
                capture_method: ResourceInteractionCaptureMethod::Hook,
                attribution_precision: precision,
            }
        };
        let history = project_file_session_history(
            &store,
            vec![
                interaction(
                    "read",
                    ResourceAction::Read,
                    "2026-07-14T01:00:00Z",
                    Some("agent-1"),
                    AttributionPrecision::SessionOnly,
                ),
                interaction(
                    "write",
                    ResourceAction::Write,
                    "2026-07-14T02:00:00Z",
                    Some("agent-1"),
                    AttributionPrecision::Exact,
                ),
            ],
        )
        .expect("project history");

        assert_eq!(history.len(), 1);
        assert_eq!(history[0].session_label, "Implement provenance");
        assert_eq!(history[0].transcript_session_id, None);
        assert_eq!(history[0].interaction_count, 2);
        assert_eq!(history[0].action_counts.get("read"), Some(&1));
        assert_eq!(history[0].action_counts.get("write"), Some(&1));
        assert_eq!(history[0].attribution_precision, "exact");
        assert_eq!(
            history[0]
                .collaboration_origin
                .as_ref()
                .map(|origin| origin.session_row_id.as_str()),
            Some("org-1:user-1:source-1")
        );
        assert!(history[0].participants.is_empty());
    }

    #[test]
    fn file_session_history_hides_subagent_that_replays_the_root_transcript() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        SqliteRecordStore::init_tables(&conn).expect("initialize orgtrack schema");
        let store = SqliteRecordStore::new(&conn);
        store
            .upsert_session(&SessionRecord {
                schema_version: ORGTRACK_SCHEMA_VERSION,
                source: "codex_app".to_string(),
                source_session_id: "parent".to_string(),
                session_id: "codexapp-parent".to_string(),
                title: "Parent".to_string(),
                status: None,
                created_at: None,
                updated_at: None,
                completed_at: None,
                workspace_path: Some("/repo".to_string()),
                branch: None,
                parent_session_id: None,
                org_member_id: None,
                collaboration_origin: None,
                metadata: AgentMetadata::default(),
            })
            .expect("upsert root session");
        store
            .upsert_session_actor(&SessionActorRecord {
                schema_version: SESSION_ACTOR_SCHEMA_VERSION,
                actor_record_id: "actor-record-root".to_string(),
                source: "codex_app".to_string(),
                source_session_id: "parent".to_string(),
                session_id: "codexapp-parent".to_string(),
                turn_id: Some("turn-1".to_string()),
                actor_id: "agent-1".to_string(),
                actor_type: Some("default".to_string()),
                started_at: Some("2026-07-14T01:00:00Z".to_string()),
                stopped_at: Some("2026-07-14T01:10:00Z".to_string()),
                transcript_session_id: Some("codexapp-parent".to_string()),
                transcript_path: Some("/local/root.jsonl".to_string()),
            })
            .expect("upsert root-pointing actor");

        let history = project_file_session_history(
            &store,
            vec![ResourceInteractionRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                interaction_id: "interaction-root-actor".to_string(),
                source: "codex_app".to_string(),
                source_session_id: Some("parent".to_string()),
                source_event_id: Some("tool-1".to_string()),
                session_id: "codexapp-parent".to_string(),
                turn_id: Some("turn-1".to_string()),
                actor_id: Some("agent-1".to_string()),
                resource_id: "resource-1".to_string(),
                action: ResourceAction::Read,
                outcome: ResourceInteractionOutcome::Succeeded,
                occurred_at: "2026-07-14T01:05:00Z".to_string(),
                capture_method: ResourceInteractionCaptureMethod::Hook,
                attribution_precision: AttributionPrecision::Exact,
            }],
        )
        .expect("project root-pointing actor history");

        assert_eq!(history.len(), 1);
        assert_eq!(
            history[0].transcript_session_id.as_deref(),
            Some("codexapp-parent")
        );
        assert_eq!(history[0].interaction_count, 1);
        assert!(history[0].participants.is_empty());
    }

    #[test]
    fn file_session_history_resolves_subagent_to_loadable_child_transcript() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        SqliteRecordStore::init_tables(&conn).expect("initialize orgtrack schema");
        let store = SqliteRecordStore::new(&conn);
        for (session_id, source_session_id, title, parent_session_id) in [
            ("claudecodeapp-parent", "parent", "Parent", None),
            (
                "claudecodeapp-agent-1",
                "agent-1",
                "Research subagent",
                Some("claudecodeapp-parent"),
            ),
        ] {
            store
                .upsert_session(&SessionRecord {
                    schema_version: ORGTRACK_SCHEMA_VERSION,
                    source: "claude_code".to_string(),
                    source_session_id: source_session_id.to_string(),
                    session_id: session_id.to_string(),
                    title: title.to_string(),
                    status: None,
                    created_at: None,
                    updated_at: None,
                    completed_at: None,
                    workspace_path: Some("/repo".to_string()),
                    branch: None,
                    parent_session_id: parent_session_id.map(str::to_string),
                    org_member_id: None,
                    collaboration_origin: None,
                    metadata: AgentMetadata::default(),
                })
                .expect("upsert session");
        }

        let history = project_file_session_history(
            &store,
            vec![
                ResourceInteractionRecord {
                    schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                    interaction_id: "interaction-hook".to_string(),
                    source: "claude_code".to_string(),
                    source_session_id: Some("parent".to_string()),
                    source_event_id: Some("tool-1".to_string()),
                    session_id: "claudecodeapp-parent".to_string(),
                    turn_id: None,
                    actor_id: None,
                    resource_id: "resource-1".to_string(),
                    action: ResourceAction::Read,
                    outcome: ResourceInteractionOutcome::Succeeded,
                    occurred_at: "2026-07-14T01:00:00Z".to_string(),
                    capture_method: ResourceInteractionCaptureMethod::Hook,
                    attribution_precision: AttributionPrecision::SessionOnly,
                },
                ResourceInteractionRecord {
                    schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                    interaction_id: "interaction-reconciled".to_string(),
                    source: "claude_code".to_string(),
                    source_session_id: Some("agent-1".to_string()),
                    source_event_id: Some("tool-1".to_string()),
                    session_id: "claudecodeapp-agent-1".to_string(),
                    turn_id: None,
                    actor_id: Some("1".to_string()),
                    resource_id: "resource-1".to_string(),
                    action: ResourceAction::Read,
                    outcome: ResourceInteractionOutcome::Succeeded,
                    occurred_at: "2026-07-14T01:00:01Z".to_string(),
                    capture_method: ResourceInteractionCaptureMethod::Reconciled,
                    attribution_precision: AttributionPrecision::Exact,
                },
            ],
        )
        .expect("project history");

        assert_eq!(history.len(), 1);
        assert_eq!(history[0].session_id, "claudecodeapp-parent");
        assert_eq!(history[0].session_label, "Parent");
        assert_eq!(history[0].interaction_count, 1);
        assert_eq!(history[0].participants.len(), 1);
        let participant = &history[0].participants[0];
        assert_eq!(participant.session_id, "claudecodeapp-agent-1");
        assert_eq!(
            participant.transcript_session_id.as_deref(),
            Some("claudecodeapp-agent-1")
        );
        assert_eq!(
            participant.parent_session_id.as_deref(),
            Some("claudecodeapp-parent")
        );
        assert_eq!(participant.session_label, "Research subagent");
        assert_eq!(participant.participant_kind, "subagent");
        assert_eq!(participant.actor_id.as_deref(), Some("1"));
        assert_eq!(
            participant.actor_label.as_deref(),
            Some("Research subagent")
        );
    }

    #[test]
    fn file_session_history_correlates_codex_turn_to_loadable_actor_transcript() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        SqliteRecordStore::init_tables(&conn).expect("initialize orgtrack schema");
        let store = SqliteRecordStore::new(&conn);
        for (session_id, source_session_id, title, parent_session_id) in [
            ("codexapp-parent", "parent", "Parent", None),
            (
                "codexapp-child-rollout",
                "child-rollout",
                "Explorer",
                Some("codexapp-parent"),
            ),
        ] {
            store
                .upsert_session(&SessionRecord {
                    schema_version: ORGTRACK_SCHEMA_VERSION,
                    source: "codex_app".to_string(),
                    source_session_id: source_session_id.to_string(),
                    session_id: session_id.to_string(),
                    title: title.to_string(),
                    status: None,
                    created_at: None,
                    updated_at: None,
                    completed_at: None,
                    workspace_path: Some("/repo".to_string()),
                    branch: None,
                    parent_session_id: parent_session_id.map(str::to_string),
                    org_member_id: None,
                    collaboration_origin: None,
                    metadata: AgentMetadata::default(),
                })
                .expect("upsert session");
        }
        store
            .upsert_session_actor(&SessionActorRecord {
                schema_version: SESSION_ACTOR_SCHEMA_VERSION,
                actor_record_id: "actor-record-1".to_string(),
                source: "codex_app".to_string(),
                source_session_id: "parent".to_string(),
                session_id: "codexapp-parent".to_string(),
                turn_id: Some("turn-1".to_string()),
                actor_id: "agent-1".to_string(),
                actor_type: Some("explorer".to_string()),
                started_at: Some("2026-07-14T01:00:00Z".to_string()),
                stopped_at: Some("2026-07-14T01:10:00Z".to_string()),
                transcript_session_id: Some("codexapp-child-rollout".to_string()),
                transcript_path: Some("/local/child-rollout.jsonl".to_string()),
            })
            .expect("upsert actor mapping");

        let history = project_file_session_history(
            &store,
            vec![ResourceInteractionRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                interaction_id: "interaction-hook".to_string(),
                source: "codex_app".to_string(),
                source_session_id: Some("parent".to_string()),
                source_event_id: Some("tool-1".to_string()),
                session_id: "codexapp-parent".to_string(),
                turn_id: Some("turn-1".to_string()),
                actor_id: None,
                resource_id: "resource-1".to_string(),
                action: ResourceAction::Read,
                outcome: ResourceInteractionOutcome::Succeeded,
                occurred_at: "2026-07-14T01:05:00Z".to_string(),
                capture_method: ResourceInteractionCaptureMethod::Hook,
                attribution_precision: AttributionPrecision::SessionOnly,
            }],
        )
        .expect("project history");

        assert_eq!(history.len(), 1);
        assert_eq!(
            history[0].transcript_session_id.as_deref(),
            Some("codexapp-parent")
        );
        let participant = &history[0].participants[0];
        assert_eq!(participant.participant_kind, "subagent");
        assert_eq!(participant.actor_id.as_deref(), Some("agent-1"));
        assert_eq!(participant.actor_label.as_deref(), Some("Explorer"));
        assert_eq!(participant.attribution_precision, "correlated");
        assert_eq!(participant.session_id, "codexapp-child-rollout");
        assert_eq!(
            participant.transcript_session_id.as_deref(),
            Some("codexapp-child-rollout")
        );

        let exact_history = project_file_session_history(
            &store,
            vec![ResourceInteractionRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                interaction_id: "interaction-exact-child".to_string(),
                source: "codex_app".to_string(),
                source_session_id: Some("child-rollout".to_string()),
                source_event_id: Some("tool-2".to_string()),
                session_id: "codexapp-child-rollout".to_string(),
                turn_id: Some("turn-1".to_string()),
                actor_id: Some("agent-1".to_string()),
                resource_id: "resource-1".to_string(),
                action: ResourceAction::Write,
                outcome: ResourceInteractionOutcome::Succeeded,
                occurred_at: "2026-07-14T01:06:00Z".to_string(),
                capture_method: ResourceInteractionCaptureMethod::Hook,
                attribution_precision: AttributionPrecision::Exact,
            }],
        )
        .expect("project exact child history");
        assert_eq!(exact_history.len(), 1);
        let exact_participant = &exact_history[0].participants[0];
        assert_eq!(exact_participant.session_id, "codexapp-child-rollout");
        assert_eq!(exact_participant.actor_label.as_deref(), Some("Explorer"));
        assert_eq!(
            exact_participant.transcript_session_id.as_deref(),
            Some("codexapp-child-rollout")
        );
    }
}

fn validate_tier(
    tier: Option<&str>,
    allow_raw_trajectory: Option<bool>,
) -> Result<OrgtrackTier, String> {
    let tier = OrgtrackTier::from_optional_str(tier)?;
    if tier.includes_trajectory() && allow_raw_trajectory != Some(true) {
        return Err(
            "Trajectory export can include prompts, tool payloads, file contents, and secrets. Pass allowRawTrajectory=true to opt in."
                .to_string(),
        );
    }
    Ok(tier)
}
