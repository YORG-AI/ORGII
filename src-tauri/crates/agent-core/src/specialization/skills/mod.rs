//! Agent skills system.
//!
//! This module handles skill discovery, loading, and management:
//! - [`loader`]: Scan and load SKILL.md files from workspace and global dirs
//! - [`market`]: Skills Hub (ClawHub) integration for installing skills
//! - [`builtin`]: Built-in skills embedded in the binary (create-skill, create-rule)
//! - [`prefetch`]: Skill discovery prefetch via side-query

pub mod builtin;
pub mod loader;
pub mod market;
pub mod prefetch;
pub mod provenance;
pub mod work_run_manifest;
