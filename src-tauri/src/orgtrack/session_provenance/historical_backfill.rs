//! Incremental, repository-scoped historical Session Provenance backfill.
//!
//! Provider discovery and transcript decoding deliberately reuse the existing
//! imported-history caches and loaders. This module owns only scheduling,
//! checkpoints, prioritization, and projection into canonical interactions.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use chrono::Utc;
use database::db::get_connection;
use orgtrack_core::canonical::{
    AttributionPrecision, SessionRecord, SOURCE_ORGII_CLI_SESSIONS, SOURCE_ORGII_RUST_AGENTS,
};
use orgtrack_core::sources::codex::app::{
    codex_thread_id_from_file_stem, list_codex_app_reconciliation_sessions,
};
use orgtrack_core::sources::imported_history::cache::{
    query_cached_sessions_for_repo_from_conn, query_recent_cached_sessions_for_source_from_conn,
    ImportedHistoryCachedSession,
};
use orgtrack_core::sources::imported_history::catalog::refresh_source as refresh_imported_catalog;
use orgtrack_core::sources::imported_history::metadata::SOURCE_CODEX_APP;
use orgtrack_core::sources::imported_history::replay::{
    self, ImportedHistorySourceId, ReplayLimits,
};
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
use rusqlite::Connection;

use super::{
    canonicalize_existing_prefix, persist_activity_chunks_with_turn_state,
    persist_cached_event_interactions_streaming,
};

// v3: repository ids now come from filesystem git discovery instead of
// `git rev-parse` output. The id derivation input could differ in edge
// cases (symlinked paths, worktree commondir form), so force a one-shot
// re-reconciliation to rebuild all Reconciled interactions under the new
// derivation and keep every session's rows on a single repository_id.
const HISTORICAL_INTERACTION_PARSER_VERSION: i64 = 3;
const BACKFILL_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const CODEX_WRITE_RECONCILIATION_POLL_INTERVAL: Duration = Duration::from_secs(30);
/// The 30-second loop may cheaply inspect the SQLite cache, but a recursive
/// walk of every Codex rollout directory plus session_index.jsonl belongs on
/// the same low-frequency cadence as external-history discovery.
const CODEX_DISCOVERY_REFRESH_INTERVAL_MS: i64 = 5 * 60 * 1000;
/// Missing SessionStart receipts require transcript recovery even while a
/// Codex task is active. Re-parsing an append-only rollout every poll is
/// needlessly quadratic, though: one long task can consume a full core and
/// temporarily allocate hundreds of MiB on every pass. Recover it immediately
/// once, then sparsely while it remains active; the quiescent transition below
/// bypasses this throttle and performs the final reconciliation right away.
const ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS: i64 = 5 * 60 * 1000;
/// Automatic provenance recovery is best-effort and must never materialize a
/// gigantic transcript into several full in-memory projections behind the
/// user's back. Larger rollouts remain available to explicit history flows;
/// the background reconciler waits for a future streaming implementation.
const MAX_BACKGROUND_CODEX_RECONCILIATION_SOURCE_BYTES: i64 = 32 * 1024 * 1024;
/// Do not parse a transcript that is receiving output right now. A short quiet
/// window avoids racing the writer without delaying the eventual 10-minute
/// quiescent finalization path.
const ACTIVE_CODEX_MIN_QUIET_MS: i64 = 60 * 1000;
/// Startup may discover many old tasks without activation receipts. Replaying
/// all of them in one worker creates a multi-minute CPU/RAM plateau, so admit
/// at most one non-quiescent recovery per pass.
const ACTIVE_CODEX_RECONCILIATION_BATCH_PER_PASS: usize = 1;
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

