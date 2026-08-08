//! Param-extraction helpers shared by every action handler.
//!
//! Pulled out of the dispatch file so each handler reads a flat list of
//! `optional_*` calls instead of repeating the same `Value` ceremony.
//!
//! The work-item helpers (`optional_todos`, `optional_schedule`,
//! `orchestrator_overrides_from_params`) left with the duplicate CRUD
//! surface (Orgtrack migration Phase 8) — work-item creation params,
//! including the retired cron schedule entry point, now live only on
//! `manage_work_item`.

use serde_json::Value;

/// Extract an optional array of strings from params.
pub(super) fn optional_string_array(params: &Value, key: &str) -> Option<Vec<String>> {
    params.get(key).and_then(|val| {
        val.as_array().map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(String::from))
                .collect()
        })
    })
}
