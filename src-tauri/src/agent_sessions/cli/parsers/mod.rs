//! CLI Agent Output Parsers
//!
//! Parses output from external CLI agents (Cursor, Claude Code, Codex,
//! Kiro, Copilot) and normalizes events into `ActivityChunk` objects that the
//! frontend can render.
//!
//! ## Architecture
//!
//! Most agents output JSONL/stream-json on stdout. The parsing pipeline:
//!
//! ```text
//! CLI stdout (per-agent format)
//!   → Parser (per-agent, implements CliAgentParser trait)
//!   → ActivityChunk (Cursor-normalized format)
//!   → WebSocket broadcast → frontend normalizeChunk() → UI
//! ```
//!
//! Exception: Copilot uses ACP (Agent Client Protocol) — bidirectional
//! JSON-RPC over stdin/stdout. See `copilot::run_acp_protocol()`.
//!
//! All tool names/args/results are normalized to Cursor's vocabulary:
//! - Shell, Edit, Read, Grep, Glob, UpdateTodos, etc.
//!
//! ## Alias Map
//!
//! The `alias_map` module provides dual canonical names for CLI tool aliases:
//! - `storage`: Fine-grained canonical name for database storage
//! - `ui`: Coarse canonical name for UI component lookup

// Shared utilities
pub mod alias_map;
pub mod normalizer;
pub mod types;

// Per-agent parsers
pub mod acp_common;
pub mod antigravity;
pub mod claude_code;
pub mod codex;
pub mod copilot;
pub mod cursor;
pub mod kiro;
pub mod opencode;

#[cfg(test)]
#[path = "tests/parser_integration_tests.rs"]
mod parser_integration_tests;

use core_types::activity::ActivityChunk;
use types::TokenUsage;

/// Trait for parsing a CLI agent's stdout line by line.
pub trait CliAgentParser: Send {
    /// Parse a single line from the CLI's stdout.
    /// Returns zero or more ActivityChunks (some lines produce no events).
    fn parse_line(&mut self, line: &str) -> Vec<ActivityChunk>;

    /// Called when the CLI process exits.
    /// Emits final events (session_end, etc.).
    fn on_exit(&mut self, exit_code: i32) -> Vec<ActivityChunk>;

    /// Get accumulated token usage (if the agent reports it).
    fn token_usage(&self) -> Option<TokenUsage>;

    /// Get the CLI agent's own session/conversation ID for resume support.
    /// Returns None if the agent doesn't report one or doesn't support resume.
    fn cli_session_id(&self) -> Option<String> {
        None
    }
}
