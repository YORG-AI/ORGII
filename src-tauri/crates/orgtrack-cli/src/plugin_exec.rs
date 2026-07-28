//! Exec plugin protocol (kind = loader, format = exec) plus the processor
//! stages and the JSON helpers they share: spawn a trusted plugin subprocess,
//! exchange JSON over stdio, and project results into cache inputs / display
//! rows / activity chunks.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use core_types::activity::ActivityChunk;
use rusqlite::Connection;

use orgtrack_core::sources::anthropic_jsonl;
use orgtrack_core::sources::imported_history::{
    self,
    metadata::{ImportedHistoryCacheInput, ImportedHistoryImpactStats},
    ImportedHistorySessionPage, ImportedHistorySessionRow,
};

use crate::plugins::{ExecSpec, LoaderImpl, LoaderPlugin, ProcessorPlugin, Stage};
use crate::scan::ExecJob;
use crate::{ScannedRow, SCAN_PAGE};

/// Run a trusted exec plugin's `scan` verb, ingest the returned sessions into
/// the cache (same primitive the built-in loaders use), and read back a page.
pub(crate) fn run_exec_scan(
    conn: &mut Connection,
    job: &ExecJob,
) -> Result<ImportedHistorySessionPage, String> {
    let request = serde_json::json!({ "protocol": job.spec.protocol, "verb": "scan" }).to_string();
    let response = run_plugin_exec(&job.spec, &request, job.timeout)?;
    let sessions = response
        .get("sessions")
        .and_then(|value| value.as_array())
        .ok_or("plugin response missing a 'sessions' array")?;

    let mut inputs = Vec::with_capacity(sessions.len());
    let mut live_ids = Vec::with_capacity(sessions.len());
    for session in sessions {
        let input = exec_session_to_input(job, session)?;
        live_ids.push(input.source_session_id.clone());
        inputs.push(input);
    }
    imported_history::cache::sync_source_cache_from_conn(conn, job.source, live_ids, inputs)?;
    imported_history::cache::query_imported_session_page_from_conn(conn, job.source, SCAN_PAGE, 0)
}

/// Run a trusted exec plugin's `load` verb for one session → its chunks.
pub(crate) fn run_exec_load(
    spec: &ExecSpec,
    session_id: &str,
    session_prefix: &str,
    timeout: Duration,
) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = session_id
        .strip_prefix(session_prefix)
        .unwrap_or(session_id);
    let request = serde_json::json!({
        "protocol": spec.protocol,
        "verb": "load",
        "sourceSessionId": source_session_id,
    })
    .to_string();
    let response = run_plugin_exec(spec, &request, timeout)?;
    let chunks = response
        .get("chunks")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
    serde_json::from_value(chunks).map_err(|err| format!("plugin 'chunks' were not valid: {err}"))
}

/// Spawn the plugin, feed it `request` on stdin, and return its parsed stdout
/// JSON — bounded by `timeout` (the child is killed on overrun). The
/// environment is scrubbed (only PATH/HOME pass through) and the CWD is the
/// manifest dir; the child never receives the SQLite handle.
/// Run a plugin exec and return its parsed JSON stdout.
pub(crate) fn run_plugin_exec(
    spec: &ExecSpec,
    request: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let stdout = run_exec_raw(spec, request, timeout)?;
    serde_json::from_str(&stdout).map_err(|err| format!("plugin returned invalid JSON: {err}"))
}

/// Run an action hook (a trigger hook): feed it the payload on stdin, ignore
/// its stdout, succeed iff it exits 0.
pub(crate) fn run_hook(spec: &ExecSpec, payload: &str, timeout: Duration) -> Result<(), String> {
    run_exec_raw(spec, payload, timeout).map(|_| ())
}

