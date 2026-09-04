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

/// Return signature changes plus the narrow set of historical rows whose
/// cached name is a generated prompt envelope. This repairs old pollution
/// without a parser-version bump that would eagerly reparse every transcript.
pub fn changed_records_with_generated_name_repairs_from_conn<'a, T, F>(
    conn: &Connection,
    source: &str,
    discovered: &'a [T],
    signature_for: F,
) -> Result<Vec<&'a T>, String>
where
    F: Fn(&T) -> ImportedHistoryRecordSignature,
{
    let mut changed = changed_records_from_conn(conn, source, discovered, &signature_for)?;
    let repair_ids = generated_name_repair_source_session_ids_from_conn(conn, source)?;
    let mut selected = changed
        .iter()
        .map(|record| signature_for(record).source_session_id)
        .collect::<HashSet<_>>();
    changed.extend(discovered.iter().filter(|record| {
        let source_session_id = signature_for(record).source_session_id;
        repair_ids.contains(&source_session_id) && selected.insert(source_session_id)
    }));
    Ok(changed)
}

pub fn generated_name_repair_source_session_ids_from_conn(
    conn: &Connection,
    source: &str,
) -> Result<HashSet<String>, String> {
    let mut repair_ids = HashSet::new();
    let mut stmt = conn
        .prepare(
            "SELECT source_session_id, name
             FROM imported_history_session_cache
             WHERE source = ?1",
        )
        .map_err(|err| format!("Failed to prepare generated-name repair query: {err}"))?;
    let rows = stmt
        .query_map([source], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("Failed to query generated-name repairs: {err}"))?;
    for row in rows {
        let (source_session_id, name) =
            row.map_err(|err| format!("Failed to read generated-name repair row: {err}"))?;
        if super::super::needs_prompt_title_repair(&name) {
            repair_ids.insert(source_session_id);
        }
    }
    Ok(repair_ids)
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
