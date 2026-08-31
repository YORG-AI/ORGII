//! Which client wrote an imported session.
//!
//! Every imported source records *what agent* produced a transcript (that is
//! the source id), but several vendors ship more than one client against the
//! same on-disk store: Codex rollouts under `~/.codex/sessions` are written by
//! the Codex desktop app, by the `codex` CLI, by third-party SDK embedders,
//! and by ORGII itself. The source id cannot tell those apart, so the
//! provenance is parsed from the transcript's own self-identification and
//! projected onto this small closed set.
//!
//! The raw vendor string is preserved alongside the classification: the
//! taxonomy is deliberately coarse for display, while the raw value stays
//! available for tooltips, diagnostics, and future refinement without a
//! reparse.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Coarse provenance of the client that produced an imported session.
///
/// Deliberately closed: unrecognized vendor strings classify as
/// [`ImportedClientOrigin::ThirdParty`] rather than adding a variant, because
/// an unknown embedder is exactly what "third party" means here. Absent
/// provenance is represented by `Option::None` at the call site, not by a
/// variant — "not recorded" and "recorded as something we do not know" are
/// different facts and only the latter is a third party.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportedClientOrigin {
    /// The vendor's own first-party desktop application.
    OfficialApp,
    /// The vendor's own terminal client.
    Cli,
    /// Any other embedder: IDE extensions, SDK hosts, agent frameworks.
    ThirdParty,
    /// ORGII itself drove this session. Rendered without a badge — inside
    /// ORGII, "ORGII did this" is the unmarked default, not a distinction.
    Org2,
}

impl ImportedClientOrigin {
    /// Stable wire value shared with the cache column and the TypeScript
    /// union. Kept as an explicit match so a new variant cannot silently
    /// serialize to a string the frontend does not handle.
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::OfficialApp => "official_app",
            Self::Cli => "cli",
            Self::ThirdParty => "third_party",
            Self::Org2 => "org2",
        }
    }

    /// Parse a value previously written by [`Self::as_wire_str`]. Unknown
    /// input yields `None` so a cache row written by a newer build degrades to
    /// "no badge" instead of being mislabeled.
    pub fn from_wire_str(value: &str) -> Option<Self> {
        match value {
            "official_app" => Some(Self::OfficialApp),
            "cli" => Some(Self::Cli),
            "third_party" => Some(Self::ThirdParty),
            "org2" => Some(Self::Org2),
            _ => None,
        }
    }
}

/// ORGII's own originator strings, matched case-insensitively against the
/// whole value and against a `orgii-`/`orgii_` prefix so smoke-test and
/// per-surface variants (`orgii-smoke`) do not read as third-party embedders.
fn is_org2_originator(normalized: &str) -> bool {
    normalized == "orgii"
        || normalized == "org2"
        || normalized.starts_with("orgii-")
        || normalized.starts_with("orgii_")
        || normalized.starts_with("org2-")
        || normalized.starts_with("org2_")
}

/// Classify a Codex rollout's `session_meta.payload.originator`.
///
/// `originator` is used rather than the sibling `source` field because
/// `source` is not a provenance signal: the Codex desktop app reports
/// `source: "vscode"` for its own sessions, so `source` cannot separate the
/// official app from an IDE extension. `originator` names the client.
pub fn classify_codex_originator(originator: &str) -> Option<ImportedClientOrigin> {
    let normalized = originator.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if is_org2_originator(&normalized) {
        return Some(ImportedClientOrigin::Org2);
    }
    Some(match normalized.as_str() {
        "codex desktop" | "codex_desktop" | "codex-desktop" => ImportedClientOrigin::OfficialApp,
        "codex_cli_rs" | "codex-tui" | "codex_tui" | "codex_exec" | "codex-exec" | "codex" => {
            ImportedClientOrigin::Cli
        }
        _ => ImportedClientOrigin::ThirdParty,
    })
}

/// Classify a Claude Code transcript by `entrypoint` and where it is stored.
///
/// Unlike Codex rollouts, Claude transcripts carry no `originator`, so a
/// session ORGII drove is indistinguishable from a hand-run terminal session
/// by `entrypoint` alone — ORGII spawns the CLI, so its own sessions report
/// `cli`/`sdk-cli`. What does separate them is the store: ORGII runs the CLI
/// against its own managed profile root, so a transcript under
/// `~/.orgii/claude-code-cli-profiles/` is ORGII's own by construction.
/// Checking the path is what keeps ORGII's sessions unlabeled instead of
/// badging them as somebody's terminal.
///
/// Note that `vscode`/`ide` classify as third party even though Anthropic
/// ships the IDE extension: the distinction this badge draws is which client
/// surface produced the session, and an IDE host is neither the desktop app
/// nor the terminal client.
pub fn classify_claude_transcript(
    entrypoint: &str,
    transcript_path: Option<&Path>,
) -> Option<ImportedClientOrigin> {
    if transcript_path.is_some_and(is_org2_managed_claude_transcript) {
        return Some(ImportedClientOrigin::Org2);
    }
    classify_claude_entrypoint(entrypoint)
}

