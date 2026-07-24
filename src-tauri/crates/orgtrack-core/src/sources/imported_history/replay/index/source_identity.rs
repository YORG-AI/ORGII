use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReplayDriverKind {
    CodexJsonl,
    SharedJsonl,
    Sqlite,
    StructuredSqlite,
    WholeJson,
}

/// Exhaustive storage-driver routing for every built-in source. Adding a new
/// [`ImportedHistorySourceId`] without choosing a replay driver is a compile
/// error; synchronization and range reads cannot drift onto different paths.
pub(super) const fn replay_driver_kind(source: ImportedHistorySourceId) -> ReplayDriverKind {
    match source {
        ImportedHistorySourceId::CodexApp => ReplayDriverKind::CodexJsonl,
        ImportedHistorySourceId::ClaudeCode
        | ImportedHistorySourceId::WorkBuddy
        | ImportedHistorySourceId::Trae
        | ImportedHistorySourceId::Qoder
        | ImportedHistorySourceId::Omp
        | ImportedHistorySourceId::QoderCli => ReplayDriverKind::SharedJsonl,
        ImportedHistorySourceId::OpenCode
        | ImportedHistorySourceId::MimoCode
        | ImportedHistorySourceId::ZCode
        | ImportedHistorySourceId::CursorIde
        | ImportedHistorySourceId::Windsurf => ReplayDriverKind::Sqlite,
        ImportedHistorySourceId::CursorCli | ImportedHistorySourceId::Warp => {
            ReplayDriverKind::StructuredSqlite
        }
        ImportedHistorySourceId::Cline => ReplayDriverKind::WholeJson,
    }
}

pub(super) fn is_shared_jsonl(source: ImportedHistorySourceId) -> bool {
    replay_driver_kind(source) == ReplayDriverKind::SharedJsonl
}

pub(super) fn is_sqlite_replay(source: ImportedHistorySourceId) -> bool {
    replay_driver_kind(source) == ReplayDriverKind::Sqlite
}

pub(super) fn is_structured_sqlite(source: ImportedHistorySourceId) -> bool {
    replay_driver_kind(source) == ReplayDriverKind::StructuredSqlite
}

pub(super) fn is_physical_sqlite(source: ImportedHistorySourceId) -> bool {
    is_sqlite_replay(source) || is_structured_sqlite(source)
}

pub(in crate::sources::imported_history::replay) fn resolve_source(
    conn: &Connection,
    source: ImportedHistorySourceId,
    session_id: &str,
) -> Result<ResolvedSource, String> {
    let requested_key = source.source_session_id(session_id)?;
    conn.query_row(
        "SELECT source_session_id, source_path
         FROM imported_history_session_cache
         WHERE source=?1
           AND (source_session_id=?2 OR source_session_id LIKE '%-' || ?2)
         ORDER BY CASE WHEN source_session_id=?2 THEN 0 ELSE 1 END,
                  updated_at_ms DESC
         LIMIT 1",
        params![source.as_str(), requested_key],
        |row| {
            Ok(ResolvedSource {
                source_session_id: row.get(0)?,
                path: PathBuf::from(row.get::<_, String>(1)?),
            })
        },
    )
    .optional()
    .map_err(|err| format!("resolve replay source path: {err}"))?
    .ok_or_else(|| {
        format!(
            "Imported replay source is not indexed yet: {} {session_id}",
            source.as_str()
        )
    })
}

pub(in crate::sources::imported_history::replay) fn load_state(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
) -> Result<Option<ReplayIndexState>, String> {
    conn.query_row(
        "SELECT source_session_id, generation, revision, parser_version,
                source_identity, driver_cursor_json, indexed_size_bytes,
                indexed_mtime_ns, total_events, total_turns, updated_at
         FROM imported_replay_state
         WHERE source=?1 AND source_session_id=?2 AND valid=1",
        params![source.as_str(), source_session_id],
        |row| {
            Ok(ReplayIndexState {
                generation: row.get(1)?,
                revision: row.get::<_, i64>(2)?.max(0) as u64,
                parser_version: row.get::<_, i64>(3)?.max(0) as u32,
                source_identity: row.get(4)?,
                driver_cursor_json: row.get(5)?,
                indexed_size_bytes: row.get::<_, i64>(6)?.max(0) as u64,
                indexed_mtime_ns: row.get(7)?,
                total_events: row.get::<_, i64>(8)?.max(0) as u64,
                total_turns: row.get::<_, i64>(9)?.max(0) as u64,
                state_updated_at_ms: row
                    .get::<_, String>(10)?
                    .parse::<chrono::DateTime<Utc>>()
                    .map(|timestamp| timestamp.timestamp_millis())
                    .unwrap_or_default(),
            })
        },
    )
    .optional()
    .map_err(|err| format!("load imported replay state: {err}"))
}

