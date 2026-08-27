//! Stable Tauri façade for Key Vault CRUD commands.
//!
//! Implementation details are split by responsibility while every command,
//! DTO, constant, and helper keeps its established commands::crud export.

mod clipboard;
mod dtos;
mod models;
mod projections;
mod read_delete;
mod save;

pub use clipboard::clipboard_write_text;
pub use dtos::{
    DefaultVariantInfo, FullKeyResponse, KeyInfo, ModelAliasInfo, ModelVariantInfo, SaveKeyRequest,
};
pub use models::{
    model_supports_output_config_effort, CLAUDE_CODE_OAUTH_DEFAULT_ENABLED_MODELS,
    CLAUDE_CODE_OAUTH_MODELS, CODEX_OAUTH_DEFAULT_ENABLED_MODELS, CODEX_OAUTH_MODELS,
};
pub use read_delete::{
    delete_key, delete_key_by_id, get_all_keys_for_agent, get_env_for_agent, get_full_key, get_key,
    get_key_by_id, list_keys, update_key_health,
};
pub use save::save_key;

pub(super) use models::oauth_model_metadata;
pub(super) use projections::key_info_from_entry;

// Re-exported here so consumers keep the established key_vault::commands path
// (matching model_supports_output_config_effort).
pub use crate::key_store::{is_claude_official_oauth_token, is_official_anthropic_endpoint};
