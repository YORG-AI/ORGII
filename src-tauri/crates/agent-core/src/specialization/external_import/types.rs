//! Shared types for the external-agent auto-import pipeline.
//!
//! Mirrored on the TypeScript side in
//! `src/api/types/externalImport.ts`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Which external coding agent the artifact came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceAgent {
    CursorIde,
    ClaudeCode,
    Codex,
    Copilot,
    Kiro,
}

/// Where on disk the artifact was discovered.
///
/// `UserGlobal` items live under the user's home directory and apply to
/// every workspace. `WorkspaceLocal` items live inside a specific repo
/// checkout and only apply when that repo is open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SourceScope {
    UserGlobal,
    WorkspaceLocal { repo_path: PathBuf },
}

/// Which ORGII primitive this artifact will become once imported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Policy,
    Skill,
    Mcp,
    AgentDefinition,
}

/// Lossless preview information surfaced to the wizard so the user can
/// decide whether to import an item without first writing it to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemPreview {
    /// First non-frontmatter Markdown line, trimmed. Empty string if the
    /// body had no usable text.
    pub summary: String,
    /// Raw frontmatter snapshot (string keys → string values). Phase 1
    /// only carries scalar fields, list / object values are
    /// JSON-encoded so the FE can show them verbatim.
    pub frontmatter: Vec<(String, String)>,
    /// Total bytes of the source file. The wizard uses this to surface
    /// "this is a 30 KB rule, are you sure?" warnings.
    pub size_bytes: u64,
}

/// Reasons we may need to warn the user about an imported item.
///
/// Fidelity warnings are *not* errors — they fire when the source
/// contains something ORGII has no place for, the source is malformed,
/// or the import would copy an unusually large bundle. The detector
/// emits them; the wizard decides how to surface them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FidelityWarning {
    /// Source has a field ORGII has no place to store.
    UnmappedField { field: String },
    /// Frontmatter could not be parsed; only the body will be imported.
    FrontmatterParseError { detail: String },
    /// Bundled siblings exceed the auto-copy threshold.
    LargeBundle { bytes: u64 },
    /// Source declared `readonly: true` (Cursor / Codex semantics:
    /// "no write access"). ORGII has no top-level read-only switch on
    /// `AgentDefinition`, so the apply path translates the constraint
    /// into `excluded_tools` covering every write-capable builtin.
    /// `excluded_tools` lists the tool names that will be subtracted on
    /// import so the wizard can show the user what we did.
    ReadonlyDowngraded { excluded_tools: Vec<String> },
}

/// One row in the detector output. The wizard turns selected
/// `DetectedItem`s into `ImportSelection`s before calling the apply
/// command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedItem {
    pub source_agent: SourceAgent,
    pub source_scope: SourceScope,
    pub kind: ItemKind,
    /// Absolute path of the source file (or directory, for skill
    /// imports in later phases).
    pub source_path: PathBuf,
    /// Proposed ORGII-side name. Already deduped against the relevant
    /// target directory at detection time.
    pub suggested_name: String,
    pub already_imported: bool,
    #[serde(default)]
    pub fidelity_warnings: Vec<FidelityWarning>,
    pub preview: ItemPreview,
}

/// User's choice for a single detected item: import as-is, import with
/// a renamed target, or skip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSelection {
    pub source_agent: SourceAgent,
    pub source_scope: SourceScope,
    pub kind: ItemKind,
    pub source_path: PathBuf,
    /// Destination repo for repo-scoped imports. `source_scope` only records
    /// where the artifact was discovered; this field records where rules and
    /// skills should be written. Agent definitions ignore this and remain
    /// global.
    #[serde(default)]
    pub target_repo_path: Option<PathBuf>,
    /// Final target name. The wizard typically passes
    /// `DetectedItem::suggested_name`; users can override.
    pub target_name: String,
    /// When `true`, an existing target with the same name will be
    /// overwritten. Default `false`: collisions raise an error so the
    /// user is forced to disambiguate.
    #[serde(default)]
    pub overwrite: bool,
}

/// Per-item import outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItemReport {
    pub source_path: PathBuf,
    pub target_name: String,
    pub kind: ItemKind,
    pub status: ImportStatus,
    /// Filled when `status == Failed`.
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportStatus {
    Imported,
    Skipped,
    Failed,
}

/// Aggregate result returned to the wizard after a batch apply.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub items: Vec<ImportItemReport>,
}

/// Canonical ORGII builtin tool names that imply *write* (filesystem
/// mutation or shell execution). The external-import pipeline subtracts
/// every name in this list from `AgentDefinition.excluded_tools` when
/// the source frontmatter declares `readonly: true` — it's the closest
/// ORGII-side analogue of Cursor / Codex's coarse-grained "no write
/// access" subagent flag.
///
/// Source of truth for the underlying constants is
/// `crate::tools::names` (which re-exports `core_types::tool_names`);
/// this list is the curated subset that maps to "writes to user
/// state". Keep it in lockstep when new write-capable builtins are
/// added — `external_import::tests::readonly_apply_excludes_writes`
/// asserts the resulting `excluded_tools` set, so a missed update
/// fails CI loudly.
pub fn readonly_excluded_tool_names() -> Vec<String> {
    use crate::tools::names as tool_names;
    vec![
        tool_names::EDIT_FILE.to_string(),
        tool_names::DELETE_FILE.to_string(),
        tool_names::RUN_SHELL.to_string(),
    ]
}

/// Returns `true` when the supplied frontmatter pairs contain a
/// `readonly: true` (or `read_only: true`) declaration. Both spellings
/// are accepted to cover Cursor's `readonly` and Codex's potential
/// `read_only` variants. Comparison is case-insensitive on the value
/// because YAML truthiness has historically been generous about that.
pub fn frontmatter_declares_readonly(pairs: &[(String, String)]) -> bool {
    pairs.iter().any(|(key, value)| {
        let key_lc = key.to_ascii_lowercase();
        if key_lc != "readonly" && key_lc != "read_only" {
            return false;
        }
        let value_lc = value.trim().to_ascii_lowercase();
        matches!(value_lc.as_str(), "true" | "yes" | "1")
    })
}
