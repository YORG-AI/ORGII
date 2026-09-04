//! Demand-driven discovery of Kimi wire transcripts under both layouts.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::sources::imported_history::{
    metadata::{ImportedHistoryDiscoveredRecord, SOURCE_KIMI},
    paths as imported_paths, scan_snapshot,
};

use super::config::{read_legacy_config, LegacyConfig};
use super::identity::{KimiLayout, KIMI_METADATA_PARSER_VERSION, MAX_WIRE_FILE_BYTES};
use super::paths::{
    ensure_exact_safe_history_file, ensure_safe_history_root, kimi_code_home_for,
    source_id_for_relative,
};

#[derive(Debug)]
pub(super) struct KimiDiscovery {
    pub(super) records: Vec<ImportedHistoryDiscoveredRecord>,
    pub(super) legacy_config: LegacyConfig,
}

pub(super) fn discover_kimi_records_in(
    conn: &Connection,
    home: &Path,
    kimi_code_home: Option<&std::ffi::OsStr>,
) -> Result<KimiDiscovery, String> {
    let legacy_root = home.join(".kimi").join("sessions");
    let code_root = kimi_code_home_for(home, kimi_code_home).join("sessions");
    let legacy_config = read_legacy_config(home);
    let previous = scan_snapshot::read_dir_snapshots_from_conn(conn, SOURCE_KIMI);
    let mut walker = scan_snapshot::SnapshotDirWalker::new(&previous, "jsonl", "Kimi");
    let mut records = Vec::new();
    let mut seen_physical_paths = HashSet::new();

    collect_layout_records(
        &mut walker,
        &legacy_root,
        home,
        2,
        KimiLayout::Legacy,
        &legacy_config.fingerprint,
        &mut seen_physical_paths,
        &mut records,
    )?;
    collect_layout_records(
        &mut walker,
        &code_root,
        home,
        4,
        KimiLayout::Code,
        "kimi-code-wire-v2",
        &mut seen_physical_paths,
        &mut records,
    )?;

    let next = walker.into_snapshots();
    scan_snapshot::persist_dir_snapshots_if_changed(conn, SOURCE_KIMI, &previous, &next)?;
    records.sort_by(|left, right| left.source_session_id.cmp(&right.source_session_id));
    Ok(KimiDiscovery {
        records,
        legacy_config,
    })
}

#[allow(clippy::too_many_arguments)]
// Scanner roots and output accumulators have distinct lifetimes and ownership;
// spelling them out keeps filesystem boundaries visible during traversal.
fn collect_layout_records(
    walker: &mut scan_snapshot::SnapshotDirWalker<'_>,
    root: &Path,
    identity_home: &Path,
    max_depth: usize,
    layout: KimiLayout,
    fingerprint: &str,
    seen_physical_paths: &mut HashSet<PathBuf>,
    records: &mut Vec<ImportedHistoryDiscoveredRecord>,
) -> Result<(), String> {
    match fs::symlink_metadata(root) {
        Ok(_) => ensure_safe_history_root(root, identity_home)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect Kimi history root {}: {error}",
                root.display()
            ))
        }
    }
    let mut files = Vec::new();
    walker.collect_files_bounded(root, &mut files, max_depth)?;
    for path in files {
        let Some(relative) = path.strip_prefix(root).ok() else {
            continue;
        };
        let Some(source_session_id) = source_id_for_relative(layout, relative) else {
            continue;
        };
        ensure_exact_safe_history_file(&path, root, identity_home, layout)?;
        let physical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !seen_physical_paths.insert(physical) {
            continue;
        }
        let (mtime, size) = imported_paths::file_metadata_signature(&path, "Kimi")?;
        if size > MAX_WIRE_FILE_BYTES {
            return Err(format!(
                "Kimi history {} exceeds the {}-byte safety limit",
                path.display(),
                MAX_WIRE_FILE_BYTES
            ));
        }
        records.push(ImportedHistoryDiscoveredRecord {
            source_record_key: source_session_id.clone(),
            source_session_id,
            source_path: path,
            source_mtime_ms: mtime,
            source_size_bytes: size,
            source_fingerprint: fingerprint.to_string(),
            parser_version: KIMI_METADATA_PARSER_VERSION,
        });
    }
    Ok(())
}
