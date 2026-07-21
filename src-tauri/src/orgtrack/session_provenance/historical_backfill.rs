//! Incremental, repository-scoped historical Session Provenance backfill.
//!
//! Provider discovery and transcript decoding deliberately reuse the existing
//! imported-history caches and loaders. This module owns only scheduling,
//! checkpoints, prioritization, and projection into canonical interactions.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use chrono::Utc;
use database::db::get_connection;
use orgtrack_core::canonical::{
    AttributionPrecision, SessionRecord, SOURCE_ORGII_CLI_SESSIONS, SOURCE_ORGII_RUST_AGENTS,
};
use orgtrack_core::sources::claude_code::history::{
    list_claude_code_history_sessions_paginated, load_claude_code_history_for_session,
};
use orgtrack_core::sources::codex::app::{
    codex_thread_id_from_file_stem, list_codex_app_reconciliation_sessions,
    list_codex_app_sessions_paginated, load_codex_app_for_session,
};
use orgtrack_core::sources::cursor_ide::history::{
    list_cursor_ide_sessions_paginated, load_history_for_session as load_cursor_history_for_session,
};
use orgtrack_core::sources::imported_history::cache::{
    query_cached_sessions_for_repo_from_conn, ImportedHistoryCachedSession,
};
use orgtrack_core::sources::imported_history::metadata::{
    SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP, SOURCE_CURSOR_IDE,
};
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
use rusqlite::Connection;

use super::{
    cached_event_to_activity_chunk, canonicalize_existing_prefix, persist_activity_chunks,
};

// v3: repository ids now come from filesystem git discovery instead of
// `git rev-parse` output. The id derivation input could differ in edge
// cases (symlinked paths, worktree commondir form), so force a one-shot
// re-reconciliation to rebuild all Reconciled interactions under the new
// derivation and keep every session's rows on a single repository_id.
const HISTORICAL_INTERACTION_PARSER_VERSION: i64 = 3;
const BACKFILL_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
// A single provider transcript can legitimately take several minutes to
// parse. Previous-process rows are reclaimed immediately through owner_id, so
// this lease only protects against racing a still-live worker in this process.
const BACKFILL_LEASE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
static BACKFILL_PROCESS_OWNER: OnceLock<String> = OnceLock::new();

#[derive(Debug, Clone)]
struct HistoricalBackfillJob {
    status: HistoricalBackfillStatus,
    indexed_sessions: usize,
    total_sessions: usize,
    failed_sessions: usize,
    last_error: Option<String>,
    run_token: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoricalBackfillStatus {
    Queued,
    Discovering,
    Indexing,
    Complete,
    Partial,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveSessionPolicy {
    QuiescentOnly,
    AllowActive,
}

impl HistoricalBackfillStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Discovering => "discovering",
            Self::Indexing => "indexing",
            Self::Complete => "complete",
            Self::Partial => "partial",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "queued" => Self::Queued,
            "discovering" => Self::Discovering,
            "indexing" => Self::Indexing,
            "complete" => Self::Complete,
            "partial" => Self::Partial,
            _ => Self::Failed,
        }
    }
}

impl HistoricalBackfillJob {
    fn queued() -> Self {
        Self {
            status: HistoricalBackfillStatus::Queued,
            indexed_sessions: 0,
            total_sessions: 0,
            failed_sessions: 0,
            last_error: None,
            run_token: String::new(),
            updated_at_ms: Utc::now().timestamp_millis(),
        }
    }

    fn snapshot(&self) -> crate::orgtrack::types::FileSessionHistoryBackfill {
        crate::orgtrack::types::FileSessionHistoryBackfill {
            status: self.status.as_str().to_string(),
            indexed_sessions: self.indexed_sessions,
            total_sessions: self.total_sessions,
            failed_sessions: self.failed_sessions,
            last_error: self.last_error.clone(),
        }
    }

    const fn is_active(&self) -> bool {
        matches!(
            self.status,
            HistoricalBackfillStatus::Queued
                | HistoricalBackfillStatus::Discovering
                | HistoricalBackfillStatus::Indexing
        )
    }
}

