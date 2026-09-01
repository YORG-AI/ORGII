use std::path::PathBuf;

/// Config for the generic Anthropic/Claude-style JSONL transcript reader. Any
/// tool that writes newline-delimited JSON transcripts under a set of root
/// directories is a value of this struct — no bespoke parser required (see
/// `omp` / `qoder_cli`, and the CLI's declarative loader plugins).
///
/// The identity fields are `&'static str` because built-in sources are static;
/// dynamic hosts (the CLI's plugin loader) intern their ids once for the
/// process lifetime. `candidate_roots` is owned so it can be built from a
/// manifest, not only a function.
#[derive(Debug, Clone)]
pub struct AnthropicJsonlSource {
    pub source: &'static str,
    pub session_prefix: &'static str,
    pub provider_slug: &'static str,
    pub display_name: &'static str,
    pub parser_version: i64,
    pub candidate_roots: Vec<PathBuf>,
    pub exclude_subagent_dirs: bool,
    /// Exact directory depth for sources with a documented leaf shape.
    /// `Some(1)` accepts `<root>/<one-dir>/*.jsonl` and rejects both root
    /// files and deeper descendants. `None` retains legacy recursive
    /// discovery.
    pub max_discovery_depth: Option<usize>,
    /// Use the shared append watermark for metadata-only cache refreshes.
    pub incremental_metadata: bool,
    /// Prefer the session header's stable id for the canonical ORGII id.
    pub session_id_from_header: bool,
}
