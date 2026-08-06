use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, MutexGuard};

use core_types::activity::ActivityChunk;
use core_types::extracted::ExtractedData;
use database::db::get_connection;
use orgtrack_core::canonical::{
    AgentMetadata, ArtifactQuality, CommitLinkRecord, FileChangeRecord, SessionCheckpointRecord,
    SessionRecord, SOURCE_ORGII_CLI_SESSIONS, SOURCE_ORGII_RUST_AGENTS,
};
use orgtrack_core::edit_extraction::{
    artifacts_from_extracted_edit, final_diff_from_chunks, EditArtifactContext,
};
use orgtrack_core::policy::{source_tier_policy, TierSupport, SOURCE_CURSOR_IDE};
use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
use orgtrack_core::repo_sync::paths::{path_hash, record_id};
use orgtrack_core::sources::claude_code::history as claude_code_history;
use orgtrack_core::sources::codex::app as codex_app_history;
use orgtrack_core::sources::cursor_ide::history as cursor_ide_history;
use orgtrack_core::sources::imported_history::metadata::{
    SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP, SOURCE_OPENCODE, SOURCE_WINDSURF,
};
use orgtrack_core::sources::imported_history::{
    ImportedHistorySessionRow, IMPORTED_HISTORY_CATEGORY,
};
use orgtrack_core::sources::opencode::history as opencode_history;
use orgtrack_core::sources::windsurf::history as windsurf_history;
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};

use crate::agent_sessions::event_pipeline::commands::event_conversion::{
    backfill_subagent_links, backfill_tool_inputs_from_messages, cached_event_to_session_event,
    dedup_by_call_id,
};
use crate::agent_sessions::event_pipeline::extractors::extract_event_data;
use crate::agent_sessions::event_pipeline::extractors::git_artifacts::{
    parse_git_artifacts, GitArtifactParseInput,
};
use crate::agent_sessions::event_pipeline::extractors::types::GitArtifactKind;
use crate::agent_sessions::event_pipeline::ingestion;
use crate::agent_sessions::event_pipeline::ingestion::types::RawActivityChunk;
use crate::agent_sessions::unified_stats::conversion::{
    os_session_to_aggregate_record, sde_session_to_aggregate_record, AgentMetadataResolver,
};
use crate::agent_sessions::unified_stats::orgtrack_adapter::upsert_aggregate_sessions;
use crate::orgtrack::extraction_scheduler::{
    evaluate_memory_gate, ExtractionMemoryDecision, ExtractionMemoryGateConfig,
};

static ANALYSIS_LOCK: Mutex<()> = Mutex::new(());
const MAX_EVENTS_PER_SESSION: usize = 500;
const MAX_ON_DEMAND_SESSIONS: usize = 1;
const ANALYSIS_HYDRATION_PAGE_SIZE: usize = 200;
const ANALYSIS_ARTIFACT_VERSION: u32 = 2;

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisBackfillStats {
    pub scanned_sessions: usize,
    pub analyzed_sessions: usize,
    pub skipped_sessions: usize,
    pub failed_sessions: usize,
}

fn wait_for_analysis_slot() -> Result<MutexGuard<'static, ()>, String> {
    ANALYSIS_LOCK
        .lock()
        .map_err(|_| "Orgtrack analysis lock is poisoned".to_string())
}

pub(crate) fn analyze_requested(
    workspace_path: Option<&str>,
    session_id: Option<&str>,
    rebuild: bool,
) -> Result<AnalysisBackfillStats, String> {
    match session_id {
        Some(session_id) => analyze_sessions(
            AnalysisSelection::Session {
                workspace_path,
                session_id,
            },
            rebuild,
        ),
        None => analyze_sessions(AnalysisSelection::Workspace { workspace_path }, rebuild),
    }
}

enum AnalysisSelection<'a> {
    Workspace {
        workspace_path: Option<&'a str>,
    },
    Session {
        workspace_path: Option<&'a str>,
        session_id: &'a str,
    },
}

