use std::time::{SystemTime, UNIX_EPOCH};

use crate::canonical::{AgentMetadata, SessionRecord};
use crate::privacy::ORGTRACK_SCHEMA_VERSION;
use crate::store::{sqlite::SqliteRecordStore, RecordStore};
use chrono::Utc;
use rusqlite::{params, params_from_iter, Connection};

use super::continuation::CONTINUATION_LINEAGE_ID_FIELD;
use super::super::metadata::{ImportedHistoryCacheInput, RoundUsage};
use super::super::scratch_workspace::is_agent_scratch_workspace;

/// The session's workspace, or `None` when it has none.
///
/// This is the single boundary that decides what "workspace" means for an
/// imported session, so every source — present and future — inherits the
/// invariant. A provider's per-session scratch directory is a real cwd but
/// not a workspace the user chose (see [`super::super::scratch_workspace`]), and
/// recording it would invent a one-session workspace group in the sidebar and
/// a phantom repo in the Data/Usage rollups.
fn workspace_repo_path(input: &ImportedHistoryCacheInput) -> Option<String> {
    input
        .repo_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .filter(|path| !is_agent_scratch_workspace(input.source, path))
        .map(str::to_string)
}

pub fn upsert_imported_session_cache_from_conn(
    conn: &mut Connection,
    inputs: &[ImportedHistoryCacheInput],
) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    let tx = conn
        .transaction()
        .map_err(|err| format!("Failed to start imported history cache transaction: {err}"))?;
    let updated_at = Utc::now().to_rfc3339();
    {
        let mut stmt = tx
            .prepare(&format!(
                "INSERT INTO imported_history_session_cache (
                    source, source_session_id, session_id, source_path, source_record_key,
                    source_mtime_ms, source_size_bytes, source_fingerprint, parser_version,
                    name, created_at_ms, updated_at_ms, model, input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens,
                    repo_path, branch, files_changed, lines_added, lines_removed,
                    touched_files_json, listable, source_metadata_json, parent_session_id,
                    updated_at, client_origin, client_origin_raw
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                    ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29
                )
                ON CONFLICT(source, source_session_id) DO UPDATE SET
                    session_id = excluded.session_id,
                    source_path = excluded.source_path,
                    source_record_key = excluded.source_record_key,
                    source_mtime_ms = excluded.source_mtime_ms,
                    source_size_bytes = excluded.source_size_bytes,
                    source_fingerprint = excluded.source_fingerprint,
                    parser_version = excluded.parser_version,
                    name = excluded.name,
                    created_at_ms = excluded.created_at_ms,
                    updated_at_ms = excluded.updated_at_ms,
                    model = excluded.model,
                    input_tokens = excluded.input_tokens,
                    output_tokens = excluded.output_tokens,
                    cache_read_tokens = excluded.cache_read_tokens,
                    cache_write_tokens = excluded.cache_write_tokens,
                    repo_path = excluded.repo_path,
                    branch = excluded.branch,
                    files_changed = excluded.files_changed,
                    lines_added = excluded.lines_added,
                    lines_removed = excluded.lines_removed,
                    touched_files_json = excluded.touched_files_json,
                    listable = excluded.listable,
                    source_metadata_json = CASE
                        WHEN json_valid(excluded.source_metadata_json)
                             AND json_valid(imported_history_session_cache.source_metadata_json)
                             AND json_extract(imported_history_session_cache.source_metadata_json,
                                              '$.{CONTINUATION_LINEAGE_ID_FIELD}') IS NOT NULL
                             AND json_extract(excluded.source_metadata_json,
                                              '$.{CONTINUATION_LINEAGE_ID_FIELD}') IS NULL
                        THEN json_set(excluded.source_metadata_json,
                                      '$.{CONTINUATION_LINEAGE_ID_FIELD}',
                                      json_extract(imported_history_session_cache.source_metadata_json,
                                                   '$.{CONTINUATION_LINEAGE_ID_FIELD}'))
                        ELSE excluded.source_metadata_json
                    END,
                    parent_session_id = excluded.parent_session_id,
                    updated_at = excluded.updated_at,
                    client_origin = excluded.client_origin,
                    client_origin_raw = excluded.client_origin_raw",
            ))
            .map_err(|err| format!("Failed to prepare imported history cache upsert: {err}"))?;
        for input in inputs {
            let touched_files_json = serde_json::to_string(&input.impact.touched_files)
                .map_err(|err| format!("Failed to encode imported history touched files: {err}"))?;
            stmt.execute(params![
                input.source,
                input.source_session_id,
                input.session_id,
                input.source_path,
                input.source_record_key,
                input.source_mtime_ms,
                input.source_size_bytes,
                input.source_fingerprint,
                input.parser_version,
                input.name,
                input.created_at_ms,
                input.updated_at_ms,
                input.model.as_deref().unwrap_or_default(),
                input.input_tokens,
                input.output_tokens,
                input.cache_read_tokens,
                input.cache_write_tokens,
                workspace_repo_path(input).unwrap_or_default(),
                input.branch.as_deref().unwrap_or_default(),
                input.impact.files_changed,
                input.impact.lines_added,
                input.impact.lines_removed,
                touched_files_json,
                if input.listable { 1_i64 } else { 0_i64 },
                input.source_metadata_json.as_deref().unwrap_or_default(),
                input.parent_session_id.as_deref().unwrap_or_default(),
                updated_at,
                input
                    .client_origin
                    .map(|origin| origin.as_wire_str())
                    .unwrap_or_default(),
                input.client_origin_raw.as_deref().unwrap_or_default(),
            ])
            .map_err(|err| format!("Failed to upsert imported history cache row: {err}"))?;
        }
    }
    tx.commit()
        .map_err(|err| format!("Failed to commit imported history cache rows: {err}"))?;

    let store = SqliteRecordStore::new(conn);
    for input in inputs {
        store.upsert_session(&core_session_record_from_imported_input(input))?;
    }
    // Project usage/cost for rows that carry token counts. Best-effort: a
    // projection failure must not fail the import scan (the startup backfill
    // repairs missing rows), and this crate has no logging facility to report
    // it through.
    for input in inputs {
        if input.input_tokens > 0 || input.output_tokens > 0 {
            let _ = crate::session_usage::recompute_session_usage(conn, &input.session_id);
        }
    }
    Ok(())
}

