//! Per-directory scan snapshots for incremental source discovery.
//!
//! A directory's mtime changes on entry create/delete/rename but NOT on
//! in-place writes to a contained file, and never bubbles up from
//! subdirectories. A snapshot therefore caches only the directory's NAME
//! sets (files and subdirectories) so an unchanged directory skips
//! re-enumeration; every listed file is still stat'ed by discovery, keeping
//! a live-appended transcript's record signature fresh. Reuse additionally
//! requires `dir_mtime_ns < scanned_at_ns` so a directory modified in the
//! same instant the snapshot was taken (coarse-mtime race) re-enumerates.
//! Any unreadable, foreign-version, or garbage row degrades to a full
//! re-enumeration and is healed by the next write.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub const SCAN_SNAPSHOT_VERSION: i64 = 1;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirScanSnapshot {
    pub dir_mtime_ns: i64,
    pub scanned_at_ns: i64,
    pub subdirs: Vec<String>,
    pub files: Vec<String>,
}

pub fn read_dir_snapshots_from_conn(
    conn: &Connection,
    source: &str,
) -> HashMap<String, DirScanSnapshot> {
    let mut snapshots = HashMap::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT directory_path, entries_json FROM imported_history_scan_snapshots
         WHERE source = ?1 AND snapshot_version = ?2",
    ) else {
        return snapshots;
    };
    let Ok(rows) = stmt.query_map(params![source, SCAN_SNAPSHOT_VERSION], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return snapshots;
    };
    for row in rows {
        let Ok((directory_path, entries_json)) = row else {
            continue;
        };
        let Ok(snapshot) = serde_json::from_str::<DirScanSnapshot>(&entries_json) else {
            continue;
        };
        snapshots.insert(directory_path, snapshot);
    }
    snapshots
}

pub fn write_dir_snapshots_from_conn(
    conn: &Connection,
    source: &str,
    snapshots: &HashMap<String, DirScanSnapshot>,
) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("Failed to start scan snapshot transaction: {err}"))?;
    tx.execute(
        "DELETE FROM imported_history_scan_snapshots WHERE source = ?1",
        [source],
    )
    .map_err(|err| format!("Failed to clear scan snapshots: {err}"))?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO imported_history_scan_snapshots (
                    source, directory_path, dir_mtime_ns, file_count,
                    snapshot_version, entries_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|err| format!("Failed to prepare scan snapshot insert: {err}"))?;
        for (directory_path, snapshot) in snapshots {
            let entries_json = serde_json::to_string(snapshot)
                .map_err(|err| format!("Failed to encode scan snapshot: {err}"))?;
            stmt.execute(params![
                source,
                directory_path,
                snapshot.dir_mtime_ns,
                snapshot.files.len() as i64,
                SCAN_SNAPSHOT_VERSION,
                entries_json,
            ])
            .map_err(|err| format!("Failed to write scan snapshot: {err}"))?;
        }
    }
    tx.commit()
        .map_err(|err| format!("Failed to commit scan snapshots: {err}"))
}

pub fn persist_dir_snapshots_if_changed(
    conn: &Connection,
    source: &str,
    previous: &HashMap<String, DirScanSnapshot>,
    next: &HashMap<String, DirScanSnapshot>,
) -> Result<(), String> {
    if previous == next {
        return Ok(());
    }
    write_dir_snapshots_from_conn(conn, source, next)
}

pub struct SnapshotDirWalker<'a> {
    previous: &'a HashMap<String, DirScanSnapshot>,
    next: HashMap<String, DirScanSnapshot>,
    extension: &'static str,
    error_label: &'static str,
    now_ns: i64,
    pub dirs_enumerated: usize,
    pub dirs_reused: usize,
}

impl<'a> SnapshotDirWalker<'a> {
    pub fn new(
        previous: &'a HashMap<String, DirScanSnapshot>,
        extension: &'static str,
        error_label: &'static str,
    ) -> Self {
        Self {
            previous,
            next: HashMap::new(),
            extension,
            error_label,
            now_ns: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos() as i64)
                .unwrap_or(0),
            dirs_enumerated: 0,
            dirs_reused: 0,
        }
    }

    pub fn collect_files(&mut self, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
        let key = dir.to_string_lossy().to_string();
        let dir_mtime_ns = fs::metadata(dir)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_nanos() as i64)
            .unwrap_or(0);
        if dir_mtime_ns > 0 {
            if let Some(snapshot) = self.previous.get(&key) {
                if snapshot.dir_mtime_ns == dir_mtime_ns
                    && snapshot.dir_mtime_ns < snapshot.scanned_at_ns
                {
                    self.dirs_reused += 1;
                    for name in &snapshot.files {
                        out.push(dir.join(name));
                    }
                    let subdirs = snapshot.subdirs.clone();
                    self.next.insert(key, snapshot.clone());
                    for name in &subdirs {
                        self.collect_files(&dir.join(name), out)?;
                    }
                    return Ok(());
                }
            }
        }
        self.dirs_enumerated += 1;
        let mut snapshot = DirScanSnapshot {
            dir_mtime_ns,
            scanned_at_ns: self.now_ns,
            subdirs: Vec::new(),
            files: Vec::new(),
        };
        for entry in fs::read_dir(dir)
            .map_err(|err| format!("Failed to read {} dir: {err}", self.error_label))?
        {
            let entry = entry
                .map_err(|err| format!("Failed to read {} dir entry: {err}", self.error_label))?;
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            let file_type = entry.file_type().map_err(|err| {
                format!("Failed to read {} dir entry type: {err}", self.error_label)
            })?;
            let is_dir = if file_type.is_symlink() {
                entry.path().is_dir()
            } else {
                file_type.is_dir()
            };
            if is_dir {
                snapshot.subdirs.push(name.to_string());
            } else if Path::new(name)
                .extension()
                .is_some_and(|extension| extension == self.extension)
            {
                snapshot.files.push(name.to_string());
            }
        }
        snapshot.subdirs.sort();
        snapshot.files.sort();
        for name in &snapshot.files {
            out.push(dir.join(name));
        }
        let subdirs = snapshot.subdirs.clone();
        self.next.insert(key, snapshot);
        for name in &subdirs {
            self.collect_files(&dir.join(name), out)?;
        }
        Ok(())
    }

    pub fn into_snapshots(self) -> HashMap<String, DirScanSnapshot> {
        self.next
    }
}

#[cfg(test)]
#[path = "scan_snapshot_tests.rs"]
mod tests;
