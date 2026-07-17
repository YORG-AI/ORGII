use orgtrack_core::sources::cursor_ide::history::CURSORIDE_SESSION_PREFIX;

use crate::agent_sessions::event_pipeline::types::SessionEvent;
use crate::agent_sessions::external_cli_adapter;

trait SessionProvider: Send + Sync {
    fn matches_session(&self, session_id: &str) -> bool;

    fn skips_event_cache_save(&self, _session_id: &str) -> bool {
        false
    }

    fn load_history_events(&self, _session_id: &str) -> Result<Vec<SessionEvent>, String> {
        Ok(Vec::new())
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

static PROVIDERS: &[&(dyn SessionProvider + Sync)] = &[&CursorIdeProvider];

pub(crate) fn skips_event_cache_save(session_id: &str) -> bool {
    external_cli_adapter::adapter_for_imported_session(session_id).is_some()
        || PROVIDERS.iter().any(|provider| {
            provider.matches_session(session_id) && provider.skips_event_cache_save(session_id)
        })
}

pub(crate) fn load_history_events(session_id: &str) -> Result<Vec<SessionEvent>, String> {
    if let Some(adapter) = external_cli_adapter::adapter_for_imported_session(session_id) {
        return adapter.load_history_events(session_id);
    }

    let Some(provider) = PROVIDERS
        .iter()
        .find(|provider| provider.matches_session(session_id))
    else {
        return Ok(Vec::new());
    };
    provider.load_history_events(session_id)
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
