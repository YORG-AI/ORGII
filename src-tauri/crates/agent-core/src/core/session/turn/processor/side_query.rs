//! Side-query provider acquisition.
//!
//! Skill/memory prefetch and compaction run auxiliary LLM calls. Depending on
//! the provider's [`SideQueryExecution`] mode these either share the turn's
//! session or get an isolated provider instance.

use std::sync::Arc;

use crate::providers::traits::{LLMProvider, SideQueryExecution};

use super::UnifiedMessageProcessor;

impl UnifiedMessageProcessor {
    pub(super) async fn side_query_provider(
        &self,
        session_id: &str,
        label: &str,
    ) -> Result<Arc<dyn LLMProvider>, String> {
        match self.runtime.provider.side_query_execution() {
            SideQueryExecution::SharedSession => {
                self.runtime.provider.set_session_context(session_id);
                Ok(self.runtime.provider.clone())
            }
            SideQueryExecution::IsolatedSession => {
                let workspace = self.runtime.workspace_state.read().clone();
                let provider =
                    crate::providers::factory::create_provider_with_native_harness_preflight(
                        &self.runtime.model,
                        self.runtime.account_id.as_deref(),
                        &self.runtime.resolved.reliability,
                        self.runtime.native_harness_type,
                        Some(workspace),
                    )
                    .await
                    .map_err(|err| {
                        format!("Failed to create isolated side-query provider: {err}")
                    })?;
                let provider: Arc<dyn LLMProvider> = Arc::from(provider);
                provider.set_session_context(&format!("{session_id}:{label}"));
                Ok(provider)
            }
        }
    }
}
