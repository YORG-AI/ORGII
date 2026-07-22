//! Per-session `store.db` access: opening the read-only connection, resolving
//! and stat-ing the store path (WAL sidecar folded in), and reading the `meta`
//! header, content-addressed blobs, and root manifest.

use super::*;

pub(super) fn open_store_readonly(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|err| format!("Failed to open Cursor CLI store {}: {err}", path.display()))
}

pub(super) fn resolve_store_path(
    conn: &Connection,
    source_session_id: &str,
) -> Result<PathBuf, String> {
    if let Some(path) = imported_cache::get_cached_source_path_from_conn(
        conn,
        SOURCE_CURSOR_CLI,
        source_session_id,
    )? {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    discover_cursor_cli_history_records()?
        .into_iter()
        .find(|record| record.source_session_id == source_session_id)
        .map(|record| record.source_path)
        .ok_or_else(|| format!("Cursor CLI store not found for session: {source_session_id}"))
}

pub(super) fn stat_store(path: &Path) -> Option<(i64, u64)> {
    let main = fs::metadata(path).ok()?;
    let mut mtime_ms = metadata_mtime_epoch_ms(&main);
    let mut size_bytes = main.len();
    let mut wal_path = path.as_os_str().to_owned();
    wal_path.push("-wal");
    if let Ok(wal) = fs::metadata(&wal_path) {
        mtime_ms = mtime_ms.max(metadata_mtime_epoch_ms(&wal));
        size_bytes += wal.len();
    }
    Some((mtime_ms, size_bytes))
}

pub(super) fn store_updated_at_ms(path: &Path) -> i64 {
    stat_store(path).map(|(mtime_ms, _)| mtime_ms).unwrap_or(0)
}

fn metadata_mtime_epoch_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) fn read_store_meta(conn: &Connection) -> Result<Option<CursorStoreMeta>, String> {
    let raw: Option<rusqlite::types::Value> = conn
        .query_row("SELECT value FROM meta WHERE key = '0'", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|err| format!("Failed to read Cursor CLI store meta: {err}"))?;
    let bytes = match raw {
        Some(rusqlite::types::Value::Text(text)) => text.into_bytes(),
        Some(rusqlite::types::Value::Blob(blob)) => blob,
        _ => return Ok(None),
    };
    let Some(json_bytes) = decode_meta_bytes(&bytes) else {
        return Ok(None);
    };
    Ok(serde_json::from_slice::<CursorStoreMeta>(&json_bytes).ok())
}

/// The meta value is hex-encoded JSON in every observed store; accept raw
/// JSON too in case a future build drops the hex layer.
pub(super) fn decode_meta_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.first() == Some(&b'{') {
        return Some(bytes.to_vec());
    }
    hex_decode(std::str::from_utf8(bytes).ok()?)
}

pub(super) fn read_blob(conn: &Connection, blob_id: &str) -> Result<Option<Vec<u8>>, String> {
    conn.query_row("SELECT data FROM blobs WHERE id = ?1", [blob_id], |row| {
        row.get::<_, Vec<u8>>(0)
    })
    .optional()
    .map_err(|err| format!("Failed to read Cursor CLI blob {blob_id}: {err}"))
}

pub(super) fn read_catalog_blob(
    conn: &Connection,
    blob_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    conn.query_row(
        "SELECT CASE WHEN length(data) <= ?2 THEN data ELSE NULL END
         FROM blobs WHERE id = ?1",
        rusqlite::params![blob_id, CURSOR_CLI_CATALOG_BLOB_BYTES],
        |row| row.get::<_, Option<Vec<u8>>>(0),
    )
    .optional()
    .map(|value| value.flatten())
    .map_err(|err| format!("Failed to read compact Cursor CLI blob {blob_id}: {err}"))
}

pub(super) fn read_store_manifest(
    conn: &Connection,
    root_blob_id: &str,
) -> Result<Option<CursorStoreManifest>, String> {
    if root_blob_id.trim().is_empty() {
        return Ok(None);
    }
    let Some(data) = read_blob(conn, root_blob_id)? else {
        return Ok(None);
    };
    let Some(fields) = wire_fields(&data) else {
        return Ok(None);
    };
    let mut manifest = CursorStoreManifest::default();
    for (field, value) in fields {
        match (field, value) {
            // Ordered message hashes: 32 raw SHA-256 bytes each.
            (1, WireValue::Bytes(hash)) if hash.len() == 32 => {
                manifest.message_blob_ids.push(hex_encode(hash));
            }
            // Token usage: {1: context tokens used, 2: context window}.
            (5, WireValue::Bytes(usage)) => {
                if let Some(usage_fields) = wire_fields(usage) {
                    for (usage_field, usage_value) in usage_fields {
                        if usage_field == 1 {
                            if let WireValue::Varint(tokens) = usage_value {
                                manifest.context_tokens = tokens as i64;
                            }
                        }
                    }
                }
            }
            // Workspace root as a file:// URI.
            (9, WireValue::Bytes(uri)) => {
                if let Ok(uri) = std::str::from_utf8(uri) {
                    manifest.workspace_path = file_uri_to_path(uri);
                }
            }
            _ => {}
        }
    }
    Ok(Some(manifest))
}
