//! Provenance indexing for authorized cloud collaboration replays.
//!
//! The cloud adapter reads the existing local event cache, remaps only paths
//! that can be proven to belong to the viewer's checkout, and persists the
//! same provider-neutral resource facts as native and imported sessions.

use std::path::{Component, Path};

use chrono::Utc;
use database::db::{begin_immediate, get_connection, with_sessions_writer};
use orgtrack_core::canonical::{
    AgentMetadata, AttributionPrecision, CollaborationSessionOrigin, SessionRecord,
    SOURCE_ORGII_CLOUD_REPLAY,
};
use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
use sha2::{Digest, Sha256};

use super::interaction_store::persist_cached_event_interactions_streaming;

const COLLABORATION_REPLAY_PARSER_VERSION: i64 = 2;

fn collaboration_replay_fingerprint(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

/// Build the local provenance read model for an authorized Team Session
/// replay. Transcript events stay in the existing event cache; Orgtrack only
/// receives privacy-filtered resource facts.
#[allow(clippy::too_many_arguments)]
pub(crate) fn index_collaboration_replay(
    local_session_id: &str,
    source_session_id: &str,
    title: &str,
    workspace_path: &str,
    source_workspace_path: Option<&str>,
    org_id: &str,
    session_row_id: &str,
    owner_member_id: &str,
    owner_display_name: &str,
) -> Result<usize, String> {
    for (field, value) in [
        ("localSessionId", local_session_id),
        ("sourceSessionId", source_session_id),
        ("workspacePath", workspace_path),
        ("orgId", org_id),
        ("sessionRowId", session_row_id),
        ("ownerMemberId", owner_member_id),
        ("ownerDisplayName", owner_display_name),
    ] {
        if value.trim().is_empty() {
            return Err(format!("{field} must not be empty"));
        }
    }

    let metadata = session_persistence::get_session_metadata(local_session_id)
        .map_err(|err| format!("Failed to load collaboration replay metadata: {err}"))?
        .ok_or_else(|| {
            "Collaboration replay is not present in the local event cache".to_string()
        })?;
    // Persist only a digest: the checkpoint changes with either checkout but
    // never retains the owner's absolute path.
    let event_count = metadata.event_count.to_string();
    let cached_at = metadata.cached_at.to_string();
    let fingerprint = collaboration_replay_fingerprint(&[
        &event_count,
        &cached_at,
        metadata.time_range_start.as_deref().unwrap_or_default(),
        metadata.time_range_end.as_deref().unwrap_or_default(),
        workspace_path,
        source_workspace_path.unwrap_or_default(),
        source_session_id,
        owner_member_id,
    ]);
    let session = SessionRecord {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        source: SOURCE_ORGII_CLOUD_REPLAY.to_string(),
        source_session_id: source_session_id.to_string(),
        session_id: local_session_id.to_string(),
        title: title.to_string(),
        status: Some("completed".to_string()),
        created_at: metadata.time_range_start.clone(),
        updated_at: metadata.time_range_end.clone(),
        completed_at: metadata.time_range_end.clone(),
        workspace_path: Some(workspace_path.to_string()),
        branch: None,
        parent_session_id: None,
        org_member_id: Some(owner_member_id.to_string()),
        collaboration_origin: Some(CollaborationSessionOrigin {
            org_id: org_id.to_string(),
            session_row_id: session_row_id.to_string(),
            source_session_id: source_session_id.to_string(),
            owner_member_id: owner_member_id.to_string(),
            owner_display_name: owner_display_name.to_string(),
        }),
        metadata: AgentMetadata {
            origin: Some(SOURCE_ORGII_CLOUD_REPLAY.to_string()),
            display_name: Some(owner_display_name.to_string()),
            ..AgentMetadata::default()
        },
    };

    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let tx = begin_immediate(&conn).map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&tx);
        store.upsert_session(&session)?;
        if store.interaction_import_is_current(
            SOURCE_ORGII_CLOUD_REPLAY,
            local_session_id,
            &fingerprint,
            COLLABORATION_REPLAY_PARSER_VERSION,
        )? {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(0);
        }

        store
            .delete_reconciled_resource_interactions(SOURCE_ORGII_CLOUD_REPLAY, local_session_id)?;

        let persisted = persist_cached_event_interactions_streaming(
            &tx,
            &store,
            SOURCE_ORGII_CLOUD_REPLAY,
            Some(source_session_id),
            local_session_id,
            Some(owner_member_id),
            workspace_path,
            AttributionPrecision::Exact,
            |file_path| {
                remap_collaboration_file_path(file_path, source_workspace_path, workspace_path)
            },
        )?;
        store.mark_interaction_imported(
            SOURCE_ORGII_CLOUD_REPLAY,
            local_session_id,
            &fingerprint,
            COLLABORATION_REPLAY_PARSER_VERSION,
            &Utc::now().to_rfc3339(),
        )?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(persisted)
    })
}