/// Keep every historical-provenance entry point tied to the authoritative
/// replay registry. Adding a new imported source must not require finding and
/// updating another hand-maintained allow-list in this module.
fn historical_imported_sources() -> impl Iterator<Item = ImportedHistorySourceId> {
    ImportedHistorySourceId::ALL.into_iter()
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
    for replay_source in historical_imported_sources() {
        let source = replay_source.as_str();
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
    for source in historical_imported_sources() {
        if let Err(err) = refresh_imported_catalog(conn, source) {
            failures += 1;
            tracing::warn!(
                source = source.as_str(),
                error = %err,
                "[SessionProvenance] Imported history catalog discovery failed"
            );
        }
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

/// Imported-history signatures were historically epoch milliseconds. New
/// signatures use epoch nanoseconds (despite the compatibility field name) so
/// rapid in-place transcript appends are observable. Normalize both formats
/// before applying wall-clock lifecycle thresholds.
fn source_mtime_epoch_ms(source_mtime_value: i64) -> i64 {
    const EPOCH_NANOSECONDS_THRESHOLD: i64 = 100_000_000_000_000;
    if source_mtime_value >= EPOCH_NANOSECONDS_THRESHOLD {
        source_mtime_value / 1_000_000
    } else {
        source_mtime_value
    }
}

fn source_age_ms(source_mtime_value: i64, now_ms: i64) -> i64 {
    now_ms.saturating_sub(source_mtime_epoch_ms(source_mtime_value))
}

fn session_is_quiescent(session: &ImportedHistoryCachedSession, now_ms: i64) -> bool {
    source_age_ms(session.source_mtime_ms, now_ms) >= SESSION_QUIESCENCE_MS
}

fn periodic_codex_reconciliation_needed(
    session: &ImportedHistoryCachedSession,
    session_start_active: bool,
    now_ms: i64,
) -> bool {
    // This loop is live-hook recovery, not historical migration. Completed
    // transcripts stay compact-catalog-only until a provenance/file-history
    // request explicitly asks the bounded backfill worker to index them.
    !session_start_active && !session_is_quiescent(session, now_ms)
}

fn active_codex_recovery_is_quiet_enough(source_mtime_value: i64, now_ms: i64) -> bool {
    source_age_ms(source_mtime_value, now_ms) >= ACTIVE_CODEX_MIN_QUIET_MS
}

fn background_codex_reconciliation_source_is_bounded(source_size_bytes: i64) -> bool {
    source_size_bytes <= MAX_BACKGROUND_CODEX_RECONCILIATION_SOURCE_BYTES
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
    for replay_source in historical_imported_sources() {
        let source = replay_source.as_str();
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
    conn: &mut Connection,
    source: &str,
    canonical_repo: &Path,
    session: &ImportedHistoryCachedSession,
    active_session_policy: ActiveSessionPolicy,
) -> Result<bool, String> {
    let _writer = database::db::sessions_writer_guard();
    let fingerprint = imported_session_fingerprint(session);
    {
        let store = SqliteRecordStore::new(conn);
        if store.interaction_import_is_current(
            source,
            &session.session_id,
            &fingerprint,
            HISTORICAL_INTERACTION_PARSER_VERSION,
        )? {
            return Ok(false);
        }
    }
    if active_session_policy == ActiveSessionPolicy::QuiescentOnly
        && !session_is_quiescent(session, Utc::now().timestamp_millis())
    {
        // Not marked as imported: the next backfill after the session goes
        // quiet will index it.
        return Ok(false);
    }
    let replay_source = ImportedHistorySourceId::parse(source)?;
    let actor_id = session
        .parent_session_id
        .as_ref()
        .map(|_| session.source_session_id.as_str());
    let precision = if actor_id.is_some() {
        AttributionPrecision::Exact
    } else {
        AttributionPrecision::SessionOnly
    };
    let workspace_path = session
        .repo_path
        .as_deref()
        .or_else(|| canonical_repo.to_str())
        .unwrap_or(".")
        .to_string();
    let limits = ReplayLimits {
        max_turns: replay::HARD_MAX_TURNS,
        max_events: replay::HARD_MAX_EVENTS,
        max_ipc_bytes: replay::HARD_MAX_IPC_BYTES,
    };
    // Finish a bounded materialization pass before deleting the previous read
    // model. The helper retries a changing source at most twice and returns a
    // generation/revision that the transaction can replay strictly.
    let prepared = replay::prepare_pinned_scan(conn, replay_source, &session.session_id, limits)?;
    let expected_generation = prepared.generation;
    let expected_revision = prepared.revision;

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|err| format!("begin provenance snapshot publish: {err}"))?;
    let publish = (|| {
        let store = SqliteRecordStore::new(conn);
        store.delete_reconciled_resource_interactions(source, &session.session_id)?;
        let mut after_sequence = -1_i64;
        let mut current_turn_id = None;
        loop {
            let batch = replay::scan_window_after_generation(
                conn,
                replay_source,
                &session.session_id,
                &expected_generation,
                expected_revision,
                after_sequence,
                limits,
            )?;
            if batch.chunks.is_empty()
                && batch.has_more
                && batch.cursor.through_sequence <= after_sequence
            {
                return Err(format!(
                    "Pinned replay scan made no progress for {} after sequence {}",
                    session.session_id, after_sequence
                ));
            }
            after_sequence = batch.cursor.through_sequence;
            if !batch.chunks.is_empty() {
                let chunks = batch
                    .chunks
                    .into_iter()
                    .map(|indexed| indexed.chunk)
                    .collect::<Vec<_>>();
                let store = SqliteRecordStore::new(conn);
                persist_activity_chunks_with_turn_state(
                    &store,
                    source,
                    Some(&session.source_session_id),
                    &session.session_id,
                    actor_id,
                    &workspace_path,
                    precision,
                    &chunks,
                    &mut current_turn_id,
                )?;
            }
            if !batch.has_more {
                break;
            }
        }
        let store = SqliteRecordStore::new(conn);
        store.mark_interaction_imported(
            source,
            &session.session_id,
            &fingerprint,
            HISTORICAL_INTERACTION_PARSER_VERSION,
            &Utc::now().to_rfc3339(),
        )
    })();
    match publish {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|err| format!("commit provenance snapshot publish: {err}"))?,
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
    }
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

#[derive(Default)]
struct ActiveCodexReconciliationThrottle {
    attempted_at_ms: HashMap<String, i64>,
    last_discovery_at_ms: Option<i64>,
    last_active_attempt_at_ms: Option<i64>,
}

impl ActiveCodexReconciliationThrottle {
    fn retain_recent<'a>(&mut self, session_ids: impl IntoIterator<Item = &'a str>) {
        let recent = session_ids.into_iter().collect::<HashSet<_>>();
        self.attempted_at_ms
            .retain(|session_id, _| recent.contains(session_id.as_str()));
    }

    fn clear(&mut self, session_id: &str) {
        self.attempted_at_ms.remove(session_id);
    }

    fn should_refresh_discovery(&mut self, now_ms: i64) -> bool {
        if self.last_discovery_at_ms.is_some_and(|last_discovery_ms| {
            now_ms.saturating_sub(last_discovery_ms) < CODEX_DISCOVERY_REFRESH_INTERVAL_MS
        }) {
            return false;
        }
        self.last_discovery_at_ms = Some(now_ms);
        true
    }

    fn should_attempt(&mut self, session_id: &str, is_quiescent: bool, now_ms: i64) -> bool {
        if is_quiescent {
            // A task that just stopped writing needs its final append indexed
            // immediately, regardless of its last active-recovery attempt.
            self.clear(session_id);
            return true;
        }
        if self
            .attempted_at_ms
            .get(session_id)
            .is_some_and(|last_attempt_ms| {
                now_ms.saturating_sub(*last_attempt_ms) < ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS
            })
        {
            return false;
        }
        // A per-session throttle alone still rotates through a dozen missing
        // receipts at one parse every 30 seconds. Bound the whole background
        // worker so startup cannot become a multi-session CPU/RAM plateau.
        if self
            .last_active_attempt_at_ms
            .is_some_and(|last_attempt_ms| {
                now_ms.saturating_sub(last_attempt_ms) < ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS
            })
        {
            return false;
        }
        // Record attempts, not just successes: malformed or temporarily locked
        // active rollouts must not turn the 30-second discovery loop into an
        // unbounded retry/parse loop.
        self.attempted_at_ms.insert(session_id.to_string(), now_ms);
        self.last_active_attempt_at_ms = Some(now_ms);
        true
    }
}

/// Periodically reconcile recent Codex tasks whose own SessionStart was not
/// observed. Source fingerprints make this incremental: unchanged rollouts
/// are checkpoint hits, while an appended rollout replaces only prior
/// reconciled facts and preserves live hook facts. Healthy task-scoped
/// activation keeps the established low-CPU live-hook path; missing activation
/// opts only that task into active-transcript recovery.
pub(crate) fn spawn_codex_write_reconciliation_loop(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut throttle = ActiveCodexReconciliationThrottle::default();
        loop {
            // Keep blocking parsing off the async runtime without putting the
            // throttle behind a mutex held across filesystem and SQLite work.
            let worker_throttle = std::mem::take(&mut throttle);
            let result = tauri::async_runtime::spawn_blocking(move || {
                let mut worker_throttle = worker_throttle;
                let result = reconcile_recent_codex_sessions(&mut worker_throttle);
                (result, worker_throttle)
            })
            .await;
            match result {
                Ok((result, next_throttle)) => {
                    throttle = next_throttle;
                    match result {
                        Ok(reconciled) if reconciled > 0 => {
                            let _ = tauri::Emitter::emit(
                                &app,
                                super::RESOURCE_INTERACTIONS_CHANGED_EVENT,
                                (),
                            );
                        }
                        Ok(_) => {}
                        Err(err) => tracing::warn!(
                            error = %err,
                            "[SessionProvenance] Codex write reconciliation failed"
                        ),
                    }
                }
                Err(err) => tracing::warn!(
                    error = %err,
                    "[SessionProvenance] Codex write reconciliation task failed"
                ),
            }
            tokio::time::sleep(CODEX_WRITE_RECONCILIATION_POLL_INTERVAL).await;
        }
    });
}

