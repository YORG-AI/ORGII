//! Native transcript materialization for provider-neutral conversations.
//!
//! This crate consumes only [`conversation_portability::PortableConversation`]
//! content. It never reads source-provider credentials, configuration, indexes,
//! or native transcript files. Every materialization creates a new target
//! session and remains a candidate until a real CLI resume appends the first
//! real user turn and the caller explicitly accepts it.

mod error;
mod filesystem;
mod materializer;
mod native;
mod semantic;
mod types;

pub use error::*;
pub use materializer::{
    accept_native_resume, prepare_native_materialization, reject_native_materialization,
};
pub use types::*;

#[cfg(test)]
mod tests;
