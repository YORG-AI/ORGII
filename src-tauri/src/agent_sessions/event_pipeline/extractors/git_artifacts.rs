//! Live event adapter for the canonical Git artifact parser.
//!
//! Parser behavior lives in provider-neutral `orgtrack_core` so live capture,
//! imported history, and `sessions.db` turn-index backfill cannot diverge.

pub use orgtrack_core::development_artifact::{parse_git_artifacts, GitArtifactParseInput};

#[cfg(test)]
#[path = "tests/git_artifacts_tests.rs"]
mod tests;
