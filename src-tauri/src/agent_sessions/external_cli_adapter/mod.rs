pub mod opencode;

pub trait ExternalCliAdapter: Send + Sync {
    fn source(&self) -> &'static str;
    fn cli_agent_type(&self) -> &'static str;
    fn imported_session_prefix(&self) -> &'static str;
    fn matches_imported_session(&self, session_id: &str) -> bool;
    fn imported_session_id_from_native(&self, native_session_id: &str) -> String;
    fn native_session_id_from_imported<'a>(&self, imported_session_id: &'a str) -> Option<&'a str>;
    fn resolve_subagent_prompt(&self, child_session_id: &str) -> Option<String>;
    fn imported_parent_session_id(
        &self,
        managed_parent_session_id: &str,
    ) -> Result<Option<String>, String>;
}

static ADAPTERS: &[&(dyn ExternalCliAdapter + Sync)] = &[&opencode::OPENCODE_ADAPTER];

pub fn adapter_for_imported_session(
    session_id: &str,
) -> Option<&'static (dyn ExternalCliAdapter + Sync)> {
    ADAPTERS
        .iter()
        .copied()
        .find(|adapter| adapter.matches_imported_session(session_id))
}

pub fn adapters() -> &'static [&'static (dyn ExternalCliAdapter + Sync)] {
    ADAPTERS
}
