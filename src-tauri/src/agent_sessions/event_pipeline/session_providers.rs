use core_types::session::CLI_SESSION_PREFIX;
use orgtrack_core::sources::cursor_ide::history::CURSORIDE_SESSION_PREFIX;
use orgtrack_core::sources::imported_history::replay::ImportedHistorySourceId;

use crate::agent_sessions::external_cli_adapter;

trait SessionProvider: Send + Sync {
    fn matches_session(&self, session_id: &str) -> bool;

    fn skips_event_cache_save(&self, _session_id: &str) -> bool {
        false
    }

    fn subagent_prompt(&self, _child_session_id: &str) -> Option<String> {
        None
    }

    fn imported_parent_session_id(
        &self,
        _parent_session_id: &str,
    ) -> Result<Option<String>, String> {
        Ok(None)
    }
}

struct CursorIdeProvider;

impl SessionProvider for CursorIdeProvider {
    fn matches_session(&self, session_id: &str) -> bool {
        session_id.starts_with(CURSORIDE_SESSION_PREFIX)
    }

    fn skips_event_cache_save(&self, _session_id: &str) -> bool {
        true
    }
}

/// Managed CLI sessions (`cliagent-*`). Their transcript of record is never
/// the `events` table: chunks-mode sessions replay `code_session_chunks`,
/// native-mode sessions replay the CLI's own store via the imported-history
/// bounded replay bridge. Persisting the in-memory EventStore for them only
/// mirrors ephemeral turn state into SQLite, where rows would resurface as
/// duplicate bubbles on the next merge. Live streaming still renders from
/// in-memory snapshots (`es:changed`).
struct ManagedCliProvider;

impl SessionProvider for ManagedCliProvider {
    fn matches_session(&self, session_id: &str) -> bool {
        session_id.starts_with(CLI_SESSION_PREFIX)
    }

    fn skips_event_cache_save(&self, _session_id: &str) -> bool {
        true
    }
}

static PROVIDERS: &[&(dyn SessionProvider + Sync)] = &[&CursorIdeProvider, &ManagedCliProvider];

const COLLABORATION_SNAPSHOT_SESSION_PREFIX: &str = "imported-session-";

/// Whether a public session id is backed by the bounded replay pipeline.
///
/// Full-cache commands must fail closed for these ids. Their SQLite `events`
/// rows are either absent, a compact compatibility window, or an ORGII-owned
/// collaboration snapshot; none is permission to hydrate a whole transcript
/// through the native SDE cache path.
pub(crate) fn uses_bounded_replay(session_id: &str) -> bool {
    session_id.starts_with(CLI_SESSION_PREFIX)
        || (session_id.starts_with(COLLABORATION_SNAPSHOT_SESSION_PREFIX)
            && session_id.len() > COLLABORATION_SNAPSHOT_SESSION_PREFIX.len())
        || ImportedHistorySourceId::from_session_id(session_id).is_some()
}

pub(crate) fn reject_bounded_replay_full_load(session_id: &str) -> Result<(), String> {
    if uses_bounded_replay(session_id) {
        return Err(format!(
            "Session {session_id} uses bounded external replay; full SQLite hydration is disabled"
        ));
    }
    Ok(())
}

pub(crate) fn skips_event_cache_save(session_id: &str) -> bool {
    external_cli_adapter::adapter_for_imported_session(session_id).is_some()
        || PROVIDERS.iter().any(|provider| {
            provider.matches_session(session_id) && provider.skips_event_cache_save(session_id)
        })
}

pub(crate) fn subagent_prompt(child_session_id: &str) -> Option<String> {
    if let Some(adapter) = external_cli_adapter::adapter_for_imported_session(child_session_id) {
        return adapter.resolve_subagent_prompt(child_session_id);
    }

    PROVIDERS
        .iter()
        .find(|provider| provider.matches_session(child_session_id))
        .and_then(|provider| provider.subagent_prompt(child_session_id))
}

pub(crate) fn imported_parent_session_ids(parent_session_id: &str) -> Result<Vec<String>, String> {
    let mut session_ids = Vec::new();
    for adapter in external_cli_adapter::adapters() {
        if let Some(session_id) = adapter.imported_parent_session_id(parent_session_id)? {
            session_ids.push(session_id);
        }
    }
    for provider in PROVIDERS {
        if let Some(session_id) = provider.imported_parent_session_id(parent_session_id)? {
            session_ids.push(session_id);
        }
    }
    Ok(session_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registered_imported_source_is_fail_closed_for_full_hydration() {
        for source in ImportedHistorySourceId::ALL {
            let session_id = format!("{}fixture", source.descriptor().session_prefix);
            assert!(uses_bounded_replay(&session_id), "{}", source.as_str());
            assert!(reject_bounded_replay_full_load(&session_id).is_err());
        }
    }

    #[test]
    fn managed_and_collaboration_replay_are_bounded_but_native_sde_is_not() {
        assert!(uses_bounded_replay("cliagent-managed"));
        assert!(uses_bounded_replay("imported-session-cloud-copy"));
        assert!(!uses_bounded_replay("imported-session-"));
        assert!(!uses_bounded_replay("sdeagent-native"));
        assert!(!uses_bounded_replay("agentsession-cloud-fork"));
    }
}
