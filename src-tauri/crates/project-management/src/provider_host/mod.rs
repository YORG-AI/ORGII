//! Provider capability profiles and the bundled registry
//! (`orgtrack/v1` §15, frozen decisions §5).
//!
//! Three profiles, contracts never mixed:
//! - **Planning** — WorkItem projection/sync. Implemented today by the
//!   pluggable sync framework (`crate::sync::adapter::SyncAdapter` +
//!   `AdapterDescriptor` are the planning-profile host interfaces; the
//!   Phase 8 rename aligns the words, this module aligns the model).
//! - **Execution** — starts/attaches/cancels agent sessions. `org2` is
//!   the bundled implementation; the underlying harness (claude_code,
//!   codex_app, …) is session METADATA, never the provider id.
//! - **Provenance** — resolves SessionRefs to metadata/links/replay.
//!   `org2` resolves its own sessions against the local EventStore;
//!   external CLI providers are `reference-only`: they validate opaque
//!   ids and offer metadata/links, no transcript, no replay.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderProfile {
    Planning,
    Execution,
    Provenance,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    pub id: String,
    pub profiles: &'static [ProviderProfile],
    /// Provenance depth: `true` = validates ids + metadata/links only.
    pub reference_only: bool,
    pub bundled: bool,
}

/// Canonical external provenance provider ids — the importer-side source
/// namespace frozen in decisions §5 (hook short names like `claude` /
/// `codex` map onto these and never appear on the wire).
pub const EXTERNAL_PROVENANCE_PROVIDERS: &[&str] = &[
    "claude_code",
    "codex_app",
    "cursor_ide",
    "cursor_cli",
    "opencode",
    "cline",
    "copilot",
    "kimi",
    "qwen_code",
    "droid",
    "antigravity",
    "zcode",
    "warp",
    "trae",
    "qoder",
    "windsurf",
];

/// The full provider registry: the bundled `org2` runtime provider, the
/// planning adapters currently registered with the sync framework, and
/// the reference-only external provenance providers.
pub fn registered_providers() -> Vec<ProviderDescriptor> {
    let mut providers = vec![ProviderDescriptor {
        id: "org2".to_string(),
        profiles: &[ProviderProfile::Execution, ProviderProfile::Provenance],
        reference_only: false,
        bundled: true,
    }];
    for descriptor in crate::sync::adapters::list_descriptors() {
        providers.push(ProviderDescriptor {
            id: descriptor.id,
            profiles: &[ProviderProfile::Planning],
            reference_only: false,
            bundled: false,
        });
    }
    for id in EXTERNAL_PROVENANCE_PROVIDERS {
        providers.push(ProviderDescriptor {
            id: (*id).to_string(),
            profiles: &[ProviderProfile::Provenance],
            reference_only: true,
            bundled: false,
        });
    }
    providers
}

/// Reference-only SessionRef validation (§15.6): the provider must be a
/// registered provenance provider and the opaque id non-empty. This is
/// the whole contract for reference-only providers — no transcript
/// fetch, no liveness probe.
pub fn validate_session_ref(provider: &str, external_id: &str) -> Result<(), String> {
    if external_id.trim().is_empty() {
        return Err("session ref external id must not be empty".to_string());
    }
    let known = registered_providers()
        .into_iter()
        .any(|p| p.id == provider && p.profiles.contains(&ProviderProfile::Provenance));
    if !known {
        return Err(format!(
            "'{provider}' is not a registered provenance provider (hook short names like 'claude'/'codex' map to canonical ids like 'claude_code'/'codex_app')"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn org2_is_the_bundled_execution_and_provenance_provider() {
        let providers = registered_providers();
        let org2 = providers.iter().find(|p| p.id == "org2").expect("org2");
        assert!(org2.bundled);
        assert!(org2.profiles.contains(&ProviderProfile::Execution));
        assert!(org2.profiles.contains(&ProviderProfile::Provenance));
        assert!(!org2.reference_only);
    }

    #[test]
    fn planning_adapters_surface_with_the_planning_profile_only() {
        let providers = registered_providers();
        let github = providers.iter().find(|p| p.id == "github").expect("github");
        assert_eq!(github.profiles, &[ProviderProfile::Planning]);
        let linear = providers.iter().find(|p| p.id == "linear").expect("linear");
        assert_eq!(linear.profiles, &[ProviderProfile::Planning]);
    }

    #[test]
    fn external_cli_providers_are_reference_only_provenance() {
        let providers = registered_providers();
        let claude = providers
            .iter()
            .find(|p| p.id == "claude_code")
            .expect("claude_code");
        assert!(claude.reference_only);
        assert_eq!(claude.profiles, &[ProviderProfile::Provenance]);
    }

    #[test]
    fn session_ref_validation_enforces_the_canonical_namespace() {
        assert!(validate_session_ref("claude_code", "session_abc").is_ok());
        assert!(validate_session_ref("org2", "session_abc").is_ok());
        // Hook short names are not wire ids.
        assert!(validate_session_ref("claude", "session_abc").is_err());
        // Planning-only providers own no sessions.
        assert!(validate_session_ref("linear", "session_abc").is_err());
        assert!(validate_session_ref("claude_code", "  ").is_err());
    }
}
