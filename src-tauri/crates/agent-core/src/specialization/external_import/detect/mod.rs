//! Detector pipeline for the external-import wizard.
//!
//! Phase 1 covered policy-flavored sources (rule files). Phase 2 adds
//! Skill and AgentDefinition sources from Claude Code's standard
//! layout (`~/.claude/agents/*.md`, `~/.claude/commands/*.md`,
//! `~/.claude/skills/<name>/SKILL.md`, plus the same paths under
//! `<repo>/.claude/`). Phase 3 adds Cursor IDE skill bundles from
//! `<repo>/.cursor/skills/<name>/SKILL.md` and the user-global
//! `~/.cursor/skills-cursor/<name>/SKILL.md`. Phase 4 adds MCP server
//! config detection from external `mcpServers` JSON files.
//!
//! Each detector is a small pure function: given a directory + scope,
//! return `DetectedItem`s. We never error on a single malformed file —
//! broken frontmatter becomes a `FidelityWarning::FrontmatterParseError`
//! and the body is still offered for import.

use std::path::Path;

mod claude_code;
mod codex;
mod copilot;
mod cursor;
mod helpers;
mod kiro;
mod mcp;
mod vendor_agents;

use super::types::DetectedItem;

/// Top-level detector. Runs every source for one destination section and
/// concatenates the results. `None` scans user-global sources for the Global
/// section; `Some(repo)` scans repo-local sources for that repo's section.
/// Sources that produce zero items are silently omitted.
pub fn detect_all(repo_path: Option<&Path>) -> Vec<DetectedItem> {
    let mut out = Vec::new();

    out.extend(cursor::detect_cursor_rules(repo_path));
    out.extend(claude_code::detect_claude_code_memory(repo_path));
    out.extend(codex::detect_codex_agents_md(repo_path));
    out.extend(copilot::detect_copilot_instructions(repo_path));
    out.extend(kiro::detect_kiro_steering(repo_path));

    out.extend(claude_code::detect_claude_code_agents(repo_path));
    out.extend(cursor::detect_cursor_agents(repo_path));
    out.extend(codex::detect_codex_agents(repo_path));
    out.extend(copilot::detect_copilot_agents(repo_path));
    out.extend(claude_code::detect_claude_code_skills(repo_path));
    out.extend(cursor::detect_cursor_skills(repo_path));
    out.extend(mcp::detect_mcp_servers(repo_path));

    out
}
