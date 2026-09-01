//! Shared reader for CLI transcripts that persist Anthropic-style JSONL.
//!
//! OMP and Qoder CLI use different directory layouts but the same core
//! `{message:{role,content}}` representation. Keeping discovery configurable
//! and conversion shared prevents their replay semantics from drifting.

mod cache;
mod config;
mod discovery;
mod meta;
mod meta_state;
mod model;
mod tool_call;
mod transcript;
mod value;

pub use cache::{list_recent_paths, list_sessions_paginated, load_session};
pub use config::AnthropicJsonlSource;
