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
pub mod codex_app_server;
pub mod copilot;
pub mod cursor;
pub mod kiro;
pub mod opencode;

#[cfg(test)]
#[path = "tests/parser_integration_tests.rs"]
mod parser_integration_tests;

use std::collections::{HashSet, VecDeque};

use core_types::activity::ActivityChunk;
use types::TokenUsage;

const CODEX_RECONNECTING_PREFIX: &str = "Reconnecting...";
const MAX_CLI_ERROR_IDENTITIES_PER_TURN: usize = 32;

#[derive(Default)]
pub(super) struct BoundedCliErrorDeduper {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl BoundedCliErrorDeduper {
    pub(super) fn admit(&mut self, message: String) -> Option<String> {
        if self.seen.contains(&message) {
            return None;
        }

        while self.seen.len() >= MAX_CLI_ERROR_IDENTITIES_PER_TURN {
            let Some(oldest) = self.order.pop_front() else {
                self.seen.clear();
                break;
            };
            self.seen.remove(&oldest);
        }

        self.seen.insert(message.clone());
        self.order.push_back(message.clone());
        Some(message)
    }
}

/// Codex emits one top-level `error` event for every transport retry before
/// emitting the final failure. Retry notices are progress, not independent
/// user-visible errors.
pub(crate) fn is_codex_retry_notice(message: &str) -> bool {
    message
        .trim_start()
        .get(..CODEX_RECONNECTING_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(CODEX_RECONNECTING_PREFIX))
}

/// Unknown custom models produce this non-fatal notice before the request
/// starts. Codex explicitly falls back and keeps running, so it is never the
/// reason a session failed — both the structured parser and the stderr
/// fallback summariser must drop it, or the same benign line reappears as the
/// persisted failure message.
pub(crate) fn is_codex_fallback_metadata_notice(message: &str) -> bool {
    message.contains("Model metadata for") && message.contains("Defaulting to fallback metadata")
}

/// Remove retry wrappers and volatile request identifiers so the same upstream
/// failure has a stable identity across attempts.
pub(crate) fn canonicalize_cli_error_message(message: &str) -> String {
    let mut normalized = message.trim();
    if is_codex_retry_notice(normalized) {
        if let Some(open_paren) = normalized.find('(') {
            normalized = normalized[open_paren + 1..]
                .strip_suffix(')')
                .unwrap_or(&normalized[open_paren + 1..]);
        }
    }

    let lower = normalized.to_ascii_lowercase();
    if let Some(cutoff) = [
        ", cf-ray:",
        ", request id:",
        ", request-id:",
        ", request_id:",
        ", x-request-id:",
    ]
    .iter()
    .filter_map(|marker| lower.find(marker))
    .min()
    {
        normalized = &normalized[..cutoff];
    }

    normalized.trim().to_string()
}

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

#[cfg(test)]
mod bounded_error_deduper_tests {
    use super::{BoundedCliErrorDeduper, MAX_CLI_ERROR_IDENTITIES_PER_TURN};

    #[test]
    fn error_identity_retention_evicts_oldest_without_dropping_new_errors() {
        let mut deduper = BoundedCliErrorDeduper::default();
        for index in 0..MAX_CLI_ERROR_IDENTITIES_PER_TURN {
            assert!(deduper.admit(format!("error-{index}")).is_some());
        }

        assert!(deduper.admit("error-0".to_string()).is_none());
        assert!(deduper.admit("one-too-many".to_string()).is_some());
        assert!(deduper.admit("error-0".to_string()).is_some());
        assert_eq!(deduper.seen.len(), MAX_CLI_ERROR_IDENTITIES_PER_TURN);
        assert_eq!(deduper.order.len(), MAX_CLI_ERROR_IDENTITIES_PER_TURN);
    }
}
