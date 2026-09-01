//! Best-effort `session-store.db` enrichment (branch/repository and
//! per-request usage) plus the cached-enrichment fallback read back out of
//! the imported-history cache when the live store is unreadable.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::{params_from_iter, Connection, OpenFlags};

use crate::sources::imported_history::{self, metadata::SOURCE_COPILOT};

use super::bounded::bounded_nonempty;
use super::discovery::is_plain_session_dir_name;
use super::types::{CopilotDbEnrichment, CopilotUsageRow};
use super::{MAX_DB_USAGE_ROWS, MAX_DISCOVERED_SESSIONS, MAX_MODEL_BYTES, MAX_PATH_BYTES};

// ---------------------------------------------------------------------------
// session-store.db enrichment (best-effort)
// ---------------------------------------------------------------------------

pub(super) fn strip_managed_fingerprint(fingerprint: &str) -> &str {
    fingerprint
        .rsplit_once("|managed=")
        .map(|(base, _)| base)
        .unwrap_or(fingerprint)
}

pub(super) fn read_cached_copilot_fingerprints(
    conn: &Connection,
) -> Result<HashMap<String, String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT source_session_id, source_fingerprint
             FROM imported_history_session_cache
             WHERE source = ?1
             LIMIT 20001",
        )
        .map_err(|error| format!("Failed to prepare Copilot fingerprint query: {error}"))?;
    let rows = statement
        .query_map([SOURCE_COPILOT], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Failed to query Copilot fingerprints: {error}"))?;
    let mut fingerprints = HashMap::new();
    for row in rows {
        let (source_session_id, fingerprint) =
            row.map_err(|error| format!("Failed to read Copilot fingerprint: {error}"))?;
        fingerprints.insert(source_session_id, fingerprint);
        if fingerprints.len() > MAX_DISCOVERED_SESSIONS {
            return Err("Copilot cache exceeds the discovery safety limit".to_string());
        }
    }
    Ok(fingerprints)
}

pub(super) fn read_cached_copilot_enrichment(
    conn: &Connection,
    session_ids: &[String],
) -> Result<HashMap<String, CopilotDbEnrichment>, String> {
    let mut enrichment = HashMap::new();
    if session_ids.is_empty() {
        return Ok(enrichment);
    }
    let placeholders = (2..session_ids.len() + 2)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let params = std::iter::once(SOURCE_COPILOT)
        .chain(session_ids.iter().map(String::as_str))
        .collect::<Vec<_>>();
    let mut statement = conn
        .prepare(&format!(
            "SELECT source_session_id, branch
             FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id IN ({placeholders})"
        ))
        .map_err(|error| format!("Failed to prepare cached Copilot enrichment: {error}"))?;
    let rows = statement
        .query_map(params_from_iter(params.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Failed to query cached Copilot enrichment: {error}"))?;
    for row in rows {
        let (session_id, branch) =
            row.map_err(|error| format!("Failed to read cached Copilot enrichment: {error}"))?;
        enrichment.entry(session_id).or_default().branch =
            bounded_nonempty(&branch, MAX_PATH_BYTES);
    }

    let params = std::iter::once(SOURCE_COPILOT)
        .chain(session_ids.iter().map(String::as_str))
        .collect::<Vec<_>>();
    let mut statement = conn
        .prepare(&format!(
            "SELECT source_session_id, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, created_at_ms
             FROM imported_history_round_usage
             WHERE source = ?1 AND source_session_id IN ({placeholders})
             ORDER BY source_session_id, seq
             LIMIT {}",
            MAX_DB_USAGE_ROWS + 1
        ))
        .map_err(|error| format!("Failed to prepare cached Copilot rounds: {error}"))?;
    let rows = statement
        .query_map(params_from_iter(params.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                CopilotUsageRow {
                    model: row
                        .get::<_, Option<String>>(1)?
                        .and_then(|value| bounded_nonempty(&value, MAX_MODEL_BYTES)),
                    input_tokens: row
                        .get::<_, i64>(2)?
                        .max(0)
                        .saturating_add(row.get::<_, i64>(4)?.max(0))
                        .saturating_add(row.get::<_, i64>(5)?.max(0)),
                    output_tokens: row.get::<_, i64>(3)?.max(0),
                    cache_read_tokens: row.get::<_, i64>(4)?.max(0),
                    cache_write_tokens: row.get::<_, i64>(5)?.max(0),
                    created_at_ms: row.get::<_, i64>(6)?,
                },
            ))
        })
        .map_err(|error| format!("Failed to query cached Copilot rounds: {error}"))?;
    let mut count = 0usize;
    for row in rows {
        count = count.saturating_add(1);
        if count > MAX_DB_USAGE_ROWS {
            return Err("Cached Copilot usage exceeds the safety limit".to_string());
        }
        let (session_id, usage) =
            row.map_err(|error| format!("Failed to read cached Copilot round: {error}"))?;
        enrichment.entry(session_id).or_default().usage.push(usage);
    }
    Ok(enrichment)
}