/// Whether a Claude transcript lives inside ORGII's own managed CLI profile
/// root, which only ORGII writes to.
fn is_org2_managed_claude_transcript(path: &Path) -> bool {
    path.starts_with(app_paths::claude_code_cli_profile_root())
}

/// Classify a Claude Code transcript's `entrypoint` alone. Prefer
/// [`classify_claude_transcript`], which also recognizes ORGII's own store.
pub fn classify_claude_entrypoint(entrypoint: &str) -> Option<ImportedClientOrigin> {
    let normalized = entrypoint.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if is_org2_originator(&normalized) {
        return Some(ImportedClientOrigin::Org2);
    }
    Some(match normalized.as_str() {
        "claude-desktop" | "claude_desktop" => ImportedClientOrigin::OfficialApp,
        "cli" | "sdk-cli" | "sdk_cli" => ImportedClientOrigin::Cli,
        _ => ImportedClientOrigin::ThirdParty,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orgii_managed_claude_transcripts_are_org2_despite_a_cli_entrypoint() {
        // ORGII spawns the Claude CLI, so its own sessions self-report
        // `cli`/`sdk-cli` exactly like a hand-run terminal session. Only the
        // managed profile root separates them, and getting this wrong badges
        // the user's own ORGII sessions as somebody's CLI.
        let managed = app_paths::claude_code_cli_profile_root()
            .join("c23b0290")
            .join("projects")
            .join("-Users-me-project")
            .join("0b83425c.jsonl");
        for entrypoint in ["cli", "sdk-cli"] {
            assert_eq!(
                classify_claude_transcript(entrypoint, Some(&managed)),
                Some(ImportedClientOrigin::Org2),
                "{entrypoint} under the managed root must classify as org2"
            );
        }
    }

    #[test]
    fn claude_transcripts_outside_the_managed_root_keep_their_entrypoint() {
        let external = std::path::PathBuf::from("/Users/me/.claude/projects/p/a.jsonl");
        assert_eq!(
            classify_claude_transcript("cli", Some(&external)),
            Some(ImportedClientOrigin::Cli)
        );
        assert_eq!(
            classify_claude_transcript("claude-desktop", Some(&external)),
            Some(ImportedClientOrigin::OfficialApp)
        );
        // A missing path must not promote anything to org2.
        assert_eq!(
            classify_claude_transcript("cli", None),
            Some(ImportedClientOrigin::Cli)
        );
    }

    #[test]
    fn codex_desktop_is_official_app() {
        // The exact casing observed in real rollouts.
        assert_eq!(
            classify_codex_originator("Codex Desktop"),
            Some(ImportedClientOrigin::OfficialApp)
        );
    }

    #[test]
    fn codex_terminal_clients_are_cli() {
        for originator in ["codex_cli_rs", "codex-tui", "codex_exec"] {
            assert_eq!(
                classify_codex_originator(originator),
                Some(ImportedClientOrigin::Cli),
                "{originator} should classify as CLI"
            );
        }
    }

    #[test]
    fn unknown_codex_embedders_are_third_party() {
        for originator in ["multica-agent-sdk", "acp-extension-codex", "some-new-host"] {
            assert_eq!(
                classify_codex_originator(originator),
                Some(ImportedClientOrigin::ThirdParty),
                "{originator} should classify as third party"
            );
        }
    }

    #[test]
    fn orgii_originators_are_org2() {
        for originator in ["orgii", "orgii-smoke", "ORGII", "org2_cli"] {
            assert_eq!(
                classify_codex_originator(originator),
                Some(ImportedClientOrigin::Org2),
                "{originator} should classify as ORG2"
            );
        }
    }

    #[test]
    fn claude_entrypoints_classify_by_surface() {
        assert_eq!(
            classify_claude_entrypoint("claude-desktop"),
            Some(ImportedClientOrigin::OfficialApp)
        );
        assert_eq!(
            classify_claude_entrypoint("cli"),
            Some(ImportedClientOrigin::Cli)
        );
        // Third-party desktop hosts and SDK embedders alike.
        for entrypoint in ["claude-desktop-3p", "vscode", "ide", "sdk-typescript"] {
            assert_eq!(
                classify_claude_entrypoint(entrypoint),
                Some(ImportedClientOrigin::ThirdParty),
                "{entrypoint} should classify as third party"
            );
        }
    }

    #[test]
    fn blank_provenance_is_absent_not_third_party() {
        assert_eq!(classify_codex_originator("   "), None);
        assert_eq!(classify_claude_entrypoint(""), None);
    }

    #[test]
    fn wire_values_round_trip() {
        for origin in [
            ImportedClientOrigin::OfficialApp,
            ImportedClientOrigin::Cli,
            ImportedClientOrigin::ThirdParty,
            ImportedClientOrigin::Org2,
        ] {
            assert_eq!(
                ImportedClientOrigin::from_wire_str(origin.as_wire_str()),
                Some(origin)
            );
        }
        assert_eq!(ImportedClientOrigin::from_wire_str("future_kind"), None);
    }
}