fn analyze_sessions(
    selection: AnalysisSelection<'_>,
    rebuild: bool,
) -> Result<AnalysisBackfillStats, String> {
    let _analysis_slot = wait_for_analysis_slot()?;
    let mut stats = AnalysisBackfillStats::default();
    let memory_config = ExtractionMemoryGateConfig::default();
    hydrate_analyzable_session_records()?;

    let conn = get_connection().map_err(|err| err.to_string())?;
    let store = SqliteRecordStore::new(&conn);
    let workspace_path = match selection {
        AnalysisSelection::Workspace { workspace_path } => workspace_path,
        AnalysisSelection::Session { workspace_path, .. } => workspace_path,
    };
    let mut sessions = store.list_sessions(workspace_path)?;
    sort_sessions_recent_first(&mut sessions);
    if let AnalysisSelection::Session { session_id, .. } = selection {
        sessions.retain(|session| session.session_id == session_id);
    }
    let sessions_with_current_analysis = analyzed_watermarks(&store, workspace_path)?;
    for session in sessions.into_iter().take(MAX_ON_DEMAND_SESSIONS) {
        stats.scanned_sessions += 1;
        if should_pause(&memory_config) {
            break;
        }
        if !rebuild && session.source == SOURCE_ORGII_RUST_AGENTS {
            stats.skipped_sessions += 1;
            continue;
        }
        if !rebuild && !session_needs_analysis(&session, &sessions_with_current_analysis) {
            stats.skipped_sessions += 1;
            continue;
        }
        if source_tier_policy(&session.source).tier2 == TierSupport::Unsupported {
            stats.skipped_sessions += 1;
            continue;
        }
        match catch_unwind(AssertUnwindSafe(|| analyze_session(&store, &session))) {
            Ok(Ok(true)) => stats.analyzed_sessions += 1,
            Ok(Ok(false)) => stats.skipped_sessions += 1,
            Ok(Err(err)) => {
                stats.failed_sessions += 1;
                tracing::warn!(
                    session_id = %session.session_id,
                    source = %session.source,
                    error = %err,
                    "[orgtrack_analysis] failed to analyze requested session"
                );
            }
            Err(_) => {
                stats.failed_sessions += 1;
                tracing::error!(
                    session_id = %session.session_id,
                    source = %session.source,
                    "[orgtrack_analysis] requested session analysis panicked"
                );
            }
        }
    }
    Ok(stats)
}

fn sort_sessions_recent_first(sessions: &mut [SessionRecord]) {
    sessions.sort_by(|session_a, session_b| {
        session_b
            .updated_at
            .cmp(&session_a.updated_at)
            .then_with(|| session_b.created_at.cmp(&session_a.created_at))
            .then_with(|| session_b.session_id.cmp(&session_a.session_id))
    });
}

/// Map of session id → the `updated_at` watermark recorded the last time the
/// session was analyzed (from the analysis-marker checkpoint). A session is
/// considered fully analyzed only up to this point; if it has been updated
/// since (new commits/pushes/edits), the gate re-analyzes it.
///
/// Sessions that have artifacts (final diffs / commit links) but no marker are
/// intentionally *omitted* so they get re-analyzed once and gain a proper
/// watermarked marker — older markers predate the watermark field.
fn analyzed_watermarks(
    store: &SqliteRecordStore<'_>,
    workspace_path: Option<&str>,
) -> Result<BTreeMap<String, Option<String>>, String> {
    let mut watermarks: BTreeMap<String, Option<String>> = BTreeMap::new();
    for checkpoint in store.list_session_checkpoints(None, None)? {
        let Some(metadata) = checkpoint
            .metadata_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        else {
            continue;
        };
        let is_current_version = metadata
            .get("analysisArtifactVersion")
            .and_then(serde_json::Value::as_u64)
            == Some(u64::from(ANALYSIS_ARTIFACT_VERSION));
        if !is_current_version {
            continue;
        }
        if let Some(workspace_path) = workspace_path {
            let checkpoint_workspace = metadata
                .get("workspacePath")
                .and_then(serde_json::Value::as_str);
            if checkpoint_workspace != Some(workspace_path) {
                continue;
            }
        }
        let watermark = metadata
            .get("analyzedThroughUpdatedAt")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        watermarks.insert(checkpoint.session_id, watermark);
    }
    Ok(watermarks)
}