pub(super) fn source_snapshot(
    path: &Path,
    source: ImportedHistorySourceId,
) -> Result<SourcePhysicalSnapshot, String> {
    let metadata = fs::metadata(path)
        .map_err(|err| format!("stat replay source {}: {err}", path.display()))?;
    let mut size_bytes = metadata.len();
    let mut mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64 * 1_000_000_000 + duration.subsec_nanos() as i64)
        .unwrap_or_default();
    if is_physical_sqlite(source) {
        // WAL contains committed logical changes. SHM is a transient lock and
        // reader coordination file; including it makes our own SQLite reads
        // look like source mutations and self-trigger replay scans.
        let wal = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
        if let Ok(wal_metadata) = fs::metadata(wal) {
            size_bytes = size_bytes.saturating_add(wal_metadata.len());
            let wal_mtime = wal_metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| {
                    duration.as_secs() as i64 * 1_000_000_000 + duration.subsec_nanos() as i64
                })
                .unwrap_or_default();
            mtime_ns = mtime_ns.max(wal_mtime);
        }
    }
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}",
            canonical.display(),
            metadata.dev(),
            metadata.ino()
        )
    };
    #[cfg(not(unix))]
    let identity = canonical.to_string_lossy().to_string();
    Ok(SourcePhysicalSnapshot {
        identity,
        size_bytes,
        mtime_ns,
        sample_fingerprint: String::new(),
    })
}

pub(super) fn sqlite_physical_fingerprint(path: &Path) -> Result<String, String> {
    let mut hash = Fnv64::default();
    for candidate in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.to_string_lossy())),
    ] {
        hash.update(candidate.to_string_lossy().as_bytes());
        match fs::metadata(&candidate) {
            Ok(metadata) => {
                hash.update(&metadata.len().to_le_bytes());
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| {
                        duration.as_secs() as i64 * 1_000_000_000 + duration.subsec_nanos() as i64
                    })
                    .unwrap_or_default();
                hash.update(&modified.to_le_bytes());
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => hash.update(b"missing"),
            Err(err) => {
                return Err(format!(
                    "stat replay SQLite sidecar {}: {err}",
                    candidate.display()
                ))
            }
        }
    }
    Ok(hash.finish_hex())
}

pub(super) fn sampled_file_fingerprint(path: &Path, size: u64) -> Result<String, String> {
    #[cfg(test)]
    FILE_SAMPLE_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    const SAMPLE: usize = 4096;
    let mut file = fs::File::open(path)
        .map_err(|err| format!("open replay source sample {}: {err}", path.display()))?;
    let mut hash = Fnv64::default();
    hash.update(&size.to_le_bytes());
    for offset in [
        0,
        size.saturating_sub(SAMPLE as u64) / 2,
        size.saturating_sub(SAMPLE as u64),
    ] {
        file.seek(SeekFrom::Start(offset))
            .map_err(|err| format!("seek replay source sample: {err}"))?;
        let mut buffer = vec![0_u8; SAMPLE.min(size.saturating_sub(offset) as usize)];
        file.read_exact(&mut buffer)
            .map_err(|err| format!("read replay source sample: {err}"))?;
        hash.update(&offset.to_le_bytes());
        hash.update(&buffer);
    }
    Ok(hash.finish_hex())
}

#[cfg(test)]
std::thread_local! {
    static FILE_SAMPLE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(in crate::sources::imported_history::replay) fn take_file_sample_count() -> usize {
    FILE_SAMPLE_COUNT.with(|count| count.replace(0))
}

pub(super) fn make_generation(
    source: ImportedHistorySourceId,
    source_session_id: &str,
    parser_version: u32,
    snapshot: &SourcePhysicalSnapshot,
) -> String {
    let mut hash = Fnv64::default();
    hash.update(source.as_str().as_bytes());
    hash.update(source_session_id.as_bytes());
    hash.update(&parser_version.to_le_bytes());
    hash.update(snapshot.identity.as_bytes());
    hash.update(&snapshot.size_bytes.to_le_bytes());
    hash.update(&snapshot.mtime_ns.to_le_bytes());
    hash.update(snapshot.sample_fingerprint.as_bytes());
    format!("r{parser_version}-{}", hash.finish_hex())
}

#[derive(Default)]
pub(super) struct Fnv64(u64);

impl Fnv64 {
    fn update(&mut self, bytes: &[u8]) {
        if self.0 == 0 {
            self.0 = 0xcbf29ce484222325;
        }
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    fn finish_hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}
