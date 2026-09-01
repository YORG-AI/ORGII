//! Skills Hub — search and install skills from skills.sh.
//!
//! Provides Tauri commands to browse the skills.sh directory and install
//! skills into `~/.orgii/skills/`. Submodules:
//!
//! - `types`   — wire types shared by every endpoint
//! - `http`    — skills.sh URL constants + HTTP client builder
//! - `search`  — `skills_hub_search`
//! - `detail`  — `skills_hub_detail`
//! - `install` — `skills_hub_install` / `skills_hub_uninstall`
//! - `cache`   — per-skill on-disk detail cache
//! - `update`  — `skills_check_updates` / `skills_hub_update`

mod http;
mod types;

pub mod cache;
pub mod detail;
pub mod install;
pub mod search;
pub mod update;

// Tauri references each command through its deep submodule path
// (`market::search::skills_hub_search`, `market::cache::*`, …). The
// `types` and `http` submodules are reached only through `super::*`
// from sibling submodules, so they stay private.
