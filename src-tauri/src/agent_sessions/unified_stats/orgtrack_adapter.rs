use database::db::get_connection;
use orgtrack_core::canonical::{
    AgentMetadata, JourneyMetadata, SessionRecord, SOURCE_ORGII_CLI_SESSIONS,
    SOURCE_ORGII_RUST_AGENTS,
};
use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};

use super::types::{SessionAggregateRecord, SessionCategory};

fn explicit_journey_metadata(record: &SessionAggregateRecord) -> (Option<String>, Vec<String>) {
    if !matches!(
        record.category,
        SessionCategory::Agent | SessionCategory::Os
    ) {
        return (None, Vec::new());
    }

    match agent_core::session::persistence::get_explicit_journey_metadata(&record.session_id) {
        Ok(metadata) => explicit_journey_fields(metadata),
        Err(err) => {
            tracing::warn!(
                session_id = %record.session_id,
                error = %err,
                "[orgtrack] explicit Journey metadata unavailable; preserving historical unknown"
            );
            (None, Vec::new())
        }
    }
}

fn explicit_journey_fields(
    metadata: Option<agent_core::session::persistence::ExplicitJourneyMetadata>,
) -> (Option<String>, Vec<String>) {
    metadata
        .map(|metadata| (metadata.workspace_id, metadata.topic_tags))
        .unwrap_or_else(|| (None, Vec::new()))
}

pub fn upsert_aggregate_sessions(records: &[SessionAggregateRecord]) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }
    let conn = get_connection().map_err(|err| err.to_string())?;
    let store = SqliteRecordStore::new(&conn);
    for record in records {
        store.upsert_session(&aggregate_to_core_session(record))?;
    }
    Ok(())
}

fn aggregate_to_core_session(record: &SessionAggregateRecord) -> SessionRecord {
    let (workspace_id, topic_tags) = explicit_journey_metadata(record);
    let source = match record.category {
        SessionCategory::Cli => SOURCE_ORGII_CLI_SESSIONS,
        SessionCategory::Agent | SessionCategory::Os => SOURCE_ORGII_RUST_AGENTS,
    };
    SessionRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        source: source.to_string(),
        source_session_id: record.session_id.clone(),
        session_id: record.session_id.clone(),
        title: record.name.clone(),
        status: Some(record.status.clone()),
        created_at: Some(record.created_at.clone()),
        updated_at: Some(record.updated_at.clone()),
        completed_at: None,
        workspace_path: record
            .repo_path
            .clone()
            .or_else(|| record.worktree_path.clone()),
        branch: record
            .branch
            .clone()
            .or_else(|| record.worktree_branch.clone()),
        parent_session_id: record.parent_session_id.clone(),
        org_member_id: record.org_member_id.clone(),
        journey: JourneyMetadata {
            project_id: record.project_id.clone(),
            // Only an explicit producer may supply this identity. A path is
            // not an identity and is never converted into one here.
            workspace_id,
            work_item_id: record.work_item_id.clone(),
            agent_identity: record
                .agent_definition_id
                .clone()
                .or_else(|| record.cli_agent_type.clone()),
            agent_band: record.agent_role.clone(),
            // The persistence lookup above returns only launch-supplied tags.
            topic_tags,
        },
        metadata: AgentMetadata {
            dispatch_category: Some(dispatch_category_for(record.category).to_string()),
            rust_agent_type: rust_agent_type_for(record),
            cli_agent_type: record.cli_agent_type.clone(),
            agent_exec_mode: record.agent_exec_mode.clone(),
            provider_model_type: None,
            model: record.model.clone(),
            key_source: Some(record.key_source.to_string()),
            origin: Some(source.to_string()),
            display_name: record
                .agent_display_name
                .clone()
                .or_else(|| record.display_label.clone())
                .or_else(|| Some(record.name.clone())),
            parsed_categories: Default::default(),
        },
    }
}

fn dispatch_category_for(category: SessionCategory) -> &'static str {
    match category {
        SessionCategory::Cli => "cli_agent",
        SessionCategory::Agent | SessionCategory::Os => "rust_agent",
    }
}

fn rust_agent_type_for(record: &SessionAggregateRecord) -> Option<String> {
    match record.category {
        SessionCategory::Os => Some("os".to_string()),
        SessionCategory::Agent => {
            // A session id is an opaque identifier, not an agent identity.
            // Keep the legacy display field empty when no explicit identity
            // was supplied by the aggregate producer.
            None
        }
        SessionCategory::Cli => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_tags_pass_through_and_absence_stays_unknown() {
        assert_eq!(
            explicit_journey_fields(Some(
                agent_core::session::persistence::ExplicitJourneyMetadata {
                    workspace_id: Some("workspace-explicit".to_string()),
                    topic_tags: vec!["release".to_string()],
                },
            )),
            (
                Some("workspace-explicit".to_string()),
                vec!["release".to_string()]
            )
        );
        assert_eq!(explicit_journey_fields(None), (None, Vec::new()));
    }
}