/// Read branch/repository and per-request usage only for the bounded set of
/// cache candidates. `None` means the live database could not be read, so the
/// caller preserves the last cached enrichment instead of clearing tokens on
/// a transient lock or partial schema.
pub(super) fn read_copilot_store_enrichment(
    db_path: Option<&Path>,
    session_ids: &[String],
) -> Option<HashMap<String, CopilotDbEnrichment>> {
    let mut enrichment = HashMap::new();
    if session_ids.is_empty() {
        return Some(enrichment);
    }
    let db_path = db_path?;
    let metadata = fs::symlink_metadata(db_path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    };
    let Ok(conn) = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    ) else {
        return None;
    };
    // Short busy timeout: tolerate a briefly-writing live CLI without ever
    // stalling a scan on a held lock.
    let _ = conn.busy_timeout(Duration::from_millis(250));
    // Usage totals must be all-or-nothing: keeping a prefix after the global
    // row cap would under-report spend. A missing/locked/oversized usage table
    // therefore preserves the previous cache snapshot. Branch enrichment is
    // optional once that complete usage read has succeeded.
    read_copilot_usage_rows(&conn, session_ids, &mut enrichment).ok()?;
    let _ = read_copilot_session_rows(&conn, session_ids, &mut enrichment);
    Some(enrichment)
}

fn read_copilot_session_rows(
    conn: &Connection,
    session_ids: &[String],
    enrichment: &mut HashMap<String, CopilotDbEnrichment>,
) -> Result<(), String> {
    let placeholders = (1..=session_ids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, repository, branch FROM sessions WHERE id IN ({placeholders})"
        ))
        .map_err(|error| format!("Failed to prepare Copilot session-store query: {error}"))?;
    let rows = stmt
        .query_map(params_from_iter(session_ids.iter()), |row| {
            Ok((
                row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| format!("Failed to query Copilot session-store rows: {error}"))?;
    for row in rows {
        let (id, repository, branch) =
            row.map_err(|error| format!("Failed to read Copilot session-store row: {error}"))?;
        if !is_plain_session_dir_name(id.trim()) {
            continue;
        }
        let entry = enrichment.entry(id).or_default();
        entry.repository = repository.and_then(|value| bounded_nonempty(&value, MAX_PATH_BYTES));
        entry.branch = branch.and_then(|value| bounded_nonempty(&value, MAX_PATH_BYTES));
    }
    Ok(())
}

fn read_copilot_usage_rows(
    conn: &Connection,
    session_ids: &[String],
    enrichment: &mut HashMap<String, CopilotDbEnrichment>,
) -> Result<(), String> {
    // Rowid order is the round ordinal (`seq`); `created_at` rides along as
    // the round timestamp.
    let placeholders = (1..=session_ids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT session_id, model, input_tokens, output_tokens, \
                cache_read_tokens, cache_write_tokens, created_at \
         FROM assistant_usage_events
         WHERE session_id IN ({placeholders})
         ORDER BY id
         LIMIT {}",
            MAX_DB_USAGE_ROWS + 1
        ))
        .map_err(|error| format!("Failed to prepare Copilot usage query: {error}"))?;
    let rows = stmt
        .query_map(params_from_iter(session_ids.iter()), |row| {
            let session_id = row.get::<_, Option<String>>(0)?.unwrap_or_default();
            let created_at = row.get::<_, Option<String>>(6)?.unwrap_or_default();
            Ok((
                session_id,
                CopilotUsageRow {
                    model: row
                        .get::<_, Option<String>>(1)?
                        .and_then(|value| bounded_nonempty(&value, MAX_MODEL_BYTES)),
                    input_tokens: row.get::<_, Option<i64>>(2)?.unwrap_or_default().max(0),
                    output_tokens: row.get::<_, Option<i64>>(3)?.unwrap_or_default().max(0),
                    cache_read_tokens: row.get::<_, Option<i64>>(4)?.unwrap_or_default().max(0),
                    cache_write_tokens: row.get::<_, Option<i64>>(5)?.unwrap_or_default().max(0),
                    created_at_ms: imported_history::parse_iso_to_epoch_ms_opt(created_at.trim())
                        .unwrap_or_default(),
                },
            ))
        })
        .map_err(|error| format!("Failed to query Copilot usage rows: {error}"))?;
    let mut count = 0usize;
    for row in rows {
        count = count.saturating_add(1);
        if count > MAX_DB_USAGE_ROWS {
            return Err(format!(
                "Copilot usage enrichment exceeds the {MAX_DB_USAGE_ROWS}-row safety limit"
            ));
        }
        let (session_id, usage) =
            row.map_err(|error| format!("Failed to read Copilot usage row: {error}"))?;
        if !is_plain_session_dir_name(session_id.trim()) {
            continue;
        }
        enrichment.entry(session_id).or_default().usage.push(usage);
    }
    Ok(())
}
