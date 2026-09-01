//! Codex CLI credential validation.
//!
//! Validates Codex credentials supporting:
//! - OAuth authentication (ChatGPT Plus/Pro subscription via chatgpt.com)
//! - API key authentication (OpenAI API key via api.openai.com)
//! - Quota fetching from ChatGPT usage API

mod app_server;
mod id_token;
mod json_rpc;
mod model_discovery;
mod process_tree;
mod quota;
mod validator;

pub use validator::CodexValidator;

#[cfg(test)]
#[path = "../tests/codex_tests.rs"]
mod tests;
