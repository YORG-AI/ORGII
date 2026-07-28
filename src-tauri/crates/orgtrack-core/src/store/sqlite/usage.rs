use rusqlite::{params, OptionalExtension};

use super::SqliteRecordStore;
use crate::session_usage::SessionUsageRecord;

impl SqliteRecordStore<'_> {
    /// Upsert one session's usage/cost projection row. The projection is
    /// derived state — writers always replace the full row rather than
    /// patching columns, so a recompute can never leave mixed generations.
    pub fn upsert_session_usage(&self, record: &SessionUsageRecord) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_session_usage (
                    session_id, source, model, account_id, key_source,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    total_tokens, context_tokens, recorded_cost_usd, estimated_cost_usd,
                    cost_usd, tokens_source, computed_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                ON CONFLICT(session_id) DO UPDATE SET
                    source=excluded.source,
                    model=excluded.model,
                    account_id=excluded.account_id,
                    key_source=excluded.key_source,
                    input_tokens=excluded.input_tokens,
                    output_tokens=excluded.output_tokens,
                    cache_read_tokens=excluded.cache_read_tokens,
                    cache_write_tokens=excluded.cache_write_tokens,
                    total_tokens=excluded.total_tokens,
                    context_tokens=excluded.context_tokens,
                    recorded_cost_usd=excluded.recorded_cost_usd,
                    estimated_cost_usd=excluded.estimated_cost_usd,
                    cost_usd=excluded.cost_usd,
                    tokens_source=excluded.tokens_source,
                    computed_at=excluded.computed_at",
                params![
                    record.session_id,
                    record.source,
                    record.model,
                    record.account_id,
                    record.key_source,
                    record.input_tokens,
                    record.output_tokens,
                    record.cache_read_tokens,
                    record.cache_write_tokens,
                    record.total_tokens,
                    record.context_tokens,
                    record.recorded_cost_usd,
                    record.estimated_cost_usd,
                    record.cost_usd,
                    record.tokens_source,
                    record.computed_at
                ],
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    pub fn get_session_usage(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionUsageRecord>, String> {
        self.conn
            .query_row(
                "SELECT session_id, source, model, account_id, key_source,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        total_tokens, context_tokens, recorded_cost_usd, estimated_cost_usd,
                        cost_usd, tokens_source, computed_at
                 FROM orgtrack_core_session_usage
                 WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok(SessionUsageRecord {
                        session_id: row.get(0)?,
                        source: row.get(1)?,
                        model: row.get(2)?,
                        account_id: row.get(3)?,
                        key_source: row.get(4)?,
                        input_tokens: row.get(5)?,
                        output_tokens: row.get(6)?,
                        cache_read_tokens: row.get(7)?,
                        cache_write_tokens: row.get(8)?,
                        total_tokens: row.get(9)?,
                        context_tokens: row.get(10)?,
                        recorded_cost_usd: row.get(11)?,
                        estimated_cost_usd: row.get(12)?,
                        cost_usd: row.get(13)?,
                        tokens_source: row.get(14)?,
                        computed_at: row.get(15)?,
                    })
                },
            )
            .optional()
            .map_err(|err| err.to_string())
    }

    pub fn delete_session_usage(&self, session_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM orgtrack_core_session_usage WHERE session_id = ?1",
                params![session_id],
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
    }
}
