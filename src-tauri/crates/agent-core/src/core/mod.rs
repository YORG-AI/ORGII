//! Layer 1: Core agent logic.
//!
//! Configuration, LLM providers, model context management,
//! tool registry, turn execution, agent definitions,
//! user interaction, session management, and prompt construction.

pub mod config;
pub mod coordination;
pub mod definitions;
pub mod interaction;
#[path = "session/journey_lifecycle.rs"]
pub mod journey_lifecycle;
pub mod model_context;
pub mod providers;
pub mod session;
pub mod side_query;
pub mod tools;
pub mod turn_executor;