/// Spawn a plugin exec, feed `request` on stdin (scrubbed env, manifest-dir
/// CWD, no DB handle), and return its stdout — bounded by `timeout` (the child
/// is killed on overrun).
fn run_exec_raw(spec: &ExecSpec, request: &str, timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(&spec.exec_path)
        .current_dir(&spec.cwd)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", std::env::var_os("HOME").unwrap_or_default())
        .env("ORGTRACK_PROTOCOL", spec.protocol.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("spawn {}: {err}", spec.exec_path.display()))?;

    // Feed stdin and drain stdout/stderr from threads so a large exchange
    // can't deadlock on a full pipe buffer.
    let mut stdin = child.stdin.take().ok_or("no stdin pipe")?;
    let request_owned = request.to_string();
    let writer = thread::spawn(move || {
        let _ = stdin.write_all(request_owned.as_bytes());
        // stdin drops here, signalling EOF to the child.
    });
    let mut stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let out_reader = thread::spawn(move || {
        let mut buffer = String::new();
        let _ = stdout.read_to_string(&mut buffer);
        buffer
    });
    let mut stderr = child.stderr.take().ok_or("no stderr pipe")?;
    let err_reader = thread::spawn(move || {
        let mut buffer = String::new();
        let _ = stderr.read_to_string(&mut buffer);
        buffer
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("plugin timed out after {}s", timeout.as_secs()));
                }
                thread::sleep(Duration::from_millis(40));
            }
            Err(err) => return Err(format!("waiting on plugin: {err}")),
        }
    };

    let _ = writer.join();
    let stdout_text = out_reader.join().unwrap_or_default();
    let stderr_text = err_reader.join().unwrap_or_default();

    if !status.success() {
        let code = status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_string());
        let detail = stderr_text.trim();
        return Err(if detail.is_empty() {
            format!("plugin exited with {code}")
        } else {
            format!("plugin exited with {code}: {detail}")
        });
    }
    Ok(stdout_text)
}

/// Project one plugin session JSON object into a cache input. Missing fields
/// default sensibly; `sessionId` is derived (`prefix + sourceSessionId`).
pub(crate) fn exec_session_to_input(
    job: &ExecJob,
    value: &serde_json::Value,
) -> Result<ImportedHistoryCacheInput, String> {
    let source_session_id =
        js_str(value, "sourceSessionId").ok_or("a session is missing its 'sourceSessionId'")?;
    let updated_at_ms = js_i64(value, "updatedAtMs");
    let source_path = js_str(value, "sourcePath").unwrap_or_default();
    Ok(ImportedHistoryCacheInput {
        source: job.source,
        session_id: format!("{}{}", job.session_prefix, source_session_id),
        source_session_id: source_session_id.clone(),
        source_path,
        source_record_key: source_session_id,
        source_mtime_ms: js_i64_or(value, "sourceMtimeMs", updated_at_ms),
        source_size_bytes: js_i64(value, "sourceSizeBytes"),
        source_fingerprint: js_str(value, "sourceFingerprint")
            .unwrap_or_else(|| updated_at_ms.to_string()),
        parser_version: job.spec.parser_version,
        name: js_str(value, "name").unwrap_or_default(),
        created_at_ms: js_i64(value, "createdAtMs"),
        updated_at_ms,
        model: js_str(value, "model"),
        input_tokens: js_i64(value, "inputTokens"),
        output_tokens: js_i64(value, "outputTokens"),
        cache_read_tokens: js_i64(value, "cacheReadTokens"),
        cache_write_tokens: js_i64(value, "cacheWriteTokens"),
        repo_path: js_str(value, "repoPath"),
        branch: js_str(value, "branch"),
        impact: ImportedHistoryImpactStats {
            files_changed: js_i64(value, "filesChanged"),
            lines_added: js_i64(value, "linesAdded"),
            lines_removed: js_i64(value, "linesRemoved"),
            touched_files: js_str_vec(value, "touchedFiles"),
        },
        listable: value
            .get("listable")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        source_metadata_json: None,
        parent_session_id: js_str(value, "parentSessionId"),
    })
}

