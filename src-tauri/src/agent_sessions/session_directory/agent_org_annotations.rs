//! Bounded Agent Org metadata projection for already-selected sidebar rows.
//!
//! Session listing must never enumerate every historical org run just to
//! decorate a 10–50 row page. This module performs one exact `IN` query for
//! the root session IDs that survived the page query.

use std::collections::HashMap;

use agent_core::definitions::orgs::OrgDefinition;
use database::db::get_connection;
use rusqlite::{params_from_iter, types::Value as SqlValue};

use super::types::SessionAggregateRecord;

const AGENT_ORG_ICON_ID: &str = "network";

fn agent_org_display_name(org_id: &str, org_snapshot_json: Option<&str>) -> String {
    org_snapshot_json
        .and_then(|json| serde_json::from_str::<OrgDefinition>(json).ok())
        .map(|org| org.name)
        .unwrap_or_else(|| org_id.to_string())
}

pub(super) fn annotate_agent_org_root_rows(
    sessions: &mut [SessionAggregateRecord],
) -> Result<(), String> {
    if sessions.is_empty() {
        return Ok(());
    }
    let session_ids = sessions
        .iter()
        .map(|session| session.session_id.as_str())
        .collect::<Vec<_>>();
    let placeholders = (1..=session_ids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT root_session_id, org_id, org_snapshot_json
         FROM agent_org_runs
         WHERE root_session_id IN ({placeholders})
         ORDER BY updated_at DESC"
    );
    let conn =
        get_connection().map_err(|error| format!("Failed to open Agent Org database: {error}"))?;
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare Agent Org sidebar annotation: {error}"))?;
    let rows = statement
        .query_map(
            params_from_iter(
                session_ids
                    .into_iter()
                    .map(|session_id| SqlValue::from(session_id.to_string())),
            ),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .map_err(|error| format!("Failed to query Agent Org sidebar annotation: {error}"))?;

    // Preserve the historical list-runs/collect precedence if malformed old
    // data contains multiple runs for one root: older rows overwrite newer
    // rows because the query is ordered newest first.
    let mut annotations = HashMap::with_capacity(sessions.len());
    for row in rows {
        let (session_id, org_id, snapshot) =
            row.map_err(|error| format!("Failed to read Agent Org sidebar annotation: {error}"))?;
        let org_name = agent_org_display_name(&org_id, snapshot.as_deref());
        annotations.insert(session_id, (org_id, org_name));
    }

    for session in sessions {
        if let Some((org_id, org_name)) = annotations.get(&session.session_id) {
            session.agent_icon_id = Some(AGENT_ORG_ICON_ID.to_string());
            session.agent_org_id = Some(org_id.clone());
            session.agent_org_name = Some(org_name.clone());
        }
    }
    Ok(())
}