fn core_session_record_from_imported_input(input: &ImportedHistoryCacheInput) -> SessionRecord {
    SessionRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        source: input.source.to_string(),
        source_session_id: input.source_session_id.clone(),
        session_id: input.session_id.clone(),
        title: input.name.clone(),
        status: Some(super::super::IMPORTED_STATUS_COMPLETED.to_string()),
        created_at: Some(super::super::epoch_ms_to_iso(input.created_at_ms)),
        updated_at: Some(super::super::epoch_ms_to_iso(input.updated_at_ms)),
        completed_at: Some(super::super::epoch_ms_to_iso(input.updated_at_ms)),
        workspace_path: workspace_repo_path(input),
        branch: input.branch.clone(),
        parent_session_id: input.parent_session_id.clone(),
        org_member_id: None,
        collaboration_origin: None,
        metadata: AgentMetadata {
            origin: Some(input.source.to_string()),
            display_name: Some(input.source.to_string()),
            model: input.model.clone(),
            ..AgentMetadata::default()
        },
    }
}

/// Replace the per-round usage rows for the given (re-parsed) sessions: delete
/// any existing rounds for those `session_id`s, then insert `rounds`. Called
/// once per scan with the sessions that were actually re-parsed, so unchanged
/// sessions keep their rounds.
pub fn write_session_rounds_from_conn(
    conn: &Connection,
    reparsed_session_ids: &[String],
    rounds: &[RoundUsage],
) -> Result<(), String> {
    if reparsed_session_ids.is_empty() && rounds.is_empty() {
        return Ok(());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("Failed to start round-usage transaction: {err}"))?;
    for chunk in reparsed_session_ids.chunks(400) {
        let placeholders = (1..=chunk.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(",");
        tx.execute(
            &format!(
                "DELETE FROM imported_history_round_usage WHERE session_id IN ({placeholders})"
            ),
            params_from_iter(chunk.iter().map(String::as_str)),
        )
        .map_err(|err| format!("Failed to clear stale imported rounds: {err}"))?;
    }
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO imported_history_round_usage (
                    source, source_session_id, session_id, seq, model,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    created_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )
            .map_err(|err| format!("Failed to prepare imported round insert: {err}"))?;
        for round in rounds {
            stmt.execute(params![
                round.source,
                round.source_session_id,
                round.session_id,
                round.seq,
                round.model.as_deref().unwrap_or_default(),
                round.input_tokens,
                round.output_tokens,
                round.cache_read_tokens,
                round.cache_write_tokens,
                round.created_at_ms,
            ])
            .map_err(|err| format!("Failed to insert imported round: {err}"))?;
        }
    }
    tx.commit()
        .map_err(|err| format!("Failed to commit imported rounds: {err}"))
}