/// A session needs analysis when it has never been analyzed (no marker), or
/// when it has been updated since the last analysis watermark. The watermark
/// is `None` for legacy markers written before the field existed — those are
/// re-analyzed once to backfill the watermark.
fn session_needs_analysis(
    session: &SessionRecord,
    analyzed_watermarks: &BTreeMap<String, Option<String>>,
) -> bool {
    match analyzed_watermarks.get(&session.session_id) {
        None => true,
        Some(None) => true,
        Some(Some(watermark)) => match session.updated_at.as_deref() {
            Some(updated_at) => updated_at > watermark.as_str(),
            None => false,
        },
    }
}

fn should_pause(config: &ExtractionMemoryGateConfig) -> bool {
    matches!(
        evaluate_memory_gate(config).decision,
        ExtractionMemoryDecision::PauseSoft
            | ExtractionMemoryDecision::PauseHard
            | ExtractionMemoryDecision::PauseSystemMemory
    )
}

fn hydrate_analyzable_session_records() -> Result<(), String> {
    hydrate_rust_agent_session_records()?;
    hydrate_external_session_records()
}

fn hydrate_rust_agent_session_records() -> Result<(), String> {
    let mut records = Vec::new();
    let mut resolver = AgentMetadataResolver::new();
    let sde_filter = agent_core::session::SessionListFilter {
        type_name: Some(agent_core::session::persistence::session_type::CODING.to_string()),
        ..Default::default()
    };
    for session in agent_core::session::persistence::list_sessions(&sde_filter)
        .map_err(|err| format!("Failed to list SDE Agent sessions for analysis hydration: {err}"))?
    {
        records.push(sde_session_to_aggregate_record(session, &mut resolver));
    }

    let org_member_filter = agent_core::session::SessionListFilter {
        type_name: Some(agent_core::session::persistence::session_type::ORG_MEMBER.to_string()),
        ..Default::default()
    };
    for session in
        agent_core::session::persistence::list_sessions(&org_member_filter).map_err(|err| {
            format!("Failed to list Agent Org member sessions for analysis hydration: {err}")
        })?
    {
        records.push(sde_session_to_aggregate_record(session, &mut resolver));
    }

    let os_filter = agent_core::session::SessionListFilter {
        type_name: Some(agent_core::session::persistence::session_type::DESKTOP.to_string()),
        ..Default::default()
    };
    for session in agent_core::session::persistence::list_sessions(&os_filter)
        .map_err(|err| format!("Failed to list OS Agent sessions for analysis hydration: {err}"))?
    {
        records.push(os_session_to_aggregate_record(session, &mut resolver));
    }

    upsert_aggregate_sessions(&records)
}

fn hydrate_external_session_records() -> Result<(), String> {
    let mut conn = get_connection().map_err(|err| err.to_string())?;

    let cursor_sessions = cursor_ide_history::list_cursor_ide_sessions_paginated(
        &mut conn,
        ANALYSIS_HYDRATION_PAGE_SIZE,
        0,
    )?;
    {
        let store = SqliteRecordStore::new(&conn);
        for row in cursor_sessions.sessions {
            store.upsert_session(&cursor_row_to_session_record(row))?;
        }
    }

    let imported_pages = [
        claude_code_history::list_claude_code_history_sessions_paginated(
            &mut conn,
            ANALYSIS_HYDRATION_PAGE_SIZE,
            0,
        )?,
        codex_app_history::list_codex_app_sessions_paginated(
            &mut conn,
            ANALYSIS_HYDRATION_PAGE_SIZE,
            0,
        )?,
        opencode_history::list_opencode_history_sessions_paginated(
            &mut conn,
            ANALYSIS_HYDRATION_PAGE_SIZE,
            0,
        )?,
        windsurf_history::list_windsurf_history_sessions_paginated(
            &mut conn,
            ANALYSIS_HYDRATION_PAGE_SIZE,
            0,
        )?,
    ];
    let store = SqliteRecordStore::new(&conn);
    for page in imported_pages {
        for row in page.sessions {
            store.upsert_session(&imported_row_to_session_record(row))?;
        }
    }
    Ok(())
}