pub(crate) fn js_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|field| field.as_str())
        .map(str::to_string)
        .filter(|text| !text.is_empty())
}

pub(crate) fn js_i64(value: &serde_json::Value, key: &str) -> i64 {
    js_i64_or(value, key, 0)
}

pub(crate) fn js_i64_or(value: &serde_json::Value, key: &str, default: i64) -> i64 {
    value
        .get(key)
        .and_then(|field| field.as_i64())
        .unwrap_or(default)
}

pub(crate) fn js_str_vec(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|field| field.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Load a session's activity chunks, routing plugin sessions (matched by their
/// `session_prefix`) through the plugin's own loader (generic JSONL, or the
/// exec plugin's `load` verb), and everything else through core's built-in
/// provider router. `Ok(None)` = unknown id.
pub(crate) fn load_session_chunks(
    conn: &Connection,
    session_id: &str,
    plugins: &[LoaderPlugin],
    timeout: Duration,
) -> Result<Option<Vec<ActivityChunk>>, String> {
    if let Some(plugin) = plugins
        .iter()
        .find(|plugin| session_id.starts_with(plugin.session_prefix))
    {
        return match &plugin.imp {
            LoaderImpl::Jsonl(config) => {
                anthropic_jsonl::load_session(config, conn, session_id).map(Some)
            }
            LoaderImpl::Exec(spec) => {
                if !plugin.runnable() {
                    return Err(format!(
                        "plugin '{}' is untrusted — run `orgtrack plugins trust {}`",
                        plugin.id, plugin.id
                    ));
                }
                run_exec_load(spec, session_id, plugin.session_prefix, timeout).map(Some)
            }
        };
    }
    imported_history::load_activity_chunks_for_session(conn, session_id)
}

/// The source id a session belongs to, resolved from a plugin `session_prefix`.
/// Empty for built-in sessions (their prefixes aren't exposed) — so a
/// chunk-processor scoped to a specific built-in matches nothing; use `"*"`.
pub(crate) fn source_of_session(session_id: &str, plugins: &[LoaderPlugin]) -> String {
    plugins
        .iter()
        .find(|plugin| session_id.starts_with(plugin.session_prefix))
        .map(|plugin| plugin.id.to_string())
        .unwrap_or_default()
}

/// Run session-stage processors over the display rows. Each processor sees the
/// in-scope rows as JSON, and returns the reshaped set (it may drop, filter,
/// rename, or annotate). A failing or untrusted processor is a no-op with a
/// stderr note — processors never lose your data. This is a display transform;
/// it does not touch the persisted index or `usage`.
pub(crate) fn apply_session_processors(
    mut scanned: Vec<ScannedRow>,
    processors: &[ProcessorPlugin],
    timeout: Duration,
) -> Vec<ScannedRow> {
    for processor in processors {
        if processor.stage != Stage::Session {
            continue;
        }
        let (in_scope, mut out_scope): (Vec<ScannedRow>, Vec<ScannedRow>) = scanned
            .into_iter()
            .partition(|row| processor.applies_to(&row.source));
        if in_scope.is_empty() {
            scanned = out_scope;
            continue;
        }
        if !processor.runnable() {
            eprintln!(
                "orgtrack: processor '{}' is untrusted — skipped (run `orgtrack plugins trust {}`)",
                processor.id, processor.id
            );
            out_scope.extend(in_scope);
            scanned = out_scope;
            continue;
        }
        let json_rows: Vec<serde_json::Value> = in_scope
            .iter()
            .map(|item| {
                let mut value = serde_json::to_value(&item.row).unwrap_or(serde_json::Value::Null);
                if let Some(object) = value.as_object_mut() {
                    object.insert(
                        "source".into(),
                        serde_json::Value::String(item.source.clone()),
                    );
                }
                value
            })
            .collect();
        let request = serde_json::json!({
            "protocol": processor.spec.protocol,
            "stage": "session",
            "sessions": json_rows,
        })
        .to_string();
        match run_plugin_exec(&processor.spec, &request, timeout) {
            Ok(response) => match response.get("sessions").and_then(|value| value.as_array()) {
                Some(rows) => {
                    for value in rows {
                        if let Some(row) = scanned_row_from_json(value) {
                            out_scope.push(row);
                        }
                    }
                }
                None => {
                    eprintln!(
                        "orgtrack: processor '{}' returned no 'sessions' — keeping originals",
                        processor.id
                    );
                    out_scope.extend(in_scope);
                }
            },
            Err(err) => {
                eprintln!(
                    "orgtrack: processor '{}' failed ({err}) — keeping originals",
                    processor.id
                );
                out_scope.extend(in_scope);
            }
        }
        scanned = out_scope;
    }
    scanned
}

/// Run chunk-stage processors over one session's chunks before rendering.
pub(crate) fn apply_chunk_processors(
    session_id: &str,
    source: &str,
    mut chunks: Vec<ActivityChunk>,
    processors: &[ProcessorPlugin],
    timeout: Duration,
) -> Vec<ActivityChunk> {
    for processor in processors {
        if processor.stage != Stage::Chunk || !processor.applies_to(source) {
            continue;
        }
        if !processor.runnable() {
            eprintln!(
                "orgtrack: processor '{}' is untrusted — skipped (run `orgtrack plugins trust {}`)",
                processor.id, processor.id
            );
            continue;
        }
        let request = serde_json::json!({
            "protocol": processor.spec.protocol,
            "stage": "chunk",
            "sessionId": session_id,
            "chunks": serde_json::to_value(&chunks).unwrap_or(serde_json::Value::Array(Vec::new())),
        })
        .to_string();
        match run_plugin_exec(&processor.spec, &request, timeout) {
            Ok(response) => {
                if let Some(value) = response.get("chunks") {
                    match serde_json::from_value::<Vec<ActivityChunk>>(value.clone()) {
                        Ok(parsed) => chunks = parsed,
                        Err(err) => eprintln!(
                            "orgtrack: processor '{}' returned invalid chunks ({err}) — keeping originals",
                            processor.id
                        ),
                    }
                }
            }
            Err(err) => eprintln!(
                "orgtrack: processor '{}' failed ({err}) — keeping originals",
                processor.id
            ),
        }
    }
    chunks
}

/// Rebuild a display row from a processor's JSON output (camelCase, the same
/// shape `list --json` emits). Returns `None` if it lacks a `source` +
/// `sessionId`; `category` is not round-tripped (always `imported`).
pub(crate) fn scanned_row_from_json(value: &serde_json::Value) -> Option<ScannedRow> {
    let source = js_str(value, "source")?;
    let session_id = js_str(value, "sessionId")?;
    let flag =
        |key: &str, default: bool| value.get(key).and_then(|v| v.as_bool()).unwrap_or(default);
    Some(ScannedRow {
        source,
        row: ImportedHistorySessionRow {
            session_id,
            name: js_str(value, "name").unwrap_or_default(),
            status: js_str(value, "status").unwrap_or_else(|| "completed".to_string()),
            created_at: js_str(value, "createdAt").unwrap_or_default(),
            updated_at: js_str(value, "updatedAt").unwrap_or_default(),
            category: "imported",
            read_only: flag("readOnly", true),
            model: js_str(value, "model"),
            total_tokens: js_i64(value, "totalTokens"),
            background: flag("background", false),
            is_active: flag("isActive", false),
            repo_path: js_str(value, "repoPath"),
            repo_root_path: js_str(value, "repoRootPath"),
            repo_remote_urls: js_str_vec(value, "repoRemoteUrls"),
            storage_path: js_str(value, "storagePath"),
            repo_name: js_str(value, "repoName"),
            branch: js_str(value, "branch"),
            files_changed: js_i64(value, "filesChanged"),
            lines_added: js_i64(value, "linesAdded"),
            lines_removed: js_i64(value, "linesRemoved"),
            touched_files: js_str_vec(value, "touchedFiles"),
            parent_session_id: js_str(value, "parentSessionId"),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn exec_job() -> ExecJob {
        ExecJob {
            source: "s",
            session_prefix: "s-",
            spec: ExecSpec {
                exec_path: PathBuf::from("/x"),
                cwd: PathBuf::from("/"),
                protocol: 1,
                parser_version: 7,
            },
            timeout: Duration::from_secs(1),
        }
    }

    #[test]
    fn json_helpers_read_and_default() {
        let value = serde_json::json!({"a": "x", "n": 5, "arr": ["p", "q"], "empty": ""});
        assert_eq!(js_str(&value, "a").as_deref(), Some("x"));
        assert_eq!(js_str(&value, "empty"), None);
        assert_eq!(js_str(&value, "missing"), None);
        assert_eq!(js_i64(&value, "n"), 5);
        assert_eq!(js_i64(&value, "missing"), 0);
        assert_eq!(js_str_vec(&value, "arr"), vec!["p", "q"]);
        assert!(js_str_vec(&value, "missing").is_empty());
    }

    #[test]
    fn exec_session_maps_all_fields() {
        let job = exec_job();
        let value = serde_json::json!({
            "sourceSessionId": "abc",
            "name": "hi",
            "createdAtMs": 100, "updatedAtMs": 200,
            "model": "m",
            "inputTokens": 10, "outputTokens": 5,
            "cacheReadTokens": 3, "cacheWriteTokens": 2,
            "repoPath": "/r", "branch": "main",
            "filesChanged": 4, "linesAdded": 20, "linesRemoved": 1,
            "touchedFiles": ["a", "b"], "sourcePath": "/p",
            "listable": true, "parentSessionId": "par",
        });
        let input = exec_session_to_input(&job, &value).unwrap();
        assert_eq!(input.source, "s");
        assert_eq!(input.session_id, "s-abc");
        assert_eq!(input.source_session_id, "abc");
        assert_eq!(input.parser_version, 7);
        assert_eq!(input.updated_at_ms, 200);
        assert_eq!(input.input_tokens, 10);
        assert_eq!(input.output_tokens, 5);
        assert_eq!(input.cache_read_tokens, 3);
        assert_eq!(input.impact.files_changed, 4);
        assert_eq!(input.impact.touched_files, vec!["a", "b"]);
        assert_eq!(input.parent_session_id.as_deref(), Some("par"));
        // Fingerprint defaults to the update time when the plugin omits it.
        assert_eq!(input.source_fingerprint, "200");
        assert!(input.listable);
    }

    #[test]
    fn exec_session_requires_source_session_id() {
        let job = exec_job();
        assert!(exec_session_to_input(&job, &serde_json::json!({"name": "x"})).is_err());
    }

    #[test]
    fn scanned_row_reconstructs_from_json() {
        let value = serde_json::json!({
            "source": "s", "sessionId": "id", "name": "n",
            "totalTokens": 42, "filesChanged": 3, "touchedFiles": ["x"],
        });
        let row = scanned_row_from_json(&value).unwrap();
        assert_eq!(row.source, "s");
        assert_eq!(row.row.session_id, "id");
        assert_eq!(row.row.name, "n");
        assert_eq!(row.row.total_tokens, 42);
        assert_eq!(row.row.files_changed, 3);
        assert_eq!(row.row.category, "imported");
        // Missing source or sessionId → not reconstructable.
        assert!(scanned_row_from_json(&serde_json::json!({"sessionId": "x"})).is_none());
        assert!(scanned_row_from_json(&serde_json::json!({"source": "x"})).is_none());
    }
}