fn reconcile_recent_codex_sessions(
    throttle: &mut ActiveCodexReconciliationThrottle,
) -> Result<usize, String> {
    const RECENT_SESSION_LIMIT: usize = 12;

    let mut conn = get_connection().map_err(|err| err.to_string())?;
    let now_ms = Utc::now().timestamp_millis();
    let sessions = if throttle.should_refresh_discovery(now_ms) {
        list_codex_app_reconciliation_sessions(&mut conn, RECENT_SESSION_LIMIT)?
    } else {
        query_recent_cached_sessions_for_source_from_conn(
            &conn,
            SOURCE_CODEX_APP,
            RECENT_SESSION_LIMIT,
        )?
    };
    throttle.retain_recent(sessions.iter().map(|session| session.session_id.as_str()));
    let mut reconciled = 0;
    let mut active_reconciliations = 0;
    for session in sessions {
        let hook_session_id = codex_thread_id_from_file_stem(&session.source_session_id)
            .unwrap_or(&session.source_session_id);
        let session_start_active =
            agent_cli::session_provenance::codex_session_start_is_active(hook_session_id)
                .unwrap_or(false);
        if !periodic_codex_reconciliation_needed(&session, session_start_active, now_ms) {
            throttle.clear(&session.session_id);
            continue;
        }
        if !background_codex_reconciliation_source_is_bounded(session.source_size_bytes) {
            // Keep the durable import marker untouched. This is a safety
            // boundary, not a claim that the transcript was reconciled.
            throttle.clear(&session.session_id);
            continue;
        }
        let is_quiescent = session_is_quiescent(&session, now_ms);
        if !is_quiescent {
            if !active_codex_recovery_is_quiet_enough(session.source_mtime_ms, now_ms)
                || active_reconciliations >= ACTIVE_CODEX_RECONCILIATION_BATCH_PER_PASS
            {
                continue;
            }
        }
        if !throttle.should_attempt(&session.session_id, is_quiescent, now_ms) {
            continue;
        }
        if !is_quiescent {
            active_reconciliations += 1;
        }
        let repo = session.repo_path.as_deref().unwrap_or(".");
        let canonical_repo = canonicalize_existing_prefix(Path::new(repo));
        match reconcile_imported_session(
            &mut conn,
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
    let workspace_path = session
        .workspace_path
        .as_deref()
        .or_else(|| canonical_repo.to_str())
        .unwrap_or(".");
    persist_cached_event_interactions_streaming(
        conn,
        &store,
        &session.source,
        Some(&session.source_session_id),
        &session.session_id,
        actor_id,
        workspace_path,
        precision,
        |file_path| Some(file_path.to_string()),
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
    use orgtrack_core::sources::imported_history::metadata::ImportedHistoryImpactStats;
    use orgtrack_core::store::sqlite::SqliteRecordStore;

    #[test]
    fn historical_backfill_uses_every_registered_imported_source() {
        assert_eq!(
            historical_imported_sources().collect::<Vec<_>>(),
            ImportedHistorySourceId::ALL
        );
    }

    fn imported_session_with_touched_files(
        touched_files: Vec<String>,
    ) -> ImportedHistoryCachedSession {
        ImportedHistoryCachedSession {
            source_session_id: "source-session".to_string(),
            session_id: "codexapp-source-session".to_string(),
            source_path: "/tmp/rollout.jsonl".to_string(),
            source_record_key: "source-session".to_string(),
            source_mtime_ms: 1,
            source_size_bytes: 1,
            source_fingerprint: "fingerprint".to_string(),
            parser_version: 1,
            name: "Imported session".to_string(),
            created_at_ms: 1,
            updated_at_ms: 1,
            model: None,
            input_tokens: 0,
            output_tokens: 0,
            repo_path: Some("/repo".to_string()),
            branch: None,
            impact: ImportedHistoryImpactStats {
                files_changed: touched_files.len() as i64,
                touched_files,
                ..ImportedHistoryImpactStats::default()
            },
            listable: true,
            source_metadata_json: None,
            parent_session_id: None,
        }
    }

    #[test]
    fn quiescence_normalizes_current_nanoseconds_and_legacy_milliseconds() {
        let now_ms = 1_800_000_000_000_i64;
        let quiet_ms = now_ms - SESSION_QUIESCENCE_MS - 1;
        let active_ms = now_ms - SESSION_QUIESCENCE_MS + 1;
        let mut session = imported_session_with_touched_files(Vec::new());

        session.source_mtime_ms = quiet_ms;
        assert!(session_is_quiescent(&session, now_ms));
        session.source_mtime_ms = quiet_ms * 1_000_000;
        assert!(session_is_quiescent(&session, now_ms));

        session.source_mtime_ms = active_ms;
        assert!(!session_is_quiescent(&session, now_ms));
        session.source_mtime_ms = active_ms * 1_000_000;
        assert!(!session_is_quiescent(&session, now_ms));
    }

    #[test]
    fn periodic_codex_recovery_skips_hooked_and_completed_sessions() {
        let now_ms = 1_800_000_000_000_i64;
        let mut session = imported_session_with_touched_files(Vec::new());
        session.source_mtime_ms = (now_ms - 60_000) * 1_000_000;

        assert!(periodic_codex_reconciliation_needed(
            &session, false, now_ms
        ));
        assert!(!periodic_codex_reconciliation_needed(
            &session, true, now_ms
        ));

        session.source_mtime_ms = (now_ms - SESSION_QUIESCENCE_MS - 1) * 1_000_000;
        assert!(!periodic_codex_reconciliation_needed(
            &session, false, now_ms
        ));
    }

    #[test]
    fn priority_file_matching_requires_the_catalog_to_preserve_relative_paths() {
        let repo = Path::new("/repo");
        let relative = imported_session_with_touched_files(vec!["src/new.rs".to_string()]);
        let absolute = imported_session_with_touched_files(vec!["/repo/src/new.rs".to_string()]);
        let basename_only = imported_session_with_touched_files(vec!["new.rs".to_string()]);

        assert!(session_touches_priority_file(&relative, repo, "src/new.rs"));
        assert!(session_touches_priority_file(&absolute, repo, "src/new.rs"));
        assert!(!session_touches_priority_file(
            &basename_only,
            repo,
            "src/new.rs"
        ));
    }

    #[test]
    fn historical_backfill_prepares_three_lazy_kv_turns_before_publish() {
        for source in [
            ImportedHistorySourceId::CursorIde,
            ImportedHistorySourceId::Windsurf,
        ] {
            let directory = tempfile::tempdir().expect("lazy backfill fixture");
            let source_path = directory.path().join(format!("{}.db", source.as_str()));
            let source_conn = Connection::open(&source_path).expect("KV source DB");
            source_conn
                .execute_batch(
                    "PRAGMA journal_mode=WAL;
                     CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT);",
                )
                .expect("KV source schema");
            let headers = (0..6)
                .map(|index| {
                    serde_json::json!({
                        "bubbleId":format!("b{index}"),
                        "type":if index % 2 == 0 { 1 } else { 2 },
                    })
                })
                .collect::<Vec<_>>();
            source_conn
                .execute(
                    "INSERT INTO cursorDiskKV(key,value) VALUES('composerData:c1',?1)",
                    [serde_json::json!({
                        "composerId":"c1",
                        "createdAt":1,
                        "lastUpdatedAt":6,
                        "fullConversationHeadersOnly":headers,
                    })
                    .to_string()],
                )
                .expect("composer row");
            for index in 0..6 {
                source_conn
                    .execute(
                        "INSERT INTO cursorDiskKV(key,value) VALUES(?1,?2)",
                        rusqlite::params![
                            format!("bubbleId:c1:b{index}"),
                            serde_json::json!({
                                "bubbleId":format!("b{index}"),
                                "type":if index % 2 == 0 { 1 } else { 2 },
                                "createdAt":format!("2026-07-22T00:00:{index:02}Z"),
                                "text":format!("message {index}"),
                            })
                            .to_string(),
                        ],
                    )
                    .expect("bubble row");
            }

            let mut cache = Connection::open_in_memory().expect("replay cache");
            SqliteRecordStore::init_tables(&cache).expect("Orgtrack tables");
            SqliteRecordStore::init_source_cache_tables(&cache).expect("source cache tables");
            let session_id = format!("{}c1", source.descriptor().session_prefix);
            cache
                .execute(
                    "INSERT INTO imported_history_session_cache(
                         source,source_session_id,session_id,source_path
                     ) VALUES(?1,'c1',?2,?3)",
                    rusqlite::params![source.as_str(), session_id, source_path.to_string_lossy()],
                )
                .expect("cache source path");
            let session = ImportedHistoryCachedSession {
                source_session_id: "c1".to_string(),
                session_id: session_id.clone(),
                source_path: source_path.to_string_lossy().into_owned(),
                source_record_key: "c1".to_string(),
                source_mtime_ms: 1,
                source_size_bytes: std::fs::metadata(&source_path)
                    .expect("source metadata")
                    .len() as i64,
                source_fingerprint: "lazy-three-turns".to_string(),
                parser_version: source.descriptor().parser_version as i64,
                name: "Lazy KV session".to_string(),
                created_at_ms: 1,
                updated_at_ms: 6,
                model: None,
                input_tokens: 0,
                output_tokens: 0,
                repo_path: Some(directory.path().to_string_lossy().into_owned()),
                branch: None,
                impact: ImportedHistoryImpactStats::default(),
                listable: true,
                source_metadata_json: None,
                parent_session_id: None,
            };

            assert!(reconcile_imported_session(
                &mut cache,
                source.as_str(),
                directory.path(),
                &session,
                ActiveSessionPolicy::AllowActive,
            )
            .expect("publish strict lazy provenance snapshot"));
            let replay_events = cache
                .query_row(
                    "SELECT COUNT(*) FROM imported_replay_events
                     WHERE source=?1 AND source_session_id='c1'",
                    [source.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count prepared replay events");
            assert_eq!(replay_events, 6, "{}", source.as_str());
            assert!(SqliteRecordStore::new(&cache)
                .interaction_import_is_current(
                    source.as_str(),
                    &session_id,
                    &imported_session_fingerprint(&session),
                    HISTORICAL_INTERACTION_PARSER_VERSION,
                )
                .expect("backfill checkpoint"));
        }
    }

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

    #[test]
    fn active_codex_reconciliation_is_sparse_but_quiescence_flushes_immediately() {
        let mut throttle = ActiveCodexReconciliationThrottle::default();
        let now_ms = 1_000_000;

        assert!(throttle.should_attempt("active", false, now_ms));
        assert!(!throttle.should_attempt(
            "active",
            false,
            now_ms + ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS - 1
        ));
        assert!(throttle.should_attempt(
            "active",
            false,
            now_ms + ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS
        ));

        // The final quiet transcript is never delayed by the active throttle.
        assert!(throttle.should_attempt("active", true, now_ms + 1));
        assert!(!throttle.attempted_at_ms.contains_key("active"));
    }

    #[test]
    fn active_codex_reconciliation_throttle_is_bounded_to_recent_sessions() {
        let mut throttle = ActiveCodexReconciliationThrottle::default();
        assert!(throttle.should_attempt("old", false, 1));
        assert!(throttle.should_attempt(
            "recent",
            false,
            1 + ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS
        ));

        throttle.retain_recent(["recent"]);

        assert_eq!(throttle.attempted_at_ms.len(), 1);
        assert!(throttle.attempted_at_ms.contains_key("recent"));
    }

    #[test]
    fn active_codex_reconciliation_is_globally_serialized() {
        let mut throttle = ActiveCodexReconciliationThrottle::default();
        let now_ms = 1_000_000;

        assert!(throttle.should_attempt("first", false, now_ms));
        assert!(!throttle.should_attempt(
            "second",
            false,
            now_ms + ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS - 1
        ));
        assert!(throttle.should_attempt(
            "second",
            false,
            now_ms + ACTIVE_CODEX_RECONCILIATION_INTERVAL_MS
        ));
    }

    #[test]
    fn background_codex_reconciliation_rejects_giant_rollouts() {
        assert!(background_codex_reconciliation_source_is_bounded(
            MAX_BACKGROUND_CODEX_RECONCILIATION_SOURCE_BYTES
        ));
        assert!(!background_codex_reconciliation_source_is_bounded(
            MAX_BACKGROUND_CODEX_RECONCILIATION_SOURCE_BYTES + 1
        ));
    }

    #[test]
    fn codex_discovery_refresh_is_low_frequency() {
        let mut throttle = ActiveCodexReconciliationThrottle::default();
        let now_ms = 1_000_000;

        assert!(throttle.should_refresh_discovery(now_ms));
        assert!(
            !throttle.should_refresh_discovery(now_ms + CODEX_DISCOVERY_REFRESH_INTERVAL_MS - 1)
        );
        assert!(throttle.should_refresh_discovery(now_ms + CODEX_DISCOVERY_REFRESH_INTERVAL_MS));
    }

    #[test]
    fn active_codex_recovery_waits_for_a_short_writer_quiet_window() {
        let now_ms = 1_000_000;

        assert!(!active_codex_recovery_is_quiet_enough(
            now_ms - ACTIVE_CODEX_MIN_QUIET_MS + 1,
            now_ms
        ));
        assert!(active_codex_recovery_is_quiet_enough(
            now_ms - ACTIVE_CODEX_MIN_QUIET_MS,
            now_ms
        ));
    }

    #[test]
    fn imported_history_source_age_accepts_legacy_milliseconds_and_current_nanoseconds() {
        let now_ms = 1_750_000_000_000;
        let source_ms = now_ms - ACTIVE_CODEX_MIN_QUIET_MS;
        let source_ns = source_ms * 1_000_000;

        assert_eq!(source_age_ms(source_ms, now_ms), ACTIVE_CODEX_MIN_QUIET_MS);
        assert_eq!(source_age_ms(source_ns, now_ms), ACTIVE_CODEX_MIN_QUIET_MS);
        assert!(active_codex_recovery_is_quiet_enough(source_ms, now_ms));
        assert!(active_codex_recovery_is_quiet_enough(source_ns, now_ms));
    }
}