fn cursor_row_to_session_record(row: cursor_ide_history::CursorIdeSessionRow) -> SessionRecord {
    let source_session_id = row
        .session_id
        .strip_prefix("cursoride-")
        .unwrap_or(&row.session_id)
        .to_string();
    SessionRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        source: SOURCE_CURSOR_IDE.to_string(),
        source_session_id,
        session_id: row.session_id,
        title: row.name,
        status: Some(row.status.clone()),
        created_at: Some(row.created_at),
        updated_at: Some(row.updated_at.clone()),
        completed_at: if row.is_active {
            None
        } else {
            Some(row.updated_at)
        },
        workspace_path: row.repo_path,
        branch: row.branch,
        parent_session_id: None,
        org_member_id: None,
        metadata: AgentMetadata {
            dispatch_category: Some("cursor_ide".to_string()),
            model: row.model,
            origin: Some(SOURCE_CURSOR_IDE.to_string()),
            display_name: Some("Cursor IDE".to_string()),
            ..AgentMetadata::default()
        },
        journey: Default::default(),
    }
}

fn imported_row_to_session_record(row: ImportedHistorySessionRow) -> SessionRecord {
    let source = imported_source_for_session_id(&row.session_id);
    let source_session_id = imported_source_session_id(&row.session_id);
    SessionRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        source: source.to_string(),
        source_session_id,
        session_id: row.session_id,
        title: row.name,
        status: Some(row.status),
        created_at: Some(row.created_at),
        updated_at: Some(row.updated_at.clone()),
        completed_at: if row.is_active {
            None
        } else {
            Some(row.updated_at)
        },
        workspace_path: row.repo_path,
        branch: row.branch,
        parent_session_id: None,
        org_member_id: None,
        metadata: AgentMetadata {
            dispatch_category: Some(IMPORTED_HISTORY_CATEGORY.to_string()),
            model: row.model,
            origin: Some(source.to_string()),
            display_name: Some(source.to_string()),
            ..AgentMetadata::default()
        },
        journey: Default::default(),
    }
}

fn imported_source_for_session_id(session_id: &str) -> &'static str {
    if session_id.starts_with("claudecodeapp-") {
        SOURCE_CLAUDE_CODE
    } else if session_id.starts_with("codexapp-") {
        SOURCE_CODEX_APP
    } else if session_id.starts_with("opencodeapp-") {
        SOURCE_OPENCODE
    } else if session_id.starts_with("windsurfapp-") {
        SOURCE_WINDSURF
    } else {
        IMPORTED_HISTORY_CATEGORY
    }
}

fn imported_source_session_id(session_id: &str) -> String {
    session_id
        .strip_prefix("claudecodeapp-")
        .or_else(|| session_id.strip_prefix("codexapp-"))
        .or_else(|| session_id.strip_prefix("opencodeapp-"))
        .or_else(|| session_id.strip_prefix("windsurfapp-"))
        .unwrap_or(session_id)
        .to_string()
}

fn delete_backfill_owned_artifacts(
    store: &SqliteRecordStore<'_>,
    session: &SessionRecord,
) -> Result<(), String> {
    if session.source == SOURCE_ORGII_RUST_AGENTS {
        store.delete_session_derived_artifacts(&session.source, &session.session_id)
    } else {
        store.delete_session_artifacts(&session.source, &session.session_id)
    }
}