pub(crate) fn delete_collaboration_replay(local_session_id: &str) -> Result<(), String> {
    if local_session_id.trim().is_empty() {
        return Err("localSessionId must not be empty".to_string());
    }
    with_sessions_writer(|| {
        let conn = get_connection().map_err(|err| err.to_string())?;
        SqliteRecordStore::new(&conn)
            .delete_collaboration_session_provenance(SOURCE_ORGII_CLOUD_REPLAY, local_session_id)
    })
}

fn remap_collaboration_file_path(
    file_path: &str,
    source_workspace_path: Option<&str>,
    workspace_path: &str,
) -> Option<String> {
    let file = Path::new(file_path);
    if !file.is_absolute() {
        let mut depth = 0_i32;
        for component in file.components() {
            match component {
                Component::Normal(_) => depth += 1,
                Component::ParentDir => {
                    depth -= 1;
                    if depth < 0 {
                        return None;
                    }
                }
                Component::CurDir => {}
                Component::RootDir | Component::Prefix(_) => return None,
            }
        }
        return (!file_path.trim().is_empty()).then(|| file_path.to_string());
    }

    let local_workspace = Path::new(workspace_path);
    if file.starts_with(local_workspace) {
        return Some(file.to_string_lossy().into_owned());
    }
    let source_workspace = Path::new(source_workspace_path?.trim());
    if !source_workspace.is_absolute() {
        return None;
    }
    let relative = file.strip_prefix(source_workspace).ok()?;
    Some(
        local_workspace
            .join(relative)
            .to_string_lossy()
            .into_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_remap_only_when_repository_identity_is_provable() {
        assert_eq!(
            remap_collaboration_file_path(
                "/owner/ORG2/src/main.ts",
                Some("/owner/ORG2"),
                "/viewer/ORG2"
            )
            .as_deref(),
            Some("/viewer/ORG2/src/main.ts")
        );
        assert_eq!(
            remap_collaboration_file_path("src/main.ts", None, "/viewer/ORG2").as_deref(),
            Some("src/main.ts")
        );
        assert!(remap_collaboration_file_path(
            "/owner/other/secret.txt",
            Some("/owner/ORG2"),
            "/viewer/ORG2"
        )
        .is_none());
        assert!(remap_collaboration_file_path(
            "../outside.txt",
            Some("/owner/ORG2"),
            "/viewer/ORG2"
        )
        .is_none());
    }

    #[test]
    fn checkpoint_is_private_and_unambiguous() {
        let owner_path = "/owner/private/ORG2";
        let fingerprint = collaboration_replay_fingerprint(&["12", owner_path, "session"]);

        assert_eq!(fingerprint.len(), 64);
        assert!(!fingerprint.contains(owner_path));
        assert_ne!(
            collaboration_replay_fingerprint(&["a:b", "c"]),
            collaboration_replay_fingerprint(&["a", "b:c"])
        );
    }
}