/// Start (or join) one repository-scoped historical transcript backfill.
///
/// The file-history read path only schedules this work. Source discovery and
/// transcript parsing run on a dedicated blocking thread, so opening a file is
/// never held hostage by the size of the user's history. Per-session source
/// fingerprints in SQLite are the durable queue: after a crash or restart the
/// next request skips current checkpoints and resumes only stale sessions.
pub(in crate::orgtrack) fn request_historical_backfill(
    repo_path: &str,
    priority_file: &str,
) -> crate::orgtrack::types::FileSessionHistoryBackfill {
    let canonical_repo = canonicalize_existing_prefix(Path::new(repo_path));
    let repo_key = canonical_repo.to_string_lossy().into_owned();

    // Fast path: a recently finished run means the repo's backlog was already
    // walked. Re-running would only re-spawn discovery plus a fingerprint
    // sweep to conclude "nothing to do" — a fixed cost paid on EVERY Timeline
    // open. Skip it unless the requested file has sessions that still need
    // indexing (a Timeline for a not-yet-covered file must never be starved).
    // Because BACKFILL_RECHECK_TTL_MS < SESSION_QUIESCENCE_MS, any session
    // that appears during the TTL window is still non-quiescent and would
    // not have been indexed by a re-run anyway, so this delays nothing.
    if let Ok(conn) = get_connection() {
        if let Ok(Some(job)) = load_backfill_job(&conn, &repo_key) {
            let is_terminal = matches!(
                job.status,
                HistoricalBackfillStatus::Complete | HistoricalBackfillStatus::Partial
            );
            let is_fresh = Utc::now()
                .timestamp_millis()
                .saturating_sub(job.updated_at_ms)
                < BACKFILL_RECHECK_TTL_MS;
            if is_terminal
                && is_fresh
                && !priority_file_needs_backfill(&conn, repo_path, &canonical_repo, priority_file)
            {
                return job.snapshot();
            }
        }
    }

    let (job, claimed_run_token) = match get_connection()
        .map_err(|err| err.to_string())
        .and_then(|mut conn| claim_backfill_job(&mut conn, &repo_key))
    {
        Ok(claim) => claim,
        Err(err) => {
            tracing::warn!(repo_path = %repo_key, error = %err, "[SessionProvenance] Failed to claim historical backfill");
            return failed_backfill_snapshot(err);
        }
    };
    let Some(run_token) = claimed_run_token else {
        return job.snapshot();
    };

    let thread_repo_key = repo_key.clone();
    let thread_repo_path = canonical_repo.to_string_lossy().into_owned();
    let priority_file = priority_file.to_string();
    let thread_run_token = run_token.clone();
    let spawn_result = std::thread::Builder::new()
        .name("orgtrack-history-backfill".to_string())
        .spawn(move || {
            update_backfill_job(
                &thread_repo_key,
                &thread_run_token,
                HistoricalBackfillStatus::Discovering,
                0,
                0,
                0,
            );
            let result = get_connection()
                .map_err(|err| err.to_string())
                .and_then(|mut conn| {
                    reconcile_historical_interactions(
                        &mut conn,
                        &thread_repo_path,
                        &priority_file,
                        |indexed_sessions, total_sessions, failed_sessions| {
                            update_backfill_job(
                                &thread_repo_key,
                                &thread_run_token,
                                HistoricalBackfillStatus::Indexing,
                                indexed_sessions,
                                total_sessions,
                                failed_sessions,
                            );
                        },
                    )
                });
            match result {
                Ok(()) => finish_backfill_job(&thread_repo_key, &thread_run_token),
                Err(err) => {
                    tracing::warn!(
                        repo_path = %thread_repo_path,
                        error = %err,
                        "[SessionProvenance] Historical backfill failed"
                    );
                    fail_backfill_job(&thread_repo_key, &thread_run_token, &err);
                }
            }
        });
    if let Err(err) = spawn_result {
        let message = format!("Failed to start historical backfill: {err}");
        fail_backfill_job(&repo_key, &run_token, &message);
        return failed_backfill_snapshot(message);
    }
    job.snapshot()
}

