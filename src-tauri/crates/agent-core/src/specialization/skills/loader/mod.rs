//! Skills loader for the agent.
//!
//! Skills are markdown files (`SKILL.md`) with optional YAML frontmatter
//! that extend the agent's capabilities. They are progressively loaded:
//! a summary is included in the system prompt, and the full content
//! is loaded on demand when the agent reads the skill file.

pub mod bundled_files;
pub mod commands;
mod helpers;
mod scanner;
pub mod skill_env_storage;
pub mod source_dirs;
mod types;

// `loader::*` flat re-exports are needed because `generate_handler!` in
// `src/commands/handler_list.inc` resolves Tauri commands at the
// `agent_core::skills::loader::<name>` path (function + matching
// `__cmd__<name>`). Anything that is NOT a Tauri command and is not used
// flat by callers is reached via the deeper submodule (`bundled_files::*`,
// `commands::*`) — we keep those off the flat surface.
pub use bundled_files::{skills_read_files_batch, skills_write_files_batch};
pub use commands::{
    global_skills_dir, skills_create, skills_list, skills_move, skills_read, skills_toggle,
    skills_update, skills_validate_name,
};
pub use scanner::SkillsLoader;
pub use skill_env_storage::load_and_apply_skill_env;
pub use types::{DescriptionQuality, SkillInfo, SkillListingEntry};

// Re-export Tauri command handler items so `generate_handler!` can find them
// at the `loader::` path (it looks for `__cmd__*` siblings of the function).
pub use bundled_files::{__cmd__skills_read_files_batch, __cmd__skills_write_files_batch};
pub use commands::{
    __cmd__skills_create, __cmd__skills_list, __cmd__skills_move, __cmd__skills_read,
    __cmd__skills_toggle, __cmd__skills_update, __cmd__skills_validate_name,
};
