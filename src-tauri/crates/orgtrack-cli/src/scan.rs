//! Provider scanning: resolve each source id to a unit of scan work, run every
//! target provider (built-in, JSONL plugin, or exec plugin) into the index on
//! its own worker thread, and read cached rows back for `--no-scan`.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use rusqlite::Connection;

use orgtrack_core::sources::anthropic_jsonl::{self, AnthropicJsonlSource};
use orgtrack_core::sources::imported_history::{
    self, ImportedHistorySessionPage, ImportedHistorySessionRow,
};
use orgtrack_core::sources::registry;

use crate::plugin_exec::run_exec_scan;
use crate::plugins::{ExecSpec, LoaderImpl, LoaderPlugin};
use crate::store::open_conn;
use crate::{Options, ScannedRow, SCAN_PAGE};

/// A unit of scan work, `Send` so it moves into its worker thread: a built-in
/// provider (dispatched through the core registry), a declarative JSONL plugin
/// (the generic reader), or an exec plugin (a subprocess).
pub(crate) enum ScanJob {
    Builtin(String),
    Jsonl(AnthropicJsonlSource),
    Exec(ExecJob),
}

/// Everything a worker needs to run one exec plugin's `scan` and ingest it.
pub(crate) struct ExecJob {
    pub(crate) source: &'static str,
    pub(crate) session_prefix: &'static str,
    pub(crate) spec: ExecSpec,
    pub(crate) timeout: Duration,
}

impl ScanJob {
    pub(crate) fn run(&self, conn: &mut Connection) -> Result<ImportedHistorySessionPage, String> {
        match self {
            ScanJob::Builtin(id) => registry::scan_source(conn, id, SCAN_PAGE, 0),
            ScanJob::Jsonl(config) => {
                anthropic_jsonl::list_sessions_paginated(config, conn, SCAN_PAGE, 0)
            }
            ScanJob::Exec(job) => run_exec_scan(conn, job),
        }
    }
}

/// Every source id in play this run: built-ins plus discovered plugins, or the
/// `--source` filter verbatim (already validated).
pub(crate) fn target_source_ids(opts: &Options, plugins: &[LoaderPlugin]) -> Vec<String> {
    if !opts.sources.is_empty() {
        return opts.sources.clone();
    }
    let mut ids: Vec<String> = registry::registered_sources()
        .iter()
        .map(|source| source.id.to_string())
        .collect();
    ids.extend(plugins.iter().map(|plugin| plugin.id.to_string()));
    ids
}

/// Resolve one source id to its scan job, or a human reason it is skipped
/// (unknown, or an untrusted exec plugin).
pub(crate) fn resolve_scan_job(
    id: &str,
    plugins: &[LoaderPlugin],
    timeout: Duration,
) -> Result<ScanJob, String> {
    if registry::is_registered(id) {
        return Ok(ScanJob::Builtin(id.to_string()));
    }
    let plugin = plugins
        .iter()
        .find(|plugin| plugin.id == id)
        .ok_or_else(|| "unknown source".to_string())?;
    match &plugin.imp {
        LoaderImpl::Jsonl(config) => Ok(ScanJob::Jsonl(config.clone())),
        LoaderImpl::Exec(spec) => {
            if !plugin.runnable() {
                return Err(format!("untrusted — run `orgtrack plugins trust {id}`"));
            }
            Ok(ScanJob::Exec(ExecJob {
                source: plugin.id,
                session_prefix: plugin.session_prefix,
                spec: spec.clone(),
                timeout,
            }))
        }
    }
}

/// Reject a `--source` that names neither a built-in nor a discovered plugin.
pub(crate) fn validate_sources(opts: &Options, plugins: &[LoaderPlugin]) -> Result<(), String> {
    for source in &opts.sources {
        let known =
            registry::is_registered(source) || plugins.iter().any(|plugin| plugin.id == *source);
        if !known {
            return Err(format!(
                "unknown --source '{source}'. Run `orgtrack sources` to list them."
            ));
        }
    }
    Ok(())
}

