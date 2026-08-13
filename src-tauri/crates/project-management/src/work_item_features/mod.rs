//! Durable collaboration and metadata capabilities attached to Work Items.
//!
//! The module keeps Discussion, subscriptions, PR readiness, provider-event
//! delivery, and typed properties behind project-management persistence
//! boundaries instead of letting individual UI surfaces invent state.

mod commands;
mod discussion;
pub(crate) mod properties;
pub(crate) mod readiness;
pub mod routine_webhook;
mod store;
pub(crate) mod subscriptions;
mod types;

pub use commands::*;
pub use types::*;

#[cfg(test)]
mod tests;
