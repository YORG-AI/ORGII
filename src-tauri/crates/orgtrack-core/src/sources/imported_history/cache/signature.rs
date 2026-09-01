use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

use super::super::metadata::ImportedHistoryRecordSignature;

pub fn cached_record_signatures_from_conn(
    conn: &Connection,
    source: &str,
) -> Result<HashMap<String, ImportedHistoryRecordSignature>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT source_session_id, source_path, source_mtime_ms, source_size_bytes, \
                    source_fingerprint, parser_version \
             FROM imported_history_session_cache \
             WHERE source = ?1",
        )
        .map_err(|err| format!("Failed to prepare imported history signature query: {err}"))?;
    let rows = stmt
        .query_map([source], |row| {
            Ok(ImportedHistoryRecordSignature {
                source_session_id: row.get(0)?,
                source_path: row.get(1)?,
                source_mtime_ms: row.get(2)?,
                source_size_bytes: row.get(3)?,
                source_fingerprint: row.get(4)?,
                parser_version: row.get(5)?,
            })
        })
        .map_err(|err| format!("Failed to query imported history signatures: {err}"))?;

    let mut signatures = HashMap::new();
    for row in rows {
        let signature =
            row.map_err(|err| format!("Failed to read imported history signature: {err}"))?;
        signatures.insert(signature.source_session_id.clone(), signature);
    }
    Ok(signatures)
}

pub fn record_matches_cached_signature(
    cached: &ImportedHistoryRecordSignature,
    discovered: &ImportedHistoryRecordSignature,
) -> bool {
    cached.source_path == discovered.source_path
        && cached.source_mtime_ms == discovered.source_mtime_ms
        && cached.source_size_bytes == discovered.source_size_bytes
        && cached.source_fingerprint == discovered.source_fingerprint
        && cached.parser_version == discovered.parser_version
}

pub fn changed_records_from_conn<'a, T, F>(
    conn: &Connection,
    source: &str,
    discovered: &'a [T],
    signature_for: F,
) -> Result<Vec<&'a T>, String>
where
    F: Fn(&T) -> ImportedHistoryRecordSignature,
{
    let cached = cached_record_signatures_from_conn(conn, source)?;
    Ok(discovered
        .iter()
        .filter(|record| {
            let signature = signature_for(record);
            cached
                .get(&signature.source_session_id)
                .is_none_or(|cached_signature| {
                    !record_matches_cached_signature(cached_signature, &signature)
                })
        })
        .collect())
}

pub fn live_ids_from_signatures(signatures: &[ImportedHistoryRecordSignature]) -> Vec<String> {
    let mut seen = HashSet::new();
    signatures
        .iter()
        .filter_map(|signature| {
            if seen.insert(signature.source_session_id.clone()) {
                Some(signature.source_session_id.clone())
            } else {
                None
            }
        })
        .collect()
}
