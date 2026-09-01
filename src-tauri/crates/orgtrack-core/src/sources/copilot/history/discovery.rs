//! Filesystem discovery of `~/.copilot/session-state/<uuid>/events.jsonl`
//! transcripts, including the session-directory name-shape guard.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, PathBuf};

use rusqlite::Connection;

use crate::sources::imported_history::{
    metadata::{ImportedHistoryDiscoveredRecord, SOURCE_COPILOT},
    paths as imported_paths, scan_snapshot,
};

use super::paths::ensure_exact_copilot_events_file;
use super::types::{CopilotDbEnrichment, CopilotDiscoveredRecord};
use super::{
    COPILOT_METADATA_PARSER_VERSION, EVENTS_FILENAME, MAX_DISCOVERED_SESSIONS,
    MAX_EVENTS_FILE_BYTES,
};

pub(super) fn discover_copilot_history_records(
    conn: &Connection,
    roots: &[PathBuf],
) -> Result<Vec<CopilotDiscoveredRecord>, String> {
    let previous = scan_snapshot::read_dir_snapshots_from_conn(conn, SOURCE_COPILOT);
    let mut walker = scan_snapshot::SnapshotDirWalker::new(&previous, "jsonl", "Copilot");
    let mut records = Vec::new();
    let mut seen_session_ids = HashSet::new();
    for root in roots {
        match fs::symlink_metadata(root) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to inspect Copilot history root {}: {error}",
                    root.display()
                ))
            }
        }
        let mut files = Vec::new();
        walker.collect_files_bounded(root, &mut files, 1)?;
        for events_path in files {
            let Some(relative) = events_path.strip_prefix(root).ok() else {
                continue;
            };
            let components = relative
                .components()
                .map(|component| match component {
                    Component::Normal(value) => value.to_str(),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>();
            let Some(components) = components else {
                continue;
            };
            let [id, filename] = components.as_slice() else {
                continue;
            };
            if *filename != EVENTS_FILENAME
                || !is_plain_session_dir_name(id)
                || !seen_session_ids.insert((*id).to_string())
            {
                continue;
            }
            ensure_exact_copilot_events_file(&events_path, root, id)?;
            let (source_mtime_ms, source_size_bytes) =
                imported_paths::file_metadata_signature(&events_path, "Copilot")?;
            if source_size_bytes > MAX_EVENTS_FILE_BYTES {
                return Err(format!(
                    "Copilot history {} exceeds the {}-byte safety limit",
                    events_path.display(),
                    MAX_EVENTS_FILE_BYTES
                ));
            }
            records.push(CopilotDiscoveredRecord {
                record: ImportedHistoryDiscoveredRecord {
                    source_session_id: (*id).to_string(),
                    source_record_key: (*id).to_string(),
                    source_fingerprint: "copilot-events-v2|db=deferred".to_string(),
                    source_path: events_path,
                    source_mtime_ms,
                    source_size_bytes,
                    parser_version: COPILOT_METADATA_PARSER_VERSION,
                },
                enrichment: CopilotDbEnrichment::default(),
            });
            if records.len() > MAX_DISCOVERED_SESSIONS {
                return Err(format!(
                    "Copilot discovery exceeds the {MAX_DISCOVERED_SESSIONS}-session safety limit"
                ));
            }
        }
    }
    let next = walker.into_snapshots();
    scan_snapshot::persist_dir_snapshots_if_changed(conn, SOURCE_COPILOT, &previous, &next)?;
    records.sort_by(|left, right| {
        left.record
            .source_session_id
            .cmp(&right.record.source_session_id)
    });
    Ok(records)
}

/// Copilot session ids are plain hex uuids (`8-4-4-4-12`); the
/// junk dirs ("optimistic-chat-<uuid>", "pending-session:draft:<uuid>") never
/// match this shape.
pub(super) fn is_plain_session_dir_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}
