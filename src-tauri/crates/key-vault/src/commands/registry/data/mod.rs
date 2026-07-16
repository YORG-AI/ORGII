//! Static registry data for CLI agents and API providers.
//!
//! Pure data — no Tauri dependency, no runtime I/O.
//! To add or remove an agent/provider, edit `cli_agents.rs` or `api_providers.rs`.

mod api_providers;
mod cli_agents;
mod env_config;
mod install_methods;
mod setup_methods;
mod types;

pub(super) use api_providers::api_provider_registry;
pub(super) use cli_agents::cli_agent_registry;
pub(super) use env_config::cli_env_config;
pub(crate) use install_methods::infer_install_method;
pub(super) use install_methods::{cli_install_methods, cli_uninstall_methods};
pub(super) use setup_methods::supported_setup_methods_for_agent;
pub(super) use types::{AcpSupport, CliConfigFormat, CliConfigPathKind};
