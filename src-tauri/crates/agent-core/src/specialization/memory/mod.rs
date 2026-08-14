//! Memory subsystem.
//!
//! # Architecture
//!
//! Three concentric scopes, each in its own subdirectory:
//!
//! - **`embeddings/`** — `EmbeddingProvider` trait + per-provider impls
//!   (OpenAI, Azure, Local, Auto). Shared infrastructure used by both
//!   `learnings` retrieval and `workspace_memory` consolidation.
//!
//! - **`learnings/`** — **L3 behavioral learnings** (SQLite-backed).
//!   Cross-session metacognitive insights ("I should X when Y"). Read by
//!   the prompt builder to inject into every turn.
//!
//! - **`consolidation/`** — **L3 consolidation engine**. Drains the L3
//!   `pending` queue and decides ADD/UPDATE/DELETE per row using the
//!   mem0 protocol. Background tick + manual trigger.
//!
//! - **`reflection/`** — **L3 post-session write paths**: LLM-extracted
//!   reflections (`reflection.rs`), pattern-mined active learning
//!   (`active_learning.rs`), and the persistent failure blacklist
//!   (`blacklist.rs`).
//!
//! - **`workspace_memory/`** — **L2 workspace-scoped memory**
//!   (`.orgii/workspace-memory/` markdown files). Self-contained ecosystem:
//!   scanner + manifest (`mod.rs`), prefetch on session-start
//!   (`prefetch.rs`), per-turn write extraction (`extract.rs`), offline
//!   markdown consolidation (`auto_dream.rs`), and the file-mutex lock
//!   (`lock.rs`) that protects auto-dream from running concurrently.
//!
//! - **`commands.rs`** — Tauri commands exposing learnings + workspace
//!   memory state to the frontend.
//!
//! L1 ("session-memory" running summary) lives in
//! `core/model_context/session_memory.rs` because it is part of the
//! per-turn context-window pipeline, not long-term memory.

pub mod background;
pub mod commands;
pub mod consolidation;
pub mod embeddings;
pub mod learnings;
pub mod reflection;
pub mod workspace_memory;

/// Shared parameters for forked memory agents (extract_memories, auto_dream).
/// Groups the common context to stay within clippy's argument-count limit.
pub struct MemoryAgentParams<'a> {
    pub messages: &'a [serde_json::Value],
    pub provider: std::sync::Arc<dyn crate::providers::traits::LLMProvider>,
    pub model: &'a str,
    pub workspace: &'a std::path::Path,
    pub parent_tools: std::sync::Arc<crate::tools::registry::ToolRegistry>,
    pub session_id: &'a str,
    pub definitions_store: Option<std::sync::Arc<crate::definitions::AgentDefinitionsStore>>,
    /// Coordinator-owned cancellation for this exact background job. Memory
    /// agent turn loops receive this flag so disabling/teardown stops provider
    /// retries and tool iterations instead of merely dropping the outer future.
    pub cancel_flag: Option<&'a std::sync::Arc<std::sync::atomic::AtomicBool>>,
}
