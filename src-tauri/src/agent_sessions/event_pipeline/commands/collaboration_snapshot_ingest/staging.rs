use super::*;

#[derive(Debug, Clone)]
pub(super) struct StagingManifest {
    pub(super) token: String,
    pub(super) local_session_id: String,
    pub(super) epoch: i64,
    pub(super) expected_count: u64,
    pub(super) expected_frozen_seq: u64,
    pub(super) expected_tail_hash: Option<String>,
    pub(super) replace: bool,
    pub(super) previous: Option<CollaborationSnapshotCursor>,
    pub(super) page_count: u64,
    pub(super) next_cursor_json: Option<String>,
    pub(super) page_chain_complete: bool,
}

pub(super) fn validate_session_id(session_id: &str) -> Result<(), String> {
    let valid_prefix = [IMPORTED_SESSION_PREFIX, AGENT_SESSION_PREFIX]
        .into_iter()
        .find(|prefix| session_id.starts_with(prefix) && session_id.len() > prefix.len());
    if valid_prefix.is_some() && !session_id.contains(['/', '\\']) {
        return Ok(());
    }
    Err(format!(
        "collaboration snapshot target must start with {IMPORTED_SESSION_PREFIX} or {AGENT_SESSION_PREFIX}"
    ))
}

pub(super) fn is_imported_snapshot_session(session_id: &str) -> bool {
    session_id.starts_with(IMPORTED_SESSION_PREFIX)
}

pub(super) fn validate_hash(label: &str, hash: &str) -> Result<(), String> {
    if hash.len() == HASH_HEX_BYTES && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("{label} must be a 64-character SHA-256 hex digest"))
    }
}

pub(super) fn namespace_copy_id(local_session_id: &str, original_id: &str) -> String {
    let prefix = format!("{local_session_id}{COPY_ID_DELIMITER}");
    if original_id.starts_with(&prefix) {
        original_id.to_string()
    } else {
        format!("{prefix}{original_id}")
    }
}

pub(super) fn normalize_event(
    mut event: SessionEvent,
    local_session_id: &str,
) -> Result<SessionEvent, String> {
    if event.id.is_empty() {
        return Err("collaboration snapshot event id cannot be empty".to_string());
    }
    event.id = namespace_copy_id(local_session_id, &event.id);
    event.chunk_id = event
        .chunk_id
        .take()
        .map(|id| namespace_copy_id(local_session_id, &id));
    event.session_id = local_session_id.to_string();
    Ok(event)
}

pub(super) fn staging_root() -> Result<PathBuf, String> {
    let db = app_paths::sessions_db();
    let parent = db
        .parent()
        .ok_or_else(|| "sessions.db has no parent directory".to_string())?;
    Ok(parent.join(STAGING_DIR_NAME))
}

pub(super) fn validate_token(token: &str) -> Result<Uuid, String> {
    let parsed = Uuid::parse_str(token).map_err(|_| "invalid snapshot ingest token".to_string())?;
    if parsed.to_string() != token {
        return Err("snapshot ingest token is not canonical".to_string());
    }
    Ok(parsed)
}

pub(super) fn staging_path(root: &Path, token: &str) -> Result<PathBuf, String> {
    validate_token(token)?;
    Ok(root.join(format!("{token}.sqlite")))
}

pub(super) fn remove_staging_files(path: &Path) {
    let _ = fs::remove_file(path);
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let _ = fs::remove_file(PathBuf::from(wal));
    let mut shm = path.as_os_str().to_os_string();
    shm.push("-shm");
    let _ = fs::remove_file(PathBuf::from(shm));
}

pub(super) fn remove_token_temp_files(root: &Path, token: &str) {
    let prefix = format!("{token}-");
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".tmp"))
        {
            let _ = fs::remove_file(path);
        }
    }
}

