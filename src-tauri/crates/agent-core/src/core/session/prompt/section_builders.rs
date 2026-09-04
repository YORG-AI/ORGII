//! Free functions that build prompt section strings.
//!
//! Called from `PromptSection` impls in `sections.rs`. All public items here
//! use `pub(super)` so they are only accessible within the `prompt` module.
//!
//! The builders are split across the `section_builders/` submodules below and
//! re-exported here, so `prompt::section_builders::<name>` keeps resolving for
//! every caller.

mod agent_org;
mod channel;
mod command_approval;
mod delegation;
mod mcp_instructions;
mod messaging;
mod model_identity;
mod project_environment;
mod rules;
mod sde_rules;
mod system_meta;
mod user_context;

pub(super) use system_meta::{build_function_result_clearing_section, build_system_meta_section};

pub(super) use sde_rules::sde_behavioral_rules;

pub(super) use channel::{build_channel_behavioral_rules, build_channel_environment};

pub(super) use project_environment::build_project_environment;

pub(super) use rules::build_rules_section;
// Only `prompt::section_tests` reaches this helper through the facade.
#[cfg(test)]
pub(super) use rules::cap_rule_content;

pub(super) use messaging::{
    build_atc_section, build_messaging_section, build_silent_replies_section,
};

pub(super) use delegation::{build_sub_agent_delegation_section, build_task_routing_section};

pub(super) use command_approval::build_command_approval_section;

pub use agent_org::build_agent_org_context_section;
pub(crate) use agent_org::build_agent_org_context_section_with_task_snapshot;

pub(super) use model_identity::{build_model_identity, build_runtime_line};

pub(super) use user_context::{format_user_presence, format_user_profile, user_profile_is_empty};

pub use user_context::format_user_presence_compact;

pub(super) use mcp_instructions::build_mcp_instructions_section;