fn analyze_session(store: &SqliteRecordStore<'_>, session: &SessionRecord) -> Result<bool, String> {
    let loaded = load_analysis_payload(session)?;
    if loaded.events.is_empty() {
        delete_backfill_owned_artifacts(store, session)?;
        upsert_analysis_marker_checkpoint(store, session)?;
        return Ok(false);
    }

    let mut edit_events = Vec::new();
    let mut commit_links = Vec::new();
    for (sequence_index, (event_id, extracted)) in loaded.events.into_iter().enumerate() {
        match extracted {
            ExtractedData::Edit(edit) => edit_events.push((sequence_index, event_id, edit)),
            ExtractedData::Shell(shell) => {
                commit_links.extend(commit_links_from_shell_event(
                    session,
                    &event_id,
                    sequence_index,
                    &shell,
                ));
            }
            _ => {}
        }
    }

    delete_backfill_owned_artifacts(store, session)?;
    if edit_events.is_empty() && commit_links.is_empty() {
        upsert_analysis_marker_checkpoint(store, session)?;
        return Ok(false);
    }

    let mut chunks_by_file: BTreeMap<
        String,
        Vec<orgtrack_core::canonical::SessionDiffChunkRecord>,
    > = BTreeMap::new();
    let mut wrote_any = false;
    let mut wrote_final_diff = false;
    for (sequence_index, event_id, edit) in edit_events {
        let context = EditArtifactContext {
            source: session.source.clone(),
            source_session_id: Some(session.source_session_id.clone()),
            session_id: session.session_id.clone(),
            source_event_id: Some(event_id.clone()),
            turn_id: None,
            execution_turn_id: None,
            sequence_index: sequence_index as i64,
            timestamp: None,
            workspace_path: session.workspace_path.clone(),
            metadata: session.metadata.clone(),
        };
        let artifacts = artifacts_from_extracted_edit(&context, &edit);
        for artifact in &artifacts.edits {
            store.upsert_edit_artifact(artifact)?;
            store.upsert_file_change(&FileChangeRecord {
                schema_version: ORGTRACK_SCHEMA_VERSION,
                record_id: record_id(&[
                    "analysis_file_change",
                    &artifact.source,
                    &artifact.session_id,
                    &artifact.record_id,
                ]),
                source: artifact.source.clone(),
                session_id: artifact.session_id.clone(),
                file_path: artifact.file_path.clone(),
                path_hash: path_hash(&artifact.file_path),
                function_name: None,
                node_type: None,
                start_line: artifact.start_line,
                end_line: artifact.end_line,
                lines_added: artifact.lines_added,
                lines_removed: artifact.lines_removed,
                timestamp: sequence_index as i64,
                tier: orgtrack_core::privacy::OrgtrackTier::Meta,
                metadata: artifact.metadata.clone(),
            })?;
            wrote_any = true;
        }
        for chunk in artifacts.chunks {
            chunks_by_file
                .entry(chunk.file_path.clone())
                .or_default()
                .push(chunk.clone());
            store.upsert_diff_chunk(&chunk)?;
        }
    }
    for (file_path, chunks) in chunks_by_file {
        if let Some(final_diff) =
            final_diff_from_chunks(&session.source, &session.session_id, &file_path, &chunks)
        {
            store.upsert_final_diff(&final_diff)?;
            wrote_final_diff = true;
            wrote_any = true;
        }
    }
    if !wrote_final_diff && !commit_links.is_empty() {
        tracing::debug!(
            session_id = %session.session_id,
            source = %session.source,
            "[orgtrack_analysis] commit-only analysis produced no final diff"
        );
    }
    for link in commit_links {
        store.upsert_commit_link(&link)?;
        wrote_any = true;
    }
    if wrote_any {
        upsert_analysis_boundary_checkpoints(store, session)?;
    }
    upsert_analysis_marker_checkpoint(store, session)?;
    Ok(wrote_any)
}

fn commit_links_from_shell_event(
    session: &SessionRecord,
    event_id: &str,
    sequence_index: usize,
    shell: &core_types::extracted::ExtractedShellData,
) -> Vec<CommitLinkRecord> {
    parse_git_artifacts(GitArtifactParseInput {
        command: &shell.command,
        output: shell.output.as_deref().or(shell.stream_output.as_deref()),
        exit_code: shell.exit_code,
    })
    .into_iter()
    .filter(|artifact| artifact.kind == GitArtifactKind::Commit)
    .filter_map(|artifact| {
        let commit_sha = artifact.sha.or(artifact.short_sha)?;
        let linked_at = chrono::Utc::now().to_rfc3339();
        Some(CommitLinkRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id: record_id(&[
                "analysis_commit_link",
                &session.source,
                &session.session_id,
                event_id,
                &sequence_index.to_string(),
                &commit_sha,
            ]),
            commit_sha,
            file_paths: Vec::new(),
            session_ids: vec![session.session_id.clone()],
            reachability_state: "observed_in_terminal_output".to_string(),
            linked_at,
        })
    })
    .collect()
}

#[derive(Debug, Default)]
struct AnalysisPayload {
    events: Vec<(String, ExtractedData)>,
}