fn backfill_process_owner() -> &'static str {
    BACKFILL_PROCESS_OWNER
        .get_or_init(|| uuid::Uuid::new_v4().to_string())
        .as_str()
}

fn claim_backfill_job(
    conn: &mut Connection,
    repo_key: &str,
) -> Result<(HistoricalBackfillJob, Option<String>), String> {
    let now_ms = Utc::now().timestamp_millis();
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|err| err.to_string())?;
    let result = (|| {
        let current = load_backfill_job(conn, repo_key)?;
        if let Some(job) = current {
            let same_process = job
                .run_token
                .strip_prefix(backfill_process_owner())
                .is_some_and(|suffix| suffix.starts_with(':'));
            let age_ms = now_ms.saturating_sub(job.updated_at_ms);
            let freshness = if job.is_active() {
                BACKFILL_LEASE_TIMEOUT
            } else {
                BACKFILL_REFRESH_INTERVAL
            };
            if same_process && age_ms < freshness.as_millis() as i64 {
                return Ok((job, None));
            }
        }

        let run_token = format!("{}:{}", backfill_process_owner(), uuid::Uuid::new_v4());
        conn.execute(
            "INSERT INTO orgtrack_core_interaction_backfill_jobs (
                repo_key, status, indexed_sessions, total_sessions,
                failed_sessions, last_error, run_token, updated_at_ms
             ) VALUES (?1, 'queued', 0, 0, 0, NULL, ?2, ?3)
             ON CONFLICT(repo_key) DO UPDATE SET
                status = excluded.status,
                indexed_sessions = 0,
                total_sessions = 0,
                failed_sessions = 0,
                last_error = NULL,
                run_token = excluded.run_token,
                updated_at_ms = excluded.updated_at_ms",
            rusqlite::params![repo_key, run_token, now_ms],
        )
        .map_err(|err| err.to_string())?;
        let job = load_backfill_job(conn, repo_key)?.unwrap_or_else(HistoricalBackfillJob::queued);
        Ok((job, Some(run_token)))
    })();
    match result {
        Ok(value) => {
            conn.execute_batch("COMMIT")
                .map_err(|err| err.to_string())?;
            Ok(value)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

fn load_backfill_job(
    conn: &Connection,
    repo_key: &str,
) -> Result<Option<HistoricalBackfillJob>, String> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT status, indexed_sessions, total_sessions, failed_sessions,
                last_error, run_token, updated_at_ms
         FROM orgtrack_core_interaction_backfill_jobs WHERE repo_key = ?1",
        [repo_key],
        |row| {
            let status: String = row.get(0)?;
            Ok(HistoricalBackfillJob {
                status: HistoricalBackfillStatus::parse(&status),
                indexed_sessions: row.get::<_, i64>(1)?.max(0) as usize,
                total_sessions: row.get::<_, i64>(2)?.max(0) as usize,
                failed_sessions: row.get::<_, i64>(3)?.max(0) as usize,
                last_error: row.get(4)?,
                run_token: row.get(5)?,
                updated_at_ms: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn update_backfill_job(
    repo_key: &str,
    run_token: &str,
    status: HistoricalBackfillStatus,
    indexed_sessions: usize,
    total_sessions: usize,
    failed_sessions: usize,
) {
    let result = get_connection()
        .map_err(|err| err.to_string())
        .and_then(|conn| {
            conn.execute(
                "UPDATE orgtrack_core_interaction_backfill_jobs SET
                    status = ?1, indexed_sessions = ?2, total_sessions = ?3,
                    failed_sessions = ?4, last_error = NULL, updated_at_ms = ?5
                 WHERE repo_key = ?6 AND run_token = ?7",
                rusqlite::params![
                    status.as_str(),
                    indexed_sessions.min(i64::MAX as usize) as i64,
                    total_sessions.min(i64::MAX as usize) as i64,
                    failed_sessions.min(i64::MAX as usize) as i64,
                    Utc::now().timestamp_millis(),
                    repo_key,
                    run_token,
                ],
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
        });
    if let Err(err) = result {
        tracing::warn!(repo_path = %repo_key, error = %err, "[SessionProvenance] Failed to persist backfill progress");
    }
}

fn finish_backfill_job(repo_key: &str, run_token: &str) {
    let result = get_connection()
        .map_err(|err| err.to_string())
        .and_then(|conn| {
            conn.execute(
                "UPDATE orgtrack_core_interaction_backfill_jobs SET
                    status = CASE WHEN failed_sessions > 0 THEN 'partial' ELSE 'complete' END,
                    updated_at_ms = ?1
                 WHERE repo_key = ?2 AND run_token = ?3",
                rusqlite::params![Utc::now().timestamp_millis(), repo_key, run_token],
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
        });
    if let Err(err) = result {
        tracing::warn!(repo_path = %repo_key, error = %err, "[SessionProvenance] Failed to finish backfill job");
    }
}

fn fail_backfill_job(repo_key: &str, run_token: &str, error: &str) {
    let result = get_connection()
        .map_err(|err| err.to_string())
        .and_then(|conn| {
            conn.execute(
                "UPDATE orgtrack_core_interaction_backfill_jobs SET
                    status = 'failed', last_error = ?1, updated_at_ms = ?2
                 WHERE repo_key = ?3 AND run_token = ?4",
                rusqlite::params![error, Utc::now().timestamp_millis(), repo_key, run_token],
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
        });
    if let Err(err) = result {
        tracing::warn!(repo_path = %repo_key, error = %err, "[SessionProvenance] Failed to persist backfill failure");
    }
}

fn failed_backfill_snapshot(error: String) -> crate::orgtrack::types::FileSessionHistoryBackfill {
    crate::orgtrack::types::FileSessionHistoryBackfill {
        status: HistoricalBackfillStatus::Failed.as_str().to_string(),
        indexed_sessions: 0,
        total_sessions: 0,
        failed_sessions: 1,
        last_error: Some(error),
    }
}

fn reconcile_historical_interactions(
    conn: &mut Connection,
    repo_path: &str,
    priority_file: &str,
    mut progress: impl FnMut(usize, usize, usize),
) -> Result<(), String> {
    let canonical_repo = canonicalize_existing_prefix(Path::new(repo_path));
    let mut discovery_failures = sync_imported_history_caches(conn);

    let mut imported_sessions = Vec::new();
    for source in [SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP, SOURCE_CURSOR_IDE] {
        match imported_sessions_for_repo(conn, source, repo_path, &canonical_repo) {
            Ok(sessions) => {
                imported_sessions.extend(sessions.into_iter().map(|session| (source, session)))
            }
            Err(err) => {
                discovery_failures += 1;
                tracing::warn!(
                    source,
                    error = %err,
                    "[SessionProvenance] Historical source discovery failed"
                );
            }
        }
    }
    // Lazy scope: fully reconcile only sessions that actually touched the
    // requested file (per the discovery cache's impact.touched_files), and
    // chip away at the remaining backlog with a bounded batch per run. A
    // single file-history open used to reconcile EVERY historical session
    // in the repo — hundreds of transcript parses for one Timeline panel.
    // The backlog still converges to fully indexed across a few opens
    // (already-current sessions are fingerprint-skipped for free), but each
    // trigger now does a bounded, predictable amount of work.
    let (priority_sessions, backlog_sessions): (Vec<_>, Vec<_>) =
        imported_sessions.into_iter().partition(|(_, session)| {
            session_touches_priority_file(session, &canonical_repo, priority_file)
        });
    let backlog_pending =
        backlog_sessions_needing_work(conn, backlog_sessions, BACKFILL_BACKLOG_BATCH_PER_RUN);
    let imported_sessions: Vec<_> = priority_sessions
        .into_iter()
        .chain(backlog_pending)
        .collect();
    let native_sessions = native_sessions_for_repo(conn, repo_path, &canonical_repo)?;
    let total_sessions = imported_sessions.len() + native_sessions.len() + discovery_failures;
    let mut indexed_sessions = 0;
    let mut failed_sessions = discovery_failures;
    progress(indexed_sessions, total_sessions, failed_sessions);

    for (source, session) in imported_sessions {
        match reconcile_imported_session(
            conn,
            source,
            &canonical_repo,
            &session,
            ActiveSessionPolicy::QuiescentOnly,
        ) {
            Ok(_) => indexed_sessions += 1,
            Err(err) => {
                failed_sessions += 1;
                tracing::warn!(
                    source,
                    session_id = %session.session_id,
                    error = %err,
                    "[SessionProvenance] Historical session reconciliation failed"
                );
            }
        }
        progress(indexed_sessions, total_sessions, failed_sessions);
    }
    for session in native_sessions {
        match reconcile_native_session(conn, &canonical_repo, &session) {
            Ok(()) => indexed_sessions += 1,
            Err(err) => {
                failed_sessions += 1;
                tracing::warn!(
                    session_id = %session.session_id,
                    error = %err,
                    "[SessionProvenance] Native historical session reconciliation failed"
                );
            }
        }
        progress(indexed_sessions, total_sessions, failed_sessions);
    }
    Ok(())
}

fn sync_imported_history_caches(conn: &mut Connection) -> usize {
    let mut failures = 0;
    if let Err(err) = list_claude_code_history_sessions_paginated(conn, 1, 0) {
        failures += 1;
        tracing::warn!(error = %err, "[SessionProvenance] Claude history discovery failed");
    }
    if let Err(err) = list_codex_app_sessions_paginated(conn, 1, 0) {
        failures += 1;
        tracing::warn!(error = %err, "[SessionProvenance] Codex history discovery failed");
    }
    if let Err(err) = list_cursor_ide_sessions_paginated(conn, 1, 0) {
        failures += 1;
        tracing::warn!(error = %err, "[SessionProvenance] Cursor history discovery failed");
    }
    failures
}

fn imported_sessions_for_repo(
    conn: &Connection,
    source: &str,
    repo_path: &str,
    canonical_repo: &Path,
) -> Result<Vec<ImportedHistoryCachedSession>, String> {
    let canonical_repo_str = canonical_repo.to_string_lossy();
    let mut sessions_by_id = std::collections::BTreeMap::new();
    for candidate in [repo_path, canonical_repo_str.as_ref()] {
        for session in query_cached_sessions_for_repo_from_conn(conn, source, candidate)? {
            sessions_by_id.insert(session.session_id.clone(), session);
        }
    }
    Ok(sessions_by_id.into_values().collect())
}

fn session_touches_priority_file(
    session: &ImportedHistoryCachedSession,
    canonical_repo: &Path,
    priority_file: &str,
) -> bool {
    let priority_file = priority_file
        .trim_start_matches(['/', '\\'])
        .replace('\\', "/");
    session.impact.touched_files.iter().any(|candidate| {
        let candidate_path = Path::new(candidate);
        let relative = candidate_path
            .strip_prefix(canonical_repo)
            .unwrap_or(candidate_path)
            .to_string_lossy()
            .trim_start_matches(['/', '\\'])
            .replace('\\', "/");
        relative == priority_file
    })
}

/// Sessions whose source transcript changed within this window are still
/// being written (the user is actively using that CLI). Reconciling them is
/// wasted work: the fingerprint (mtime/size/hash) changes on every append,
/// so the next backfill run would delete and re-parse the whole transcript
/// again — with 1-2 git subprocesses per interaction. This kept an
/// always-on ~6% CPU floor on machines with active external sessions.
/// Live interactions are covered by the real-time hook capture path
/// (`capture_method = Hook`); backfill picks a session up once it has been
/// quiet for this long, indexes it once, and its fingerprint then never
/// changes again — effectively a one-shot migration per session.
const SESSION_QUIESCENCE_MS: i64 = 10 * 60 * 1000;

/// How many NON-priority backlog sessions (sessions that did not touch the
/// requested file) get reconciled per backfill run. Keeps a single Timeline
/// open from parsing the repo's entire imported history at once while still
/// converging: every run chips away another batch, and already-indexed
/// sessions are excluded before the batch is chosen so the backlog always
/// makes forward progress.
const BACKFILL_BACKLOG_BATCH_PER_RUN: usize = 25;

/// After a run finishes, further backfill requests within this window return
/// the finished snapshot instead of re-spawning a worker — unless the
/// requested file still has pending sessions. MUST stay below
/// SESSION_QUIESCENCE_MS: that guarantees sessions appearing inside the TTL
/// window are still non-quiescent (a re-run would skip them too), so the
/// short-circuit can never delay a reconciliation that would have happened.
const BACKFILL_RECHECK_TTL_MS: i64 = 5 * 60 * 1000;

fn session_is_quiescent(session: &ImportedHistoryCachedSession, now_ms: i64) -> bool {
    now_ms.saturating_sub(session.source_mtime_ms) >= SESSION_QUIESCENCE_MS
}

/// Cheap pre-claim probe: does any already-discovered session that touched
/// `priority_file` still need reconciliation? Pure SQLite reads against the
/// discovery cache — no source rescan, no transcript parsing. Errs on the
/// side of running the full backfill.
fn priority_file_needs_backfill(
    conn: &Connection,
    repo_path: &str,
    canonical_repo: &Path,
    priority_file: &str,
) -> bool {
    let store = SqliteRecordStore::new(conn);
    let now_ms = Utc::now().timestamp_millis();
    for source in [SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP, SOURCE_CURSOR_IDE] {
        let Ok(sessions) = imported_sessions_for_repo(conn, source, repo_path, canonical_repo)
        else {
            return true;
        };
        for session in sessions {
            if !session_touches_priority_file(&session, canonical_repo, priority_file) {
                continue;
            }
            if !session_is_quiescent(&session, now_ms) {
                continue;
            }
            let fingerprint = imported_session_fingerprint(&session);
            match store.interaction_import_is_current(
                source,
                &session.session_id,
                &fingerprint,
                HISTORICAL_INTERACTION_PARSER_VERSION,
            ) {
                Ok(true) => continue,
                Ok(false) | Err(_) => return true,
            }
        }
    }
    false
}

/// Select up to `limit` backlog sessions that actually need reconciliation:
/// already-current fingerprints and still-active (non-quiescent) sessions
/// are filtered out first, so the batch budget is never wasted on no-ops and
/// the backlog cannot stall behind a prefix of completed sessions.
fn backlog_sessions_needing_work(
    conn: &Connection,
    backlog: Vec<(&'static str, ImportedHistoryCachedSession)>,
    limit: usize,
) -> Vec<(&'static str, ImportedHistoryCachedSession)> {
    let store = SqliteRecordStore::new(conn);
    let now_ms = Utc::now().timestamp_millis();
    let mut selected = Vec::new();
    for (source, session) in backlog {
        if selected.len() >= limit {
            break;
        }
        if !session_is_quiescent(&session, now_ms) {
            continue;
        }
        let fingerprint = imported_session_fingerprint(&session);
        match store.interaction_import_is_current(
            source,
            &session.session_id,
            &fingerprint,
            HISTORICAL_INTERACTION_PARSER_VERSION,
        ) {
            Ok(true) => continue,
            // On a status-check error, let the real reconcile path surface it.
            Ok(false) | Err(_) => selected.push((source, session)),
        }
    }
    selected
}

fn reconcile_imported_session(
    conn: &Connection,
    source: &str,
    canonical_repo: &Path,
    session: &ImportedHistoryCachedSession,
    active_session_policy: ActiveSessionPolicy,
) -> Result<bool, String> {
    let store = SqliteRecordStore::new(conn);
    let fingerprint = imported_session_fingerprint(session);
    if store.interaction_import_is_current(
        source,
        &session.session_id,
        &fingerprint,
        HISTORICAL_INTERACTION_PARSER_VERSION,
    )? {
        return Ok(false);
    }
    if active_session_policy == ActiveSessionPolicy::QuiescentOnly
        && !session_is_quiescent(session, Utc::now().timestamp_millis())
    {
        // Not marked as imported: the next backfill after the session goes
        // quiet will index it.
        return Ok(false);
    }
    let chunks = match source {
        SOURCE_CLAUDE_CODE => load_claude_code_history_for_session(conn, &session.session_id),
        SOURCE_CODEX_APP => load_codex_app_for_session(conn, &session.session_id),
        SOURCE_CURSOR_IDE => load_cursor_history_for_session(&session.session_id),
        _ => return Err(format!("Unsupported imported history source: {source}")),
    }?;
    store.delete_reconciled_resource_interactions(source, &session.session_id)?;
    let actor_id = session
        .parent_session_id
        .as_ref()
        .map(|_| session.source_session_id.as_str());
    let precision = if actor_id.is_some() {
        AttributionPrecision::Exact
    } else {
        AttributionPrecision::SessionOnly
    };
    persist_activity_chunks(
        &store,
        source,
        Some(&session.source_session_id),
        &session.session_id,
        actor_id,
        session
            .repo_path
            .as_deref()
            .or_else(|| canonical_repo.to_str())
            .unwrap_or("."),
        precision,
        &chunks,
    )?;
    store.mark_interaction_imported(
        source,
        &session.session_id,
        &fingerprint,
        HISTORICAL_INTERACTION_PARSER_VERSION,
        &Utc::now().to_rfc3339(),
    )?;
    Ok(true)
}

fn imported_session_fingerprint(session: &ImportedHistoryCachedSession) -> String {
    format!(
        "{}:{}:{}:{}",
        session.source_mtime_ms,
        session.source_size_bytes,
        session.source_fingerprint,
        session.parser_version
    )
}

/// Periodically reconcile recent Codex tasks whose own SessionStart was not
/// observed. Source fingerprints make this incremental: unchanged rollouts
/// are checkpoint hits, while an appended rollout replaces only prior
/// reconciled facts and preserves live hook facts. Healthy task-scoped
/// activation keeps the established low-CPU live-hook path; missing activation
/// opts only that task into active-transcript recovery.
pub(crate) fn spawn_codex_write_reconciliation_loop(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let result =
                tauri::async_runtime::spawn_blocking(reconcile_recent_codex_sessions).await;
            match result {
                Ok(Ok(reconciled)) if reconciled > 0 => {
                    let _ =
                        tauri::Emitter::emit(&app, super::RESOURCE_INTERACTIONS_CHANGED_EVENT, ());
                }
                Ok(Ok(_)) => {}
                Ok(Err(err)) => tracing::warn!(
                    error = %err,
                    "[SessionProvenance] Codex write reconciliation failed"
                ),
                Err(err) => tracing::warn!(
                    error = %err,
                    "[SessionProvenance] Codex write reconciliation task failed"
                ),
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

fn reconcile_recent_codex_sessions() -> Result<usize, String> {
    const RECENT_SESSION_LIMIT: usize = 12;

    let mut conn = get_connection().map_err(|err| err.to_string())?;
    let sessions = list_codex_app_reconciliation_sessions(&mut conn, RECENT_SESSION_LIMIT)?;
    let mut reconciled = 0;
    for session in sessions {
        let hook_session_id = codex_thread_id_from_file_stem(&session.source_session_id)
            .unwrap_or(&session.source_session_id);
        let session_start_active =
            agent_cli::session_provenance::codex_session_start_is_active(hook_session_id)
                .unwrap_or(false);
        if session_start_active {
            continue;
        }
        let repo = session.repo_path.as_deref().unwrap_or(".");
        let canonical_repo = canonicalize_existing_prefix(Path::new(repo));
        match reconcile_imported_session(
            &conn,
            SOURCE_CODEX_APP,
            &canonical_repo,
            &session,
            ActiveSessionPolicy::AllowActive,
        ) {
            Ok(true) => {
                reconciled += 1;
                tracing::debug!(
                    session_id = %session.session_id,
                    session_start_active,
                    "[SessionProvenance] Reconciled changed Codex rollout"
                );
            }
            Ok(false) => {}
            Err(err) => tracing::warn!(
                session_id = %session.session_id,
                session_start_active,
                error = %err,
                "[SessionProvenance] Codex session reconciliation failed"
            ),
        }
    }
    Ok(reconciled)
}

fn native_sessions_for_repo(
    conn: &Connection,
    repo_path: &str,
    canonical_repo: &Path,
) -> Result<Vec<SessionRecord>, String> {
    let store = SqliteRecordStore::new(conn);
    let canonical_repo_str = canonical_repo.to_string_lossy();
    let mut sessions_by_id = std::collections::BTreeMap::new();
    for candidate in [repo_path, canonical_repo_str.as_ref()] {
        for session in store.list_sessions(Some(candidate))? {
            sessions_by_id.insert(session.session_id.clone(), session);
        }
    }
    Ok(sessions_by_id
        .into_values()
        .filter(|session| {
            matches!(
                session.source.as_str(),
                SOURCE_ORGII_RUST_AGENTS | SOURCE_ORGII_CLI_SESSIONS
            ) && session.workspace_path.as_deref().is_some_and(|workspace| {
                canonicalize_existing_prefix(Path::new(workspace)) == canonical_repo
            })
        })
        .collect())
}

fn reconcile_native_session(
    conn: &Connection,
    canonical_repo: &Path,
    session: &SessionRecord,
) -> Result<(), String> {
    let Some(metadata) = session_persistence::get_session_metadata(&session.session_id)
        .map_err(|err| err.to_string())?
    else {
        // A live-only session may not have a persisted event cache. It has
        // still been fully considered for coverage and is not a failure.
        return Ok(());
    };
    let fingerprint = format!(
        "{}:{}:{}:{}",
        metadata.event_count,
        metadata.cached_at,
        metadata.time_range_start.as_deref().unwrap_or_default(),
        metadata.time_range_end.as_deref().unwrap_or_default()
    );
    let store = SqliteRecordStore::new(conn);
    if store.interaction_import_is_current(
        &session.source,
        &session.session_id,
        &fingerprint,
        HISTORICAL_INTERACTION_PARSER_VERSION,
    )? {
        return Ok(());
    }
    let events =
        session_persistence::load_events(&session.session_id).map_err(|err| err.to_string())?;
    let chunks = events
        .iter()
        .map(cached_event_to_activity_chunk)
        .collect::<Vec<_>>();
    let actor_id = session.org_member_id.as_deref().or_else(|| {
        session
            .parent_session_id
            .as_ref()
            .map(|_| session.source_session_id.as_str())
    });
    let precision = if actor_id.is_some() {
        AttributionPrecision::Exact
    } else {
        AttributionPrecision::SessionOnly
    };
    store.delete_reconciled_resource_interactions(&session.source, &session.session_id)?;
    persist_activity_chunks(
        &store,
        &session.source,
        Some(&session.source_session_id),
        &session.session_id,
        actor_id,
        session
            .workspace_path
            .as_deref()
            .or_else(|| canonical_repo.to_str())
            .unwrap_or("."),
        precision,
        &chunks,
    )?;
    store.mark_interaction_imported(
        &session.source,
        &session.session_id,
        &fingerprint,
        HISTORICAL_INTERACTION_PARSER_VERSION,
        &Utc::now().to_rfc3339(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    #[test]
    fn durable_backfill_claim_joins_current_process_and_reclaims_previous_process() {
        let mut conn = Connection::open_in_memory().expect("in-memory SQLite");
        SqliteRecordStore::init_tables(&conn).expect("initialize Orgtrack schema");

        let (first, first_token) =
            claim_backfill_job(&mut conn, "/repo").expect("claim first durable backfill");
        let first_token = first_token.expect("first request owns the job");
        assert_eq!(first.status, HistoricalBackfillStatus::Queued);

        let (joined, joined_token) =
            claim_backfill_job(&mut conn, "/repo").expect("join active durable backfill");
        assert!(joined.is_active());
        assert_eq!(joined.run_token, first_token);
        assert!(joined_token.is_none());

        conn.execute(
            "UPDATE orgtrack_core_interaction_backfill_jobs
             SET status = 'indexing', run_token = 'previous-process:run', updated_at_ms = ?1
             WHERE repo_key = '/repo'",
            [Utc::now().timestamp_millis()],
        )
        .expect("simulate previous process lease");
        let (reclaimed, reclaimed_token) =
            claim_backfill_job(&mut conn, "/repo").expect("reclaim previous process backfill");
        assert_eq!(reclaimed.status, HistoricalBackfillStatus::Queued);
        assert_ne!(reclaimed.run_token, "previous-process:run");
        assert_eq!(
            reclaimed_token.as_deref(),
            Some(reclaimed.run_token.as_str())
        );
    }
}