/// Scan each target provider into the index at `path`, returning every
/// discovered session tagged with its source.
///
/// Each provider runs on its own worker thread with its own connection to the
/// index file, bounded by `opts.timeout()`. A provider that errors (tool not
/// installed, store missing) is skipped; a provider that *exceeds its budget*
/// (a locked store, a pathological file) is abandoned — its thread is left to
/// die at process exit — so one bad tool never hangs the whole scan. Progress
/// streams to **stderr** so a slow provider is never mistaken for a hang, while
/// stdout/JSON stays clean.
pub(crate) fn scan_all(path: &str, opts: &Options, plugins: &[LoaderPlugin]) -> Vec<ScannedRow> {
    let ids = target_source_ids(opts, plugins);
    let timeout = opts.timeout();
    eprintln!(
        "Scanning {} tool(s) (per-tool budget {}s)…",
        ids.len(),
        timeout.as_secs()
    );

    let mut scanned = Vec::new();
    for source in ids {
        eprint!("  {source:<14} …");
        let job = match resolve_scan_job(&source, plugins, timeout) {
            Ok(job) => job,
            Err(reason) => {
                eprintln!("\r  {source:<14} skipped ({reason})");
                continue;
            }
        };
        // An exec plugin kills its own child at `timeout` from inside the
        // worker; give the worker a grace buffer beyond that so we always
        // collect its result (and the kill has happened) instead of abandoning
        // it mid-kill and orphaning the child process. Built-in/JSONL jobs have
        // no child, so abandoning at `timeout` only leaks a thread.
        let recv_timeout = match &job {
            ScanJob::Exec(_) => timeout + Duration::from_secs(5),
            _ => timeout,
        };
        let (tx, rx) = mpsc::channel();
        let worker_path = path.to_string();
        thread::spawn(move || {
            let result =
                open_conn(&worker_path).and_then(|mut conn| job.run(&mut conn));
            // Receiver may be gone (we timed out and moved on); ignore.
            let _ = tx.send(result);
        });

        match rx.recv_timeout(recv_timeout) {
            Ok(Ok(page)) => {
                eprintln!("\r  {:<14} {} sessions      ", source, page.sessions.len());
                for row in page.sessions {
                    scanned.push(ScannedRow {
                        source: source.clone(),
                        row,
                    });
                }
            }
            Ok(Err(err)) => eprintln!("\r  {source:<14} skipped ({err})"),
            Err(mpsc::RecvTimeoutError::Timeout) => eprintln!(
                "\r  {source:<14} timed out after {}s — skipped (try `--source {source} --timeout N`)",
                timeout.as_secs()
            ),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                eprintln!("\r  {source:<14} worker exited unexpectedly")
            }
        }
    }
    scanned
}

/// Read already-indexed sessions straight from the cache tables — the
/// `--no-scan` path — without touching any provider on disk. Covers the target
/// sources' listable rows.
pub(crate) fn read_cached(
    conn: &Connection,
    opts: &Options,
    plugins: &[LoaderPlugin],
) -> Result<Vec<ScannedRow>, String> {
    let mut scanned = Vec::new();
    for source in target_source_ids(opts, plugins) {
        let cached =
            imported_history::cache::query_cached_sessions_for_source_from_conn(conn, &source)?;
        for session in cached {
            scanned.push(ScannedRow {
                source: source.clone(),
                row: cached_to_row(session),
            });
        }
    }
    Ok(scanned)
}

/// Project a cache row into the shared display row. Timestamps are stored as
/// epoch-ms in the cache; impact/token fields are already denormalized there.
pub(crate) fn cached_to_row(
    session: imported_history::cache::ImportedHistoryCachedSession,
) -> ImportedHistorySessionRow {
    let repo_name = session
        .repo_path
        .as_deref()
        .and_then(imported_history::repo_name_from_path);
    ImportedHistorySessionRow {
        session_id: session.session_id,
        name: session.name,
        status: "completed".to_string(),
        created_at: imported_history::epoch_ms_to_iso(session.created_at_ms),
        updated_at: imported_history::epoch_ms_to_iso(session.updated_at_ms),
        category: "imported",
        read_only: true,
        model: session.model,
        total_tokens: session.input_tokens.saturating_add(session.output_tokens),
        background: false,
        is_active: false,
        storage_path: Some(session.source_path),
        repo_path: session.repo_path,
        repo_name,
        branch: session.branch,
        files_changed: session.impact.files_changed,
        lines_added: session.impact.lines_added,
        lines_removed: session.impact.lines_removed,
        touched_files: session.impact.touched_files,
        parent_session_id: session.parent_session_id,
    }
}

pub(crate) fn counts_by_source(scanned: &[ScannedRow]) -> Vec<(String, usize)> {
    let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for item in scanned {
        *counts.entry(item.source.clone()).or_default() += 1;
    }
    counts.into_iter().collect()
}