fn load_analysis_payload(session: &SessionRecord) -> Result<AnalysisPayload, String> {
    match session.source.as_str() {
        SOURCE_CURSOR_IDE => load_external_activity_analysis_payload(
            &session.session_id,
            cursor_ide_history::load_history_for_session(&session.session_id)?,
        ),
        SOURCE_CLAUDE_CODE => {
            let conn = get_connection().map_err(|err| err.to_string())?;
            load_external_activity_analysis_payload(
                &session.session_id,
                claude_code_history::load_claude_code_history_for_session(
                    &conn,
                    &session.session_id,
                )?,
            )
        }
        SOURCE_CODEX_APP => {
            let conn = get_connection().map_err(|err| err.to_string())?;
            load_external_activity_analysis_payload(
                &session.session_id,
                codex_app_history::load_codex_app_for_session(&conn, &session.session_id)?,
            )
        }
        SOURCE_OPENCODE => load_external_activity_analysis_payload(
            &session.session_id,
            opencode_history::load_opencode_history_for_session(&session.session_id)?,
        ),
        SOURCE_WINDSURF => load_external_activity_analysis_payload(
            &session.session_id,
            windsurf_history::load_windsurf_history_for_session(&session.session_id)?,
        ),
        SOURCE_ORGII_CLI_SESSIONS | SOURCE_ORGII_RUST_AGENTS => Ok(AnalysisPayload {
            events: load_orgii_replay_analysis_events(&session.session_id)?,
        }),
        _ => Ok(AnalysisPayload::default()),
    }
}

fn load_orgii_replay_analysis_events(
    session_id: &str,
) -> Result<Vec<(String, ExtractedData)>, String> {
    let cached = session_persistence::load_events(session_id).map_err(|err| err.to_string())?;
    let mut events = cached
        .into_iter()
        .map(|event| cached_event_to_session_event(&event))
        .collect::<Vec<_>>();
    events = dedup_by_call_id(events);
    backfill_tool_inputs_from_messages(session_id, &mut events);
    backfill_subagent_links(session_id, &mut events);
    Ok(events
        .into_iter()
        .take(MAX_EVENTS_PER_SESSION)
        .filter_map(|event| extract_event_data(&event).map(|data| (event.id, data)))
        .collect())
}

fn load_external_activity_analysis_payload(
    session_id: &str,
    chunks: Vec<ActivityChunk>,
) -> Result<AnalysisPayload, String> {
    let raw_chunks = chunks
        .into_iter()
        .map(activity_chunk_to_raw)
        .collect::<Vec<_>>();
    let result = ingestion::ingest_raw_chunks(&raw_chunks, session_id);
    Ok(AnalysisPayload {
        events: result
            .events
            .into_iter()
            .take(MAX_EVENTS_PER_SESSION)
            .filter_map(|event| extract_event_data(&event).map(|data| (event.id, data)))
            .collect(),
    })
}

fn activity_chunk_to_raw(chunk: ActivityChunk) -> RawActivityChunk {
    RawActivityChunk {
        chunk_id: Some(chunk.chunk_id),
        session_id: Some(chunk.session_id),
        action_type: Some(chunk.action_type),
        function: Some(chunk.function),
        args: Some(chunk.args),
        result: Some(chunk.result),
        created_at: Some(chunk.created_at),
        thread_id: chunk.thread_id,
        process_id: chunk.process_id,
        call_id: None,
    }
}

fn upsert_analysis_marker_checkpoint(
    store: &SqliteRecordStore<'_>,
    session: &SessionRecord,
) -> Result<(), String> {
    store.upsert_session_checkpoint(&SessionCheckpointRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        checkpoint_id: record_id(&[
            "analysis_marker",
            &session.source,
            &session.session_id,
            &ANALYSIS_ARTIFACT_VERSION.to_string(),
        ]),
        source: session.source.clone(),
        source_session_id: Some(session.source_session_id.clone()),
        session_id: session.session_id.clone(),
        sequence_index: -1,
        source_event_id: None,
        turn_id: None,
        checkpoint_kind: orgtrack_core::canonical::CheckpointKind::Inferred,
        timestamp: Some(chrono::Utc::now().to_rfc3339()),
        affected_file_paths: Vec::new(),
        edit_record_ids: Vec::new(),
        quality: ArtifactQuality::Inferred,
        undo_supported: false,
        metadata_json: Some(
            serde_json::json!({
                "artifactClass": "analysis",
                "analysisArtifactVersion": ANALYSIS_ARTIFACT_VERSION,
                "workspacePath": session.workspace_path,
                // Watermark: the session's `updated_at` at the moment this
                // analysis ran. The gate re-analyzes whenever the session is
                // updated past this value, so commits/pushes made *after* an
                // earlier analysis still flow into orgtrack (commit links /
                // Submissions). Without this, a session was analyzed once and
                // then skipped forever — later pushes never produced links.
                "analyzedThroughUpdatedAt": session.updated_at,
            })
            .to_string(),
        ),
    })
}

