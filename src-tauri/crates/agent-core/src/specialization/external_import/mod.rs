//! External agent artifact auto-import.
//!
//! Detects rule / skill / agent-definition artifacts authored for other
//! coding agents (Cursor IDE, Claude Code, Codex, GitHub
//! Copilot, Kiro) on the user's machine and offers to port them into
//! ORGII's first-class primitives (`Policy`, `Skill`, `AgentDefinition`).
//!
//! Sources covered:
//!   - Rule-flavored — Cursor `.mdc` rules, Claude Code `CLAUDE.md`,
//!     Copilot instructions, Kiro steering docs (→ `Policy`).
//!   - Skill-flavored — Claude Code `~/.claude/skills/<name>/SKILL.md`
//!     and `~/.claude/commands/*.md`, plus Cursor IDE
//!     `<repo>/.cursor/skills/<name>/SKILL.md` and
//!     `~/.cursor/skills-cursor/<name>/SKILL.md` (→ `Skill`).
//!   - Agent-flavored — Claude Code `~/.claude/agents/*.md`
//!     (→ `AgentDefinition`, routed through `AgentDefinitionsStore` so
//!     in-memory state is updated immediately).
//!
//! Design: `docs/agent/external-agent-auto-import--design.md`.

pub mod commands;
pub mod detect;
pub mod types;

// Wildcard re-export needed: `#[tauri::command]` generates hidden
// `__cmd__*` items that the handler-list macro must see at the
// `specialization::external_import` path.
pub use commands::*;
pub use types::{
    DetectedItem, FidelityWarning, ImportReport, ImportSelection, ItemKind, ItemPreview,
    SourceAgent, SourceScope,
};

#[cfg(test)]
mod tests;
