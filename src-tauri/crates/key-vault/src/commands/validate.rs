//! Stable façade for Key Vault validation, quota, and OAuth catalog commands.
//!
//! Implementation details are split by responsibility while every command,
//! DTO, constant, and helper keeps its established commands::validate export.

mod discovery;
mod dispatch;
mod oauth;
mod opencode;
mod quota_dispatch;
mod quota_refresh;

pub use discovery::{
    auto_detect_key, cursor_list_models_native, extract_keys_from_text, get_cursor_cli_models,
};
pub use dispatch::{
    run_validate_key, test_model_availability, validate_key, validate_token_format, TestModelResult,
};
pub use oauth::{
    oauth_model_catalog, refresh_oauth_token, OAuthModelCatalogRequest, OAuthModelCatalogResponse,
    OAuthModelCatalogSource,
};
pub use opencode::{validate_opencode_key, OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL};
pub use quota_dispatch::fetch_key_quota;
pub use quota_refresh::{
    get_key_quota_refresh_status, invalidate_key_quota_runtime, key_quota_refresh_status,
    refresh_key_quota, KeyQuotaRefreshAttemptInfo, KeyQuotaRefreshStatusInfo,
};

// Only the `commands/tests` suite reaches this projection helper.
#[cfg(test)]
pub(super) use oauth::resolved_oauth_catalog;
pub(super) use quota_dispatch::key_can_refresh_quota;
pub(super) use quota_refresh::quota_credential_revision;

// Private helpers reached by `use super::*` from the shared test module below.
#[cfg(test)]
use dispatch::default_base_url_for_provider;
#[cfg(test)]
use oauth::is_oauth_discovery_auth_error;
#[cfg(test)]
use opencode::resolve_opencode_base_url;

#[cfg(test)]
#[path = "tests/validate_tests.rs"]
mod tests;