fn upsert_analysis_boundary_checkpoints(
    store: &SqliteRecordStore<'_>,
    session: &SessionRecord,
) -> Result<(), String> {
    let checkpoints = [("start", 0_i64), ("latest", i64::MAX)];
    for (kind, sequence_index) in checkpoints {
        store.upsert_session_checkpoint(&SessionCheckpointRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            checkpoint_id: record_id(&[
                "analysis_checkpoint",
                &session.source,
                &session.session_id,
                kind,
            ]),
            source: session.source.clone(),
            source_session_id: Some(session.source_session_id.clone()),
            session_id: session.session_id.clone(),
            sequence_index,
            source_event_id: None,
            turn_id: None,
            checkpoint_kind: orgtrack_core::canonical::CheckpointKind::Inferred,
            timestamp: None,
            affected_file_paths: Vec::new(),
            edit_record_ids: Vec::new(),
            quality: ArtifactQuality::Inferred,
            undo_supported: false,
            metadata_json: Some(
                serde_json::json!({
                    "artifactClass": "analysis",
                    "sourceCacheRole": "input_only",
                })
                .to_string(),
            ),
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    use orgtrack_core::canonical::AgentMetadata;

    fn session_with_updated_at(session_id: &str, updated_at: Option<&str>) -> SessionRecord {
        SessionRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            source: SOURCE_ORGII_RUST_AGENTS.to_string(),
            source_session_id: session_id.to_string(),
            session_id: session_id.to_string(),
            title: String::new(),
            status: None,
            created_at: None,
            updated_at: updated_at.map(str::to_string),
            completed_at: None,
            workspace_path: None,
            branch: None,
            parent_session_id: None,
            org_member_id: None,
            metadata: AgentMetadata::default(),
            journey: Default::default(),
        }
    }

    #[test]
    fn unanalyzed_session_needs_analysis() {
        let watermarks = BTreeMap::new();
        let session = session_with_updated_at("s1", Some("2026-06-15T10:00:00Z"));
        assert!(session_needs_analysis(&session, &watermarks));
    }

    #[test]
    fn legacy_marker_without_watermark_is_reanalyzed_once() {
        let mut watermarks = BTreeMap::new();
        watermarks.insert("s1".to_string(), None);
        let session = session_with_updated_at("s1", Some("2026-06-15T10:00:00Z"));
        assert!(session_needs_analysis(&session, &watermarks));
    }

    #[test]
    fn analyzed_session_with_no_new_updates_is_skipped() {
        let mut watermarks = BTreeMap::new();
        watermarks.insert("s1".to_string(), Some("2026-06-15T10:00:00Z".to_string()));
        let session = session_with_updated_at("s1", Some("2026-06-15T10:00:00Z"));
        assert!(!session_needs_analysis(&session, &watermarks));
    }

    #[test]
    fn session_updated_after_watermark_is_reanalyzed() {
        // Core regression: a session analyzed at T1 that then receives a new
        // commit/push (bumping updated_at to T2 > T1) must be re-analyzed so
        // the new commit link reaches Submissions.
        let mut watermarks = BTreeMap::new();
        watermarks.insert("s1".to_string(), Some("2026-06-15T10:00:00Z".to_string()));
        let session = session_with_updated_at("s1", Some("2026-06-15T17:24:00Z"));
        assert!(session_needs_analysis(&session, &watermarks));
    }

    #[test]
    fn analyzed_session_missing_updated_at_is_skipped() {
        let mut watermarks = BTreeMap::new();
        watermarks.insert("s1".to_string(), Some("2026-06-15T10:00:00Z".to_string()));
        let session = session_with_updated_at("s1", None);
        assert!(!session_needs_analysis(&session, &watermarks));
    }
}
