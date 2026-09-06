//! Durable collaboration and metadata capabilities attached to Work Items.
//!
//! The module keeps Discussion, subscriptions, PR readiness, provider-event
//! delivery, and typed properties behind project-management persistence
//! boundaries instead of letting individual UI surfaces invent state.

mod commands;
mod discussion;
pub(crate) mod properties;
pub(crate) mod quick_actions;
pub(crate) mod readiness;
pub mod routine_webhook;
pub(crate) mod saved_views;
pub(crate) mod statuses;
mod store;
pub(crate) mod subscriptions;
mod types;

pub use commands::*;
pub(crate) use discussion::{
    post_child_terminal_system_comment_in_transaction, ChildTerminalSystemComment,
};
pub use quick_actions::{InvokeQuickActionRequest, QuickAction, UpsertQuickActionRequest};
pub use saved_views::{SavedView, UpsertSavedViewRequest};
pub use statuses::{
    find_active_status_definition, render_status_catalog, StatusDefinition,
    UpsertStatusDefinitionRequest, STATUS_CATALOG_BRIEF_CAP, STATUS_CATEGORIES,
};
pub use types::*;

#[cfg(test)]
mod tests;
