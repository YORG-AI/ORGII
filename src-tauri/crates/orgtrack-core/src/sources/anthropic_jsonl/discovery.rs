use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::sources::imported_history::{
    metadata::ImportedHistoryDiscoveredRecord, paths as imported_paths, scan_snapshot,
};

use super::config::AnthropicJsonlSource;

pub(super) fn discover_records(
    config: &AnthropicJsonlSource,
    conn: &Connection,
) -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut records = Vec::new();
    let mut seen_paths = HashSet::new();
    let previous_snapshots = config
        .max_discovery_depth
        .map(|_| scan_snapshot::read_dir_snapshots_from_conn(conn, config.source));
    let mut walker = previous_snapshots.as_ref().map(|previous| {
        scan_snapshot::SnapshotDirWalker::new(previous, "jsonl", config.display_name)
    });
    for root in config.candidate_roots.clone() {
        if !root.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        if let (Some(max_depth), Some(walker)) = (config.max_discovery_depth, walker.as_mut()) {
            walker.collect_files_bounded(&root, &mut files, max_depth)?;
        } else {
            collect_jsonl_files(&root, config.exclude_subagent_dirs, &mut files)?;
        }
        for path in files {
            if !seen_paths.insert(path.clone()) {
                continue;
            }
            let relative = path.strip_prefix(&root).unwrap_or(&path);
            if config
                .max_discovery_depth
                .is_some_and(|expected| relative.components().count().saturating_sub(1) != expected)
            {
                continue;
            }
            let mut source_session_id = relative.with_extension("").to_string_lossy().to_string();
            if std::path::MAIN_SEPARATOR != '/' {
                source_session_id = source_session_id.replace(std::path::MAIN_SEPARATOR, "/");
            }
            if source_session_id.trim().is_empty() {
                continue;
            }
            let (mtime, size) =
                imported_paths::file_metadata_signature(&path, config.display_name)?;
            records.push(ImportedHistoryDiscoveredRecord {
                source_session_id: source_session_id.clone(),
                source_path: path,
                source_record_key: source_session_id,
                source_mtime_ms: mtime,
                source_size_bytes: size,
                source_fingerprint: String::new(),
                parser_version: config.parser_version,
            });
        }
    }
    if let (Some(previous), Some(walker)) = (previous_snapshots.as_ref(), walker) {
        let next = walker.into_snapshots();
        scan_snapshot::persist_dir_snapshots_if_changed(conn, config.source, previous, &next)?;
    }
    Ok(records)
}

fn collect_jsonl_files(
    dir: &Path,
    exclude_subagent_dirs: bool,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if exclude_subagent_dirs
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == "subagents")
            {
                continue;
            }
            collect_jsonl_files(&path, exclude_subagent_dirs, out)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            out.push(path);
        }
    }
    Ok(())
}
