//! The full merge path: load every requested backend, then filter, sort, and
//! paginate the combined rows.

use agent_core::session::persistence::{self as session_persistence, session_type};

use super::agent_org::annotate_agent_org_root_rows;
use super::filtering::apply_filters;
use super::imported_history::load_imported_history_sessions;
use super::native_page::plain_native_page;
use super::pagination::apply_pagination;
use super::sorting::apply_sorting;
use crate::agent_sessions::cli::persistence as cli_session_persistence;
use crate::agent_sessions::session_directory::conversion::{
    cli_session_to_aggregate_record, human_session_to_aggregate_record,
    os_session_to_aggregate_record, sde_session_to_aggregate_record, AgentMetadataResolver,
};
use crate::agent_sessions::session_directory::types::{
    SessionAggregateRecord, SessionFilter, SessionListResponse,
};

pub fn list_all_sessions(filter: Option<&SessionFilter>) -> Result<SessionListResponse, String> {
    if let Some(page) = plain_native_page(filter)? {
        return Ok(page);
    }
    let category_filter = filter.and_then(|filter| filter.category.as_deref());
    let wants_category = |category: &str| -> bool {
        category_filter
            .map(|raw| raw.split(',').map(str::trim).any(|value| value == category))
            .unwrap_or(true)
    };

    let load_cli = wants_category("cli");
    let load_external_history = wants_category("external_history")
        || filter
            .and_then(|filter| filter.external_history_source.as_ref())
            .is_some();
    let load_agent = wants_category("agent");
    let load_os = wants_category("os");
    let load_human = wants_category("human");
    let mut all_sessions: Vec<SessionAggregateRecord> = Vec::new();
    let mut metadata_resolver = (load_agent || load_os).then(AgentMetadataResolver::new);

    if load_cli {
        let cli_sessions = cli_session_persistence::list_sessions()
            .map_err(|err| format!("Failed to load CLI sessions: {}", err))?;
        all_sessions.reserve(cli_sessions.len());
        for session in cli_sessions {
            all_sessions.push(cli_session_to_aggregate_record(session));
        }
    }

    let include_external_history = filter
        .and_then(|filter| filter.include_external_history)
        .unwrap_or(true);
    if include_external_history && (load_cli || load_external_history) {
        match load_imported_history_sessions(filter) {
            Ok(imported_sessions) => all_sessions.extend(imported_sessions),
            Err(err) => {
                tracing::warn!(error = %err, "session_directory: failed to load orgtrack imported history sessions")
            }
        }
    }

    if load_agent {
        let sde_filter = agent_core::session::SessionListFilter {
            type_name: Some(session_type::CODING.to_string()),
            ..Default::default()
        };
        let sde_sessions = session_persistence::list_sessions(&sde_filter)
            .map_err(|err| format!("Failed to load SDE Agent sessions: {}", err))?;
        all_sessions.reserve(sde_sessions.len());
        let resolver = metadata_resolver
            .as_mut()
            .expect("agent metadata resolver initialized for agent sessions");
        for session in sde_sessions {
            all_sessions.push(sde_session_to_aggregate_record(session, resolver));
        }

        let org_member_filter = agent_core::session::SessionListFilter {
            type_name: Some(session_type::ORG_MEMBER.to_string()),
            ..Default::default()
        };
        let org_member_sessions = session_persistence::list_sessions(&org_member_filter)
            .map_err(|err| format!("Failed to load Agent Org member sessions: {}", err))?;
        all_sessions.reserve(org_member_sessions.len());
        let resolver = metadata_resolver
            .as_mut()
            .expect("agent metadata resolver initialized for org member sessions");
        for session in org_member_sessions {
            all_sessions.push(sde_session_to_aggregate_record(session, resolver));
        }

        annotate_agent_org_root_rows(&mut all_sessions)?;
    }

    if load_os {
        let os_filter = agent_core::session::SessionListFilter {
            type_name: Some(session_type::DESKTOP.to_string()),
            ..Default::default()
        };
        let os_sessions = session_persistence::list_sessions(&os_filter)
            .map_err(|err| format!("Failed to load OS Agent sessions: {}", err))?;
        all_sessions.reserve(os_sessions.len());
        let resolver = metadata_resolver
            .as_mut()
            .expect("agent metadata resolver initialized for OS sessions");
        for session in os_sessions {
            all_sessions.push(os_session_to_aggregate_record(session, resolver));
        }
    }
    if load_human {
        let human_filter = agent_core::session::SessionListFilter {
            type_name: Some(session_type::HUMAN.to_string()),
            ..Default::default()
        };
        let human_sessions = session_persistence::list_sessions(&human_filter)
            .map_err(|err| format!("Failed to load Human sessions: {err}"))?;
        all_sessions.extend(
            human_sessions
                .into_iter()
                .map(human_session_to_aggregate_record),
        );
    }
    // Apply filters
    if let Some(filter) = filter {
        apply_filters(&mut all_sessions, filter)?;
    }

    // Apply sorting
    apply_sorting(&mut all_sessions, filter);

    // Source-specific external pages already apply their source offset at load time.
    if let Some(filter) = filter {
        if filter.external_history_source.is_none() {
            apply_pagination(&mut all_sessions, filter);
        }
    }

    Ok(SessionListResponse {
        sessions: all_sessions,
    })
}
