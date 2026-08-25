//! Durable provider-neutral local execution state for canonical conversations.
//!
//! The module owns one SQLite state machine keyed by
//! `(executor_scope, conversation_root_key)`. Import surfaces, Work Items,
//! Cloud transports, and Team Chat are adapters outside this boundary.

mod commands;
mod schema;
mod store;
mod types;

pub use commands::*;
pub(crate) use schema::init_schema;
pub use types::*;

#[cfg(test)]
mod tests;