pub fn prune_missing_records_from_conn(
    conn: &Connection,
    source: &str,
    live_source_session_ids: &[String],
) -> Result<(), String> {
    if live_source_session_ids.is_empty() {
        conn.execute(
            "DELETE FROM imported_history_session_cache WHERE source = ?1",
            [source],
        )
        .map_err(|err| format!("Failed to prune imported history cache source {source}: {err}"))?;
        conn.execute(
            "DELETE FROM imported_history_round_usage WHERE source = ?1",
            [source],
        )
        .ok();
        conn.execute(
            "DELETE FROM imported_history_parse_watermarks WHERE source = ?1",
            [source],
        )
        .ok();
        return Ok(());
    }

    let placeholders = (2..live_source_session_ids.len().saturating_add(2))
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "DELETE FROM imported_history_session_cache \
         WHERE source = ?1 AND source_session_id NOT IN ({placeholders})"
    );
    let params = std::iter::once(source)
        .chain(live_source_session_ids.iter().map(String::as_str))
        .collect::<Vec<_>>();
    conn.execute(&sql, params_from_iter(params))
        .map_err(|err| format!("Failed to prune imported history cache source {source}: {err}"))?;
    // Drop rounds whose owning session was just pruned.
    conn.execute(
        "DELETE FROM imported_history_round_usage \
         WHERE source = ?1 AND session_id NOT IN \
             (SELECT session_id FROM imported_history_session_cache WHERE source = ?1)",
        [source],
    )
    .ok();
    conn.execute(
        "DELETE FROM imported_history_parse_watermarks \
         WHERE source = ?1 AND source_session_id NOT IN \
             (SELECT source_session_id FROM imported_history_session_cache WHERE source = ?1)",
        [source],
    )
    .ok();
    Ok(())
}

pub fn sync_source_cache_from_conn(
    conn: &mut Connection,
    source: &'static str,
    live_source_session_ids: Vec<String>,
    inputs: Vec<ImportedHistoryCacheInput>,
) -> Result<(), String> {
    upsert_imported_session_cache_from_conn(conn, &inputs)?;
    prune_missing_records_from_conn(conn, source, &live_source_session_ids)?;
    #[cfg(feature = "git")]
    super::super::repo_identity::sync_repo_identities_for_source_from_conn(
        conn,
        source,
        current_epoch_ms()?,
    )?;
    Ok(())
}

pub fn current_epoch_ms() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System time is before Unix epoch: {err}"))
        .map(|duration| duration.as_millis() as i64)
}
