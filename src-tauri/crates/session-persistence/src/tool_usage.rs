//! Per-LLM-call usage spans and per-tool-call attribution persistence.

use chrono::Utc;
use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};

use super::connection::with_sessions_writer;
use super::get_connection;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttributionMethod {
    ProviderExact,
    SingleToolIteration,
    SplitBySerializedSize,
    SplitEvenly,
    EstimatedTokenizer,
    BytesOnly,
}

impl AttributionMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProviderExact => "provider_exact",
            Self::SingleToolIteration => "single_tool_iteration",
            Self::SplitBySerializedSize => "split_by_serialized_size",
            Self::SplitEvenly => "split_evenly",
            Self::EstimatedTokenizer => "estimated_tokenizer",
            Self::BytesOnly => "bytes_only",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "provider_exact" => Self::ProviderExact,
            "single_tool_iteration" => Self::SingleToolIteration,
            "split_by_serialized_size" => Self::SplitBySerializedSize,
            "split_evenly" => Self::SplitEvenly,
            "estimated_tokenizer" => Self::EstimatedTokenizer,
            "bytes_only" => Self::BytesOnly,
            _ => Self::BytesOnly,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmUsageSpanRecord {
    pub id: i64,
    pub session_id: String,
    pub turn_id: String,
    pub iteration_index: i64,
    pub model: Option<String>,
    pub account_id: Option<String>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
    pub context_tokens: i64,
    pub related_tool_call_ids_json: Option<String>,
    pub context_usage_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewLlmUsageSpan<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub iteration_index: i64,
    pub model: Option<&'a str>,
    pub account_id: Option<&'a str>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
    pub context_tokens: i64,
    pub related_tool_call_ids_json: Option<&'a str>,
    pub context_usage_json: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsageAttributionRecord {
    pub id: i64,
    pub session_id: String,
    pub turn_id: String,
    pub event_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub iteration_index: i64,
    pub decision_completion_tokens: i64,
    pub result_context_tokens: i64,
    pub followup_completion_tokens: i64,
    pub input_bytes: i64,
    pub output_bytes: i64,
    pub attribution_method: AttributionMethod,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewToolUsageAttribution<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub event_id: &'a str,
    pub tool_call_id: &'a str,
    pub tool_name: &'a str,
    pub iteration_index: i64,
    pub decision_completion_tokens: i64,
    pub result_context_tokens: i64,
    pub followup_completion_tokens: i64,
    pub input_bytes: i64,
    pub output_bytes: i64,
    pub attribution_method: AttributionMethod,
}

pub fn insert_usage_telemetry_batch(
    spans: &[NewLlmUsageSpan<'_>],
    attributions: &[NewToolUsageAttribution<'_>],
) -> SqliteResult<()> {
    with_sessions_writer(|| {
        let mut conn = get_connection()?;
        insert_usage_telemetry_batch_with_conn(&mut conn, spans, attributions)
    })?;
    // Spans describe the same tokens as `session_token_usage` at per-LLM-call
    // granularity — the projection reads only the rollups (summing both would
    // double-count). Refreshing here guards against a batch landing after the
    // turn rollup's own refresh.
    let mut seen = std::collections::HashSet::new();
    for span in spans {
        if seen.insert(span.session_id) {
            super::token_usage::recompute_usage_projection(span.session_id);
        }
    }
    Ok(())
}

pub fn insert_usage_telemetry_batch_with_conn(
    conn: &mut Connection,
    spans: &[NewLlmUsageSpan<'_>],
    attributions: &[NewToolUsageAttribution<'_>],
) -> SqliteResult<()> {
    let transaction = conn.transaction()?;
    let now = Utc::now().to_rfc3339();

    {
        let mut stmt = transaction.prepare_cached(
            "INSERT INTO session_llm_usage_spans
                (session_id, turn_id, iteration_index, model, account_id,
                 prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
                 total_tokens, context_tokens, related_tool_call_ids_json,
                 context_usage_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )?;
        for span in spans {
            stmt.execute(params![
                span.session_id,
                span.turn_id,
                span.iteration_index,
                span.model,
                span.account_id,
                span.prompt_tokens,
                span.completion_tokens,
                span.cache_read_tokens,
                span.cache_write_tokens,
                span.total_tokens,
                span.context_tokens,
                span.related_tool_call_ids_json,
                span.context_usage_json,
                now,
            ])?;
        }
    }

    {
        let mut stmt = transaction.prepare_cached(
            "INSERT INTO session_tool_usage
                (session_id, turn_id, event_id, tool_call_id, tool_name, iteration_index,
                 decision_completion_tokens, result_context_tokens, followup_completion_tokens,
                 input_bytes, output_bytes, attribution_method, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        for attribution in attributions {
            stmt.execute(params![
                attribution.session_id,
                attribution.turn_id,
                attribution.event_id,
                attribution.tool_call_id,
                attribution.tool_name,
                attribution.iteration_index,
                attribution.decision_completion_tokens,
                attribution.result_context_tokens,
                attribution.followup_completion_tokens,
                attribution.input_bytes,
                attribution.output_bytes,
                attribution.attribution_method.as_str(),
                now,
            ])?;
        }
    }

    transaction.commit()
}

pub fn get_llm_usage_spans(
    session_id: &str,
    turn_id: Option<&str>,
) -> SqliteResult<Vec<LlmUsageSpanRecord>> {
    let conn = get_connection()?;
    let sql = match turn_id {
        Some(_) => {
            "SELECT id, session_id, turn_id, iteration_index, model, account_id,
                    prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
                    total_tokens, context_tokens, related_tool_call_ids_json,
                    context_usage_json, created_at
             FROM session_llm_usage_spans
             WHERE session_id = ?1 AND turn_id = ?2
             ORDER BY iteration_index ASC, id ASC"
        }
        None => {
            "SELECT id, session_id, turn_id, iteration_index, model, account_id,
                    prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
                    total_tokens, context_tokens, related_tool_call_ids_json,
                    context_usage_json, created_at
             FROM session_llm_usage_spans
             WHERE session_id = ?1
             ORDER BY turn_id ASC, iteration_index ASC, id ASC"
        }
    };
    let mut stmt = conn.prepare(sql)?;
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(LlmUsageSpanRecord {
            id: row.get(0)?,
            session_id: row.get(1)?,
            turn_id: row.get(2)?,
            iteration_index: row.get(3)?,
            model: row.get(4)?,
            account_id: row.get(5)?,
            prompt_tokens: row.get(6)?,
            completion_tokens: row.get(7)?,
            cache_read_tokens: row.get(8)?,
            cache_write_tokens: row.get(9)?,
            total_tokens: row.get(10)?,
            context_tokens: row.get(11)?,
            related_tool_call_ids_json: row.get(12)?,
            context_usage_json: row.get(13)?,
            created_at: row.get(14)?,
        })
    };

    let records = match turn_id {
        Some(turn_id) => stmt
            .query_map(params![session_id, turn_id], map_row)?
            .collect::<SqliteResult<Vec<_>>>()?,
        None => stmt
            .query_map(params![session_id], map_row)?
            .collect::<SqliteResult<Vec<_>>>()?,
    };
    Ok(records)
}

pub fn get_tool_usage_attributions(
    session_id: &str,
    turn_id: Option<&str>,
) -> SqliteResult<Vec<ToolUsageAttributionRecord>> {
    let conn = get_connection()?;
    let sql = match turn_id {
        Some(_) => {
            "SELECT id, session_id, turn_id, event_id, tool_call_id, tool_name,
                    iteration_index, decision_completion_tokens, result_context_tokens,
                    followup_completion_tokens, input_bytes, output_bytes,
                    attribution_method, created_at
             FROM session_tool_usage
             WHERE session_id = ?1 AND turn_id = ?2
             ORDER BY iteration_index ASC, id ASC"
        }
        None => {
            "SELECT id, session_id, turn_id, event_id, tool_call_id, tool_name,
                    iteration_index, decision_completion_tokens, result_context_tokens,
                    followup_completion_tokens, input_bytes, output_bytes,
                    attribution_method, created_at
             FROM session_tool_usage
             WHERE session_id = ?1
             ORDER BY turn_id ASC, iteration_index ASC, id ASC"
        }
    };
    let mut stmt = conn.prepare(sql)?;
    let map_row = |row: &rusqlite::Row<'_>| {
        let method: String = row.get(12)?;
        Ok(ToolUsageAttributionRecord {
            id: row.get(0)?,
            session_id: row.get(1)?,
            turn_id: row.get(2)?,
            event_id: row.get(3)?,
            tool_call_id: row.get(4)?,
            tool_name: row.get(5)?,
            iteration_index: row.get(6)?,
            decision_completion_tokens: row.get(7)?,
            result_context_tokens: row.get(8)?,
            followup_completion_tokens: row.get(9)?,
            input_bytes: row.get(10)?,
            output_bytes: row.get(11)?,
            attribution_method: AttributionMethod::from_str(&method),
            created_at: row.get(13)?,
        })
    };

    let records = match turn_id {
        Some(turn_id) => stmt
            .query_map(params![session_id, turn_id], map_row)?
            .collect::<SqliteResult<Vec<_>>>()?,
        None => stmt
            .query_map(params![session_id], map_row)?
            .collect::<SqliteResult<Vec<_>>>()?,
    };
    Ok(records)
}

pub fn get_tool_usage_attributions_for_call(
    session_id: &str,
    tool_call_id: &str,
) -> SqliteResult<Vec<ToolUsageAttributionRecord>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, session_id, turn_id, event_id, tool_call_id, tool_name,
                iteration_index, decision_completion_tokens, result_context_tokens,
                followup_completion_tokens, input_bytes, output_bytes,
                attribution_method, created_at
         FROM session_tool_usage
         WHERE session_id = ?1 AND tool_call_id = ?2
         ORDER BY iteration_index ASC, id ASC",
    )?;
    let records = stmt
        .query_map(params![session_id, tool_call_id], |row| {
            let method: String = row.get(12)?;
            Ok(ToolUsageAttributionRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                turn_id: row.get(2)?,
                event_id: row.get(3)?,
                tool_call_id: row.get(4)?,
                tool_name: row.get(5)?,
                iteration_index: row.get(6)?,
                decision_completion_tokens: row.get(7)?,
                result_context_tokens: row.get(8)?,
                followup_completion_tokens: row.get(9)?,
                input_bytes: row.get(10)?,
                output_bytes: row.get(11)?,
                attribution_method: AttributionMethod::from_str(&method),
                created_at: row.get(13)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(records)
}

pub fn delete_usage_telemetry(session_id: &str) -> SqliteResult<usize> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let span_count = conn.execute(
            "DELETE FROM session_llm_usage_spans WHERE session_id = ?1",
            [session_id],
        )?;
        let attribution_count = conn.execute(
            "DELETE FROM session_tool_usage WHERE session_id = ?1",
            [session_id],
        )?;
        Ok(span_count + attribution_count)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_temp_orgii_home<R>(run: impl FnOnce() -> R) -> R {
        let _guard = match crate::ORGII_HOME_TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let previous = std::env::var("ORGII_HOME").ok();
        let root = std::env::temp_dir().join(format!(
            "orgii-tool-usage-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp ORGII_HOME");
        std::env::set_var("ORGII_HOME", &root);
        {
            let conn = get_connection().expect("open sessions DB");
            super::super::schema::init_session_tables(&conn).expect("init session schema for test");
        }
        let result = run();
        match previous {
            Some(value) => std::env::set_var("ORGII_HOME", value),
            None => std::env::remove_var("ORGII_HOME"),
        }
        let _ = std::fs::remove_dir_all(&root);
        result
    }

    #[test]
    fn usage_telemetry_round_trips_span_and_tool_attribution() {
        with_temp_orgii_home(|| {
            let related_tool_call_ids_json = r#"["call-1"]"#;
            let context_usage_json = r#"{"usedTokens":1200}"#;
            insert_usage_telemetry_batch(
                &[NewLlmUsageSpan {
                    session_id: "session-1",
                    turn_id: "turn-1",
                    iteration_index: 1,
                    model: Some("model-1"),
                    account_id: Some("account-1"),
                    prompt_tokens: 1000,
                    completion_tokens: 100,
                    cache_read_tokens: 50,
                    cache_write_tokens: 25,
                    total_tokens: 1175,
                    context_tokens: 1075,
                    related_tool_call_ids_json: Some(related_tool_call_ids_json),
                    context_usage_json: Some(context_usage_json),
                }],
                &[NewToolUsageAttribution {
                    session_id: "session-1",
                    turn_id: "turn-1",
                    event_id: "tool-call-call-1",
                    tool_call_id: "call-1",
                    tool_name: "read_file",
                    iteration_index: 1,
                    decision_completion_tokens: 100,
                    result_context_tokens: 240,
                    followup_completion_tokens: 40,
                    input_bytes: 20,
                    output_bytes: 960,
                    attribution_method: AttributionMethod::SingleToolIteration,
                }],
            )
            .expect("insert usage telemetry");

            let spans =
                get_llm_usage_spans("session-1", Some("turn-1")).expect("load llm usage spans");
            assert_eq!(spans.len(), 1);
            assert_eq!(spans[0].iteration_index, 1);
            assert_eq!(
                spans[0].related_tool_call_ids_json.as_deref(),
                Some(related_tool_call_ids_json)
            );
            assert_eq!(
                spans[0].context_usage_json.as_deref(),
                Some(context_usage_json)
            );

            let attributions = get_tool_usage_attributions_for_call("session-1", "call-1")
                .expect("load tool usage attribution");
            assert_eq!(attributions.len(), 1);
            assert_eq!(attributions[0].tool_name, "read_file");
            assert_eq!(
                attributions[0].attribution_method,
                AttributionMethod::SingleToolIteration
            );
        });
    }

    #[test]
    fn usage_telemetry_queries_filter_by_session_turn_and_call_id() {
        with_temp_orgii_home(|| {
            insert_usage_telemetry_batch(
                &[
                    NewLlmUsageSpan {
                        session_id: "session-1",
                        turn_id: "turn-1",
                        iteration_index: 1,
                        model: None,
                        account_id: None,
                        prompt_tokens: 10,
                        completion_tokens: 20,
                        cache_read_tokens: 0,
                        cache_write_tokens: 0,
                        total_tokens: 30,
                        context_tokens: 10,
                        related_tool_call_ids_json: Some(r#"["call-1"]"#),
                        context_usage_json: None,
                    },
                    NewLlmUsageSpan {
                        session_id: "session-1",
                        turn_id: "turn-2",
                        iteration_index: 2,
                        model: None,
                        account_id: None,
                        prompt_tokens: 30,
                        completion_tokens: 40,
                        cache_read_tokens: 0,
                        cache_write_tokens: 0,
                        total_tokens: 70,
                        context_tokens: 30,
                        related_tool_call_ids_json: Some(r#"["call-2"]"#),
                        context_usage_json: None,
                    },
                ],
                &[
                    NewToolUsageAttribution {
                        session_id: "session-1",
                        turn_id: "turn-1",
                        event_id: "tool-call-call-1",
                        tool_call_id: "call-1",
                        tool_name: "read_file",
                        iteration_index: 1,
                        decision_completion_tokens: 20,
                        result_context_tokens: 5,
                        followup_completion_tokens: 0,
                        input_bytes: 10,
                        output_bytes: 20,
                        attribution_method: AttributionMethod::SingleToolIteration,
                    },
                    NewToolUsageAttribution {
                        session_id: "session-1",
                        turn_id: "turn-2",
                        event_id: "tool-call-call-2",
                        tool_call_id: "call-2",
                        tool_name: "run_shell",
                        iteration_index: 2,
                        decision_completion_tokens: 40,
                        result_context_tokens: 15,
                        followup_completion_tokens: 3,
                        input_bytes: 30,
                        output_bytes: 60,
                        attribution_method: AttributionMethod::BytesOnly,
                    },
                ],
            )
            .expect("insert usage telemetry");

            let all_spans = get_llm_usage_spans("session-1", None).expect("load all spans");
            assert_eq!(all_spans.len(), 2);
            let turn_two_spans =
                get_llm_usage_spans("session-1", Some("turn-2")).expect("load turn spans");
            assert_eq!(turn_two_spans.len(), 1);
            assert_eq!(turn_two_spans[0].completion_tokens, 40);

            let turn_one_attributions = get_tool_usage_attributions("session-1", Some("turn-1"))
                .expect("load turn attributions");
            assert_eq!(turn_one_attributions.len(), 1);
            assert_eq!(turn_one_attributions[0].tool_call_id, "call-1");

            let call_two_attributions = get_tool_usage_attributions_for_call("session-1", "call-2")
                .expect("load call attributions");
            assert_eq!(call_two_attributions.len(), 1);
            assert_eq!(call_two_attributions[0].turn_id, "turn-2");
        });
    }
}
