use super::*;

pub(super) fn opencode_source_summary(
    conn: &Connection,
    source_session_id: &str,
) -> Result<SqliteSourceSummary, String> {
    let row_count = conn
        .query_row(
            "SELECT COUNT(*) FROM part WHERE session_id=?1",
            [source_session_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|err| format!("count SQLite replay parts: {err}"))?
        .max(0) as u64;
    let (max_time_created, max_source_key) = conn
        .query_row(
            "SELECT COALESCE(time_created,0), COALESCE(id,'') FROM part
             WHERE session_id=?1 ORDER BY time_created DESC,id DESC LIMIT 1",
            [source_session_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|err| format!("read SQLite replay part watermark: {err}"))?
        .unwrap_or_default();
    let session_signal = conn
        .query_row(
            "SELECT COALESCE(time_updated, time_created, 0) FROM session WHERE id=?1",
            [source_session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|err| format!("read SQLite replay session signal: {err}"))?
        .unwrap_or_default()
        .to_string();
    Ok(SqliteSourceSummary {
        row_count,
        max_time_created,
        max_source_key: max_source_key.clone(),
        source_signal: session_signal,
        last_source_key: max_source_key,
        order_signal: String::new(),
    })
}

pub(super) fn opencode_sync_plan(
    previous: &RowStoreReplayCursor,
    current: &SqliteSourceSummary,
) -> SyncPlan {
    if previous.source_signal.is_empty() {
        return SyncPlan::Reconcile;
    }
    if current.row_count == previous.total_source_rows
        && current.max_time_created == previous.max_time_created
        && current.max_source_key == previous.max_source_key
        && current.source_signal == previous.source_signal
    {
        return SyncPlan::Skip;
    }
    let watermark_advanced = (current.max_time_created, current.max_source_key.as_str())
        > (previous.max_time_created, previous.max_source_key.as_str());
    if current.row_count > previous.total_source_rows && watermark_advanced {
        SyncPlan::Append
    } else {
        SyncPlan::Reconcile
    }
}

pub(super) fn stream_opencode_family(
    conn: &Connection,
    source: ImportedHistorySourceId,
    source_session_id: &str,
    after: Option<(i64, &str)>,
    mut visit: impl FnMut(SourceRow) -> Result<(), String>,
) -> Result<(), String> {
    let (after_time, after_key) = after.unwrap_or((i64::MIN, ""));
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.message_id, COALESCE(json_extract(m.data, '$.role'), ''),
                    p.data, COALESCE(p.time_created, 0)
             FROM part p JOIN message m ON m.id=p.message_id
             WHERE p.session_id=?1
               AND (p.time_created>?2 OR (p.time_created=?2 AND p.id>?3))
             ORDER BY p.time_created ASC, p.id ASC",
        )
        .map_err(|err| format!("prepare {} replay row stream: {err}", source.as_str()))?;
    let mut rows = stmt
        .query(params![source_session_id, after_time, after_key])
        .map_err(|err| format!("query {} replay rows: {err}", source.as_str()))?;
    let mut ordinal = 0_i64;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("stream {} replay row: {err}", source.as_str()))?
    {
        let Some(raw_json) = row
            .get::<_, Option<String>>(3)
            .map_err(|err| format!("read {} replay JSON: {err}", source.as_str()))?
        else {
            continue;
        };
        visit(SourceRow {
            key: row
                .get::<_, Option<String>>(0)
                .map_err(|e| e.to_string())?
                .unwrap_or_default(),
            message_id: row
                .get::<_, Option<String>>(1)
                .map_err(|e| e.to_string())?
                .unwrap_or_default(),
            role: row
                .get::<_, Option<String>>(2)
                .map_err(|e| e.to_string())?
                .unwrap_or_default(),
            raw_json,
            time_created: row
                .get::<_, Option<i64>>(4)
                .map_err(|e| e.to_string())?
                .unwrap_or_default(),
            header_type: 0,
            ordinal,
            turn_index: 0,
        })?;
        ordinal += 1;
    }
    Ok(())
}
