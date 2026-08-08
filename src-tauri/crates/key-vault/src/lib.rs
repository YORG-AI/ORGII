//! Key vault: LLM provider keys, validation, and storage
//!
//! Responsibilities:
//! - Persist keys and metadata in `~/.orgii/credentials.json` (see [`key_store`])
//! - Validate keys against provider APIs (CLI agents and direct API providers)
//! - Auto-detect keys from local config and environment
//!
//! Provider validation includes, among others:
//! - Copilot: GitHub PAT + quota
//! - Cursor: CLI-based checks + quota
//! - OpenAI / Anthropic / Google: API key checks + model listing
//! - Codex: OAuth or API key
//! - Kiro: OAuth (Keychain / Keyring / SQLite)
//!
//! Originated as a Rust port of legacy Python `orgii_shared.validation` and
//! `orgii_shared.credentials` modules.

pub mod auto_detect;
pub mod commands;
pub mod e2e_guard;
pub mod key_extractor;
pub mod key_store;
pub mod provider_config;
pub mod providers;
pub mod quota_runtime;
#[cfg(test)]
pub(crate) mod test_support;
pub mod types;

// Re-export providers at key_vault:: level for internal compatibility
pub use providers::anthropic;
pub use providers::azure_openai;
pub use providers::codex;
pub use providers::copilot;
pub use providers::cursor;
pub use providers::google;
pub use providers::kiro;
pub use providers::openai;

// Re-export types only from auto_detect (not the function which is exposed via commands)
pub use auto_detect::{AutoDetectResult, DetectedKey, QuotaInfo as DetectedQuotaInfo};
pub use commands::*;
pub use key_store::*;
pub use provider_config::ProviderConfig;
pub use types::*;
