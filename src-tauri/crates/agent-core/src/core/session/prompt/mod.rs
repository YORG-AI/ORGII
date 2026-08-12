//! System prompt construction pipeline.
//!
//! - [`builder`]: `build_unified_system_prompt` — assembles the full system prompt
//! - [`sections`]: Individual prompt sections (identity, tools, rules, etc.)
//! - [`helpers`]: Pure utility functions (text truncation, conventions loading)
//! - [`ide_context`]: IDE state formatter (open files, git, linter)

pub mod builder;
pub(crate) mod cache;
pub(crate) mod gui_control_retrieval;
pub(crate) mod helpers;
pub mod ide_context;
pub(crate) mod registry;
pub(crate) mod section_builders;
pub(crate) mod sections;

/// Load the same layered workspace instructions used by the native harness.
/// External CLI adapters call this facade so provider fallback prompts and
/// native API providers cannot drift on AGENTS/CLAUDE/.orgii semantics.
pub fn load_workspace_instructions(workspace_path: &std::path::Path) -> Option<String> {
    helpers::load_conventions(workspace_path)
}

#[cfg(test)]
pub(crate) mod section_tests;