pub(super) fn cleanup_stale_staging(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("create snapshot staging dir: {error}"))?;
    let now = SystemTime::now();
    let entries =
        fs::read_dir(root).map_err(|error| format!("read snapshot staging dir: {error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_sqlite = path.extension().and_then(|value| value.to_str()) == Some("sqlite");
        let is_temp = path.extension().and_then(|value| value.to_str()) == Some("tmp");
        let modified = entry.metadata().and_then(|meta| meta.modified());
        let is_stale = modified
            .ok()
            .and_then(|value| now.duration_since(value).ok())
            .is_some_and(|age| age >= STAGING_STALE_AFTER);
        if is_temp && is_stale {
            let _ = fs::remove_file(path);
        } else if is_sqlite && is_stale {
            if let Some(token) = path.file_stem().and_then(|value| value.to_str()) {
                remove_token_temp_files(root, token);
            }
            remove_staging_files(&path);
        }
    }
    Ok(())
}

pub(super) fn configure_staging_connection(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=FULL;
         PRAGMA temp_store=FILE;
         CREATE TABLE IF NOT EXISTS manifest (
           singleton INTEGER PRIMARY KEY CHECK(singleton=1),
           version INTEGER NOT NULL,
           token TEXT NOT NULL,
           local_session_id TEXT NOT NULL,
           epoch INTEGER NOT NULL,
           expected_count INTEGER NOT NULL,
           expected_frozen_seq INTEGER NOT NULL,
           expected_tail_hash TEXT,
           replace_snapshot INTEGER NOT NULL,
           previous_json TEXT,
           page_count INTEGER NOT NULL DEFAULT 0,
           next_cursor_json TEXT,
           page_chain_complete INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS staged_wires (
           seq INTEGER PRIMARY KEY,
           segment_hash TEXT NOT NULL,
           event_count INTEGER NOT NULL,
           is_tail INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS staged_events (
           normalized_id TEXT PRIMARY KEY,
           original_id TEXT NOT NULL,
           physical_seq INTEGER NOT NULL,
           event_index INTEGER NOT NULL,
           is_tail INTEGER NOT NULL,
           event_type TEXT NOT NULL,
           function_name TEXT,
           thread_id TEXT,
           args_json TEXT NOT NULL,
           result_json TEXT NOT NULL,
           content TEXT NOT NULL,
           created_at TEXT NOT NULL,
           meta_json TEXT
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_staged_events_order
           ON staged_events(is_tail, physical_seq, event_index);
         CREATE TABLE IF NOT EXISTS attachment_parts (
           attachment_id TEXT NOT NULL,
           part_index INTEGER NOT NULL,
           physical_seq INTEGER NOT NULL UNIQUE,
           chunk_offset INTEGER NOT NULL,
           chunk BLOB NOT NULL,
           final_part INTEGER NOT NULL,
           event_bytes INTEGER,
           attachment_hash TEXT,
           PRIMARY KEY(attachment_id,part_index)
         );",
    )
    .map_err(|error| format!("initialize snapshot staging database: {error}"))?;
    Ok(())
}

pub(super) fn open_staging(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err("snapshot ingest token is missing or expired".to_string());
    }
    let conn =
        Connection::open(path).map_err(|error| format!("open snapshot staging db: {error}"))?;
    configure_staging_connection(&conn)?;
    Ok(conn)
}

pub(super) fn load_manifest(conn: &Connection) -> Result<StagingManifest, String> {
    conn.query_row(
        "SELECT token,local_session_id,epoch,expected_count,expected_frozen_seq,
                expected_tail_hash,replace_snapshot,previous_json,page_count,
                next_cursor_json,page_chain_complete
         FROM manifest WHERE singleton=1 AND version=?1",
        [STAGING_VERSION],
        |row| {
            let previous_json: Option<String> = row.get(7)?;
            let previous = previous_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        7,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            Ok(StagingManifest {
                token: row.get(0)?,
                local_session_id: row.get(1)?,
                epoch: row.get(2)?,
                expected_count: row.get::<_, i64>(3)?.max(0) as u64,
                expected_frozen_seq: row.get::<_, i64>(4)?.max(0) as u64,
                expected_tail_hash: row.get(5)?,
                replace: row.get::<_, i64>(6)? != 0,
                previous,
                page_count: row.get::<_, i64>(8)?.max(0) as u64,
                next_cursor_json: row.get(9)?,
                page_chain_complete: row.get::<_, i64>(10)? != 0,
            })
        },
    )
    .map_err(|error| format!("read snapshot staging manifest: {error}"))
}

pub(super) fn begin_at_root(
    root: &Path,
    request: CollaborationSnapshotIngestBeginRequest,
) -> Result<CollaborationSnapshotIngestBeginResult, String> {
    validate_session_id(&request.local_session_id)?;
    if request.epoch < 0 {
        return Err("snapshot epoch must be non-negative".to_string());
    }
    if let Some(hash) = request.tail_hash.as_deref() {
        validate_hash("tailHash", hash)?;
    }
    if !request.replace && request.previous.is_none() {
        return Err("incremental snapshot ingest requires a previous cursor".to_string());
    }
    if request.local_session_id.starts_with(AGENT_SESSION_PREFIX)
        && (!request.replace || request.previous.is_some())
    {
        return Err(
            "native fork snapshot ingest must be an unconditional full replacement".to_string(),
        );
    }
    if let Some(previous) = request.previous.as_ref() {
        if previous.epoch < 0 {
            return Err("previous snapshot epoch must be non-negative".to_string());
        }
        if let Some(hash) = previous.tail_hash.as_deref() {
            validate_hash("previous.tailHash", hash)?;
        }
        if !request.replace && previous.epoch != request.epoch {
            return Err("incremental snapshot ingest cannot change epoch".to_string());
        }
        if !request.replace && previous.frozen_seq > request.expected_frozen_seq {
            return Err("incremental snapshot frozen sequence moved backwards".to_string());
        }
    }

    cleanup_stale_staging(root)?;
    let token = Uuid::new_v4().to_string();
    let path = staging_path(root, &token)?;
    let conn =
        Connection::open(&path).map_err(|error| format!("create snapshot staging db: {error}"))?;
    configure_staging_connection(&conn)?;
    let previous_json = request
        .previous
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("serialize previous snapshot cursor: {error}"))?;
    conn.execute(
        "INSERT INTO manifest(
           singleton,version,token,local_session_id,epoch,expected_count,
           expected_frozen_seq,expected_tail_hash,replace_snapshot,previous_json
         ) VALUES(1,?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            STAGING_VERSION,
            token,
            request.local_session_id,
            request.epoch,
            i64::try_from(request.expected_count).map_err(|_| "expectedCount is too large")?,
            i64::try_from(request.expected_frozen_seq)
                .map_err(|_| "expectedFrozenSeq is too large")?,
            request.tail_hash,
            request.replace,
            previous_json,
        ],
    )
    .map_err(|error| format!("write snapshot staging manifest: {error}"))?;
    Ok(CollaborationSnapshotIngestBeginResult { token })
}

pub(super) async fn collaboration_snapshot_ingest_begin_impl(
    request: CollaborationSnapshotIngestBeginRequest,
) -> Result<CollaborationSnapshotIngestBeginResult, String> {
    let root = staging_root()?;
    tokio::task::spawn_blocking(move || begin_at_root(&root, request))
        .await
        .map_err(|error| error.to_string())?
}

pub(super) fn abort_at_root(root: &Path, token: &str) -> Result<(), String> {
    let path = staging_path(root, token)?;
    remove_staging_files(&path);
    remove_token_temp_files(root, token);
    Ok(())
}

pub(super) async fn collaboration_snapshot_ingest_abort_impl(
    request: CollaborationSnapshotIngestTokenRequest,
) -> Result<(), String> {
    let root = staging_root()?;
    tokio::task::spawn_blocking(move || abort_at_root(&root, &request.token))
        .await
        .map_err(|error| error.to_string())?
}
