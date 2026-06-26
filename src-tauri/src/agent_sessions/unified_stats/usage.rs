//! Usage history query backed by the shared unified stats pipeline.
//!
//! Returns `UsageRecord` rows ready for the Dev Record > Sessions tab. This uses
//! the same `list_all_sessions` source aggregation as heatmap and session stats,
//! so imported orgtrack history sources do not drift into separate UI pipelines.

use database::db::get_connection;

use super::accounting::{session_usage_summary_with_fallback, usage_source_for};
use super::aggregation::list_all_sessions;
use super::types::{UsageFilter, UsageRecord};

pub fn query_usage_list(filter: Option<&UsageFilter>) -> Result<Vec<UsageRecord>, String> {
    let conn = get_connection().map_err(|err| format!("DB error: {err}"))?;
    let provider = filter.and_then(|filter| filter.provider.as_deref());
    let response = list_all_sessions(None)?;
    let mut results = Vec::new();

    for session in response.sessions {
        if !date_in_range(
            &session.created_at,
            filter.and_then(|filter| filter.start_date.as_deref()),
            filter.and_then(|filter| filter.end_date.as_deref()),
        ) {
            continue;
        }

        let provider_name = session_provider_name(&session);
        if provider.is_some_and(|expected| expected != provider_name) {
            continue;
        }

        let usage =
            session_usage_summary_with_fallback(&conn, &session.session_id, session.total_tokens)?;
        let source = usage_source_for(&session).as_str().to_string();
        results.push(UsageRecord {
            id: session.session_id,
            name: session.name,
            source,
            provider: provider_name,
            model: session.model.unwrap_or_else(|| "auto".to_string()),
            tokens: usage.total_tokens,
            cost: usage.cost_usd,
            status: session.status,
            created_at: session.created_at,
        });
    }

    results.sort_by(|record_a, record_b| record_b.created_at.cmp(&record_a.created_at));
    Ok(results)
}

fn session_provider_name(session: &super::types::SessionAggregateRecord) -> String {
    session
        .cli_agent_type
        .clone()
        .or_else(|| session.agent_display_name.clone())
        .unwrap_or_else(|| match session.category {
            super::types::SessionCategory::Cli => "unknown".to_string(),
            super::types::SessionCategory::Agent => "sde_agent".to_string(),
            super::types::SessionCategory::Os => "os_agent".to_string(),
        })
}

fn date_in_range(timestamp: &str, start_date: Option<&str>, end_date: Option<&str>) -> bool {
    let date = timestamp.get(0..10).unwrap_or(timestamp);
    if let Some(start_date) = start_date {
        if date < start_date {
            return false;
        }
    }
    if let Some(end_date) = end_date {
        if date > end_date {
            return false;
        }
    }
    true
}
