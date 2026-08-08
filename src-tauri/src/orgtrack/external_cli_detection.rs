use std::collections::BTreeSet;
use std::env;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Copy)]
pub struct ExternalCliSourceSpec {
    pub source_id: &'static str,
    pub display_name: &'static str,
    pub icon_id: &'static str,
    pub detect_cmd: &'static str,
    pub detect_aliases: &'static [&'static str],
    pub launch_cmd: &'static str,
    pub expected_process: &'static str,
    pub history_import: bool,
    pub history_dirs: &'static [&'static str],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCliCapabilities {
    pub installed_detection: bool,
    pub running_detection: bool,
    pub history_detection: bool,
    pub history_import: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCliSourceProbe {
    pub source_id: String,
    pub display_name: String,
    pub icon_id: String,
    pub detect_commands: Vec<String>,
    pub launch_command: String,
    pub expected_process: String,
    pub capabilities: ExternalCliCapabilities,
    pub installed: bool,
    pub executable_path: Option<String>,
    pub running: Option<bool>,
    pub history_found: bool,
    pub history_paths: Vec<String>,
    pub status: String,
    pub importable: bool,
    /// On-disk store format ORGII parses for this source: "jsonl", "sqlite",
    /// or "" when the source is only install-detected (no history import).
    pub store_kind: String,
}

const IMPORTABLE_HISTORY_SOURCE_IDS: &[&str] = &[
    "codex_app",
    "claude_code",
    "cursor_ide",
    "cursor_cli",
    "opencode",
    "windsurf",
    "workbuddy",
    "trae",
    "cline",
    "warp",
    "zcode",
    "qoder",
    "mimo_code",
    "omp",
    "pi",
    "qoder_cli",
    "qwen_code",
    "copilot",
    "kimi",
];

/// On-disk store format for a source's session history — the "file type" shown
/// in the Data Sources inventory. Covers the importable sources ORGII parses
/// plus tools whose store format is known (observed empirically) even though
/// ORGII does not import them yet. Returns "" when no local transcript store is
/// known (server-side/cloud tools, or nothing persisted locally).
fn store_kind_for(source_id: &str) -> &'static str {
    match source_id {
        // Importable — ORGII parses these.
        "claude_code" | "codex_app" | "workbuddy" | "trae" | "cline" | "qoder" | "omp" | "pi"
        | "qoder_cli" | "qwen_code" | "kimi" => "jsonl",
        "cursor_ide" | "cursor_cli" | "opencode" | "windsurf" | "warp" | "zcode" | "mimo_code"
        | "copilot" => "sqlite",
        // Known store format, not yet imported.
        "droid" => "jsonl",
        "goose" | "grok" | "openclaw" => "sqlite",
        "aider" => "markdown",
        _ => "",
    }
}

pub const EXTERNAL_CLI_SOURCES: &[ExternalCliSourceSpec] = &[
    source(
        "claude_code",
        "Claude Code",
        "claude_code",
        "claude",
        &[],
        "claude",
        "claude",
        // Claude Code has a full importer (parser + cache + recent-paths) and is
        // listed in IMPORTABLE_HISTORY_SOURCE_IDS, so it must be flagged
        // importable — otherwise the Data Sources row renders non-importable
        // (no rescan dropdown) and its session count never loads.
        true,
        &[".claude", ".claude/projects"],
    ),
    source(
        "codex_app",
        "Codex",
        "codex",
        "codex",
        &[],
        "codex",
        "codex",
        true,
        &[".codex", ".codex/sessions"],
    ),
    source(
        "autohand",
        "AutoHand",
        "autohand",
        "autohand",
        &[],
        "autohand",
        "autohand",
        false,
        &[".autohand"],
    ),
    source(
        "opencode",
        "OpenCode",
        "opencode",
        "opencode",
        &[],
        "opencode",
        "opencode",
        true,
        &[".config/opencode", ".local/share/opencode"],
    ),
    source(
        "warp",
        "Warp",
        "warp",
        "oz",
        &["oz-preview", "warp-cli", "warp-terminal"],
        "oz",
        "Warp",
        true,
        &[
            ".local/state/warp-terminal",
            "Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable",
        ],
    ),
    source(
        "zcode",
        "ZCode",
        "zcode",
        "zcode",
        &["zcode-cli"],
        "zcode",
        "zcode",
        true,
        &[".zcode/cli/db", ".zcode"],
    ),
    source(
        "mimo_code",
        "Mimo Code",
        "mimo_code",
        "mimo",
        &[],
        "mimo",
        "mimo",
        true,
        &[".config/mimocode", ".local/share/mimocode"],
    ),
    source(
        "pi",
        "Pi",
        "pi",
        "pi",
        &[],
        "pi",
        "pi",
        true,
        &[".pi/agent/sessions"],
    ),
    source(
        "omp",
        "OMP",
        "omp",
        "omp",
        &[],
        "omp",
        "omp",
        true,
        &[".omp/agent/sessions", ".oh-omp/agent/sessions"],
    ),
    source(
        "antigravity",
        "Antigravity",
        "antigravity",
        "agy",
        &[],
        "agy",
        "agy",
        false,
        &[".gemini/antigravity-cli"],
    ),
    source(
        "aider",
        "Aider",
        "aider",
        "aider",
        &[],
        "aider",
        "aider",
        false,
        &[".aider"],
    ),
    source(
        "goose",
        "Goose",
        "goose",
        "goose",
        &[],
        "goose",
        "goose",
        false,
        &[".config/goose"],
    ),
    source(
        "amp",
        "Amp",
        "amp",
        "amp",
        &[],
        "amp",
        "amp",
        false,
        &[".config/amp"],
    ),
    source(
        "kilo",
        "Kilo",
        "kilo",
        "kilo",
        &[],
        "kilo",
        "kilo",
        false,
        &[".config/kilo"],
    ),
    source(
        "kiro",
        "Kiro",
        "kiro",
        "kiro-cli",
        &[],
        "kiro-cli chat --tui",
        "kiro-cli",
        false,
        &[".kiro"],
    ),
    source(
        "cline",
        "Cline",
        "cline",
        "cline",
        &[],
        "cline",
        "cline",
        true,
        &[".cline"],
    ),
    source(
        "codebuff",
        "Codebuff",
        "codebuff",
        "codebuff",
        &[],
        "codebuff",
        "codebuff",
        false,
        &[".codebuff"],
    ),
    source(
        "continue",
        "Continue",
        "continue_cli",
        "cn",
        &[],
        "cn",
        "cn",
        false,
        &[".continue"],
    ),
    source(
        "cursor_cli",
        "Cursor CLI",
        "cursor",
        "cursor-agent",
        &[],
        "cursor-agent",
        "cursor-agent",
        // cursor-agent writes one SQLite store per session under
        // `~/.cursor/chats/<workspace-hash>/<session-uuid>/store.db`,
        // parsed by `orgtrack_core::sources::cursor_cli`.
        true,
        &[".cursor/chats"],
    ),
    source(
        "droid",
        "Droid",
        "droid",
        "droid",
        &[],
        "droid",
        "droid",
        false,
        &[".factory"],
    ),
    source(
        "kimi",
        "Kimi",
        "kimi",
        "kimi",
        &[],
        "kimi",
        "kimi",
        true,
        &[".kimi/sessions", ".kimi-code/sessions"],
    ),
    source(
        "mistral_vibe",
        "Mistral Vibe",
        "mistral_vibe",
        "vibe",
        &["mistral-vibe"],
        "vibe",
        "vibe",
        false,
        &[".vibe"],
    ),
    source(
        "qwen_code",
        "Qwen Code",
        "qwen_code",
        "qwen",
        &[],
        "qwen",
        "qwen",
        true,
        &[".qwen/projects"],
    ),
    source(
        "hermes",
        "Hermes",
        "hermes",
        "hermes",
        &[],
        "hermes --tui",
        "hermes",
        false,
        &[".hermes"],
    ),
    source(
        "openclaw",
        "OpenClaw",
        "openclaw",
        "openclaw",
        &[],
        "openclaw",
        "openclaw",
        false,
        &[".openclaw"],
    ),
    source(
        "copilot",
        "GitHub Copilot",
        "copilot",
        "copilot",
        &[],
        "copilot",
        "copilot",
        // Session history under ~/.copilot/session-state is now
        // parsed by `orgtrack_core::sources::copilot`.
        true,
        &[".copilot/session-state"],
    ),
    source(
        "grok",
        "Grok",
        "grok",
        "grok",
        &[],
        "grok",
        "grok",
        false,
        &[".grok"],
    ),
    source(
        "devin",
        "Devin",
        "devin",
        "devin",
        &[],
        "devin",
        "devin",
        false,
        &[".devin"],
    ),
    source(
        "cursor_ide",
        "Cursor App",
        "cursor",
        "cursor",
        &[],
        "cursor",
        "Cursor",
        true,
        &[],
    ),
    source(
        "windsurf",
        "Windsurf",
        "windsurf",
        "windsurf",
        &[],
        "windsurf",
        "windsurf",
        true,
        &[],
    ),
    source(
        "workbuddy",
        "WorkBuddy",
        "workbuddy",
        "workbuddy",
        &[],
        "workbuddy",
        "workbuddy",
        true,
        &[],
    ),
    source(
        "trae",
        "Trae",
        "trae",
        "trae",
        &[],
        "trae",
        "Trae",
        true,
        &[],
    ),
    source(
        "qoder",
        "Qoder",
        "qoder",
        "qoder",
        &[],
        "qoder",
        "Qoder",
        true,
        &[".qoder"],
    ),
    source(
        "qoder_cli",
        "Qoder CLI",
        "qoder",
        "qodercli",
        &[],
        "qodercli",
        "qodercli",
        true,
        &[".qoder/projects"],
    ),
    source(
        "trae_cli",
        "Trae Agent",
        "trae",
        "trae-cli",
        &[],
        "trae-cli interactive",
        "trae-cli",
        false,
        &[],
    ),
];

#[allow(clippy::too_many_arguments)]
// The const constructor keeps every registry column visible in the static
// source table; a second builder layer would hide omissions at compile time.
const fn source(
    source_id: &'static str,
    display_name: &'static str,
    icon_id: &'static str,
    detect_cmd: &'static str,
    detect_aliases: &'static [&'static str],
    launch_cmd: &'static str,
    expected_process: &'static str,
    history_import: bool,
    history_dirs: &'static [&'static str],
) -> ExternalCliSourceSpec {
    ExternalCliSourceSpec {
        source_id,
        display_name,
        icon_id,
        detect_cmd,
        detect_aliases,
        launch_cmd,
        expected_process,
        history_import,
        history_dirs,
    }
}

pub fn detect_sources() -> Vec<ExternalCliSourceProbe> {
    EXTERNAL_CLI_SOURCES.iter().map(probe_source).collect()
}

pub fn probe_source_id(source_id: &str) -> Option<ExternalCliSourceProbe> {
    EXTERNAL_CLI_SOURCES
        .iter()
        .find(|source| source.source_id == source_id)
        .map(probe_source)
}

fn probe_source(source: &ExternalCliSourceSpec) -> ExternalCliSourceProbe {
    let detect_commands = detect_commands(source);
    let executable_path = detect_commands.iter().find_map(|cmd| find_command(cmd));
    let history_paths = existing_history_paths(source);
    let history_found = !history_paths.is_empty();
    let importable = source.history_import;
    let status = status_for(executable_path.is_some(), history_found, importable);

    ExternalCliSourceProbe {
        source_id: source.source_id.to_string(),
        display_name: source.display_name.to_string(),
        icon_id: source.icon_id.to_string(),
        detect_commands,
        launch_command: source.launch_cmd.to_string(),
        expected_process: source.expected_process.to_string(),
        capabilities: ExternalCliCapabilities {
            installed_detection: true,
            running_detection: false,
            history_detection: !source.history_dirs.is_empty() || source.history_import,
            history_import: importable,
        },
        installed: executable_path.is_some(),
        executable_path: executable_path.map(|path| path.to_string_lossy().to_string()),
        running: None,
        history_found,
        history_paths: history_paths
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        status,
        importable,
        store_kind: store_kind_for(source.source_id).to_string(),
    }
}

fn detect_commands(source: &ExternalCliSourceSpec) -> Vec<String> {
    let mut commands = Vec::with_capacity(1 + source.detect_aliases.len());
    commands.push(source.detect_cmd.to_string());
    commands.extend(source.detect_aliases.iter().map(|cmd| (*cmd).to_string()));
    commands
}

fn status_for(installed: bool, history_found: bool, importable: bool) -> String {
    match (installed, history_found, importable) {
        (_, true, true) => "importable_history_found",
        (_, false, true) => "importable_no_history_found",
        (true, true, false) => "detected_history_not_importable",
        (true, false, false) => "detected_no_importer",
        (false, true, false) => "history_found_not_importable",
        (false, false, false) => "not_detected",
    }
    .to_string()
}

fn existing_history_paths(source: &ExternalCliSourceSpec) -> Vec<PathBuf> {
    let mut paths = BTreeSet::new();
    if source.history_import && IMPORTABLE_HISTORY_SOURCE_IDS.contains(&source.source_id) {
        paths.extend(importable_history_candidates(source.source_id));
    }
    paths.extend(
        source
            .history_dirs
            .iter()
            .filter_map(|relative| expand_home_relative(relative)),
    );
    paths
        .into_iter()
        .filter(|path| path.exists())
        .collect::<Vec<_>>()
}

fn importable_history_candidates(source_id: &str) -> Vec<PathBuf> {
    match source_id {
        "claude_code" => home_candidates(&[".claude", ".claude/projects"]),
        "codex_app" => home_candidates(&[".codex", ".codex/sessions"]),
        "opencode" => home_candidates(&[".config/opencode", ".local/share/opencode"]),
        "cursor_ide" => platform_data_candidates(&["Cursor/User/globalStorage"]),
        "cursor_cli" => {
            orgtrack_core::sources::cursor_cli::history::cursor_cli_history_candidate_paths()
        }
        "windsurf" => platform_data_candidates(&[
            "Windsurf/User/globalStorage",
            "Windsurf/User/workspaceStorage",
            "Codeium/Windsurf",
        ]),
        "workbuddy" => platform_data_candidates(&["WorkBuddy", "workbuddy"]),
        "trae" => home_candidates(&[".trae-cn/memory/projects", ".trae/memory/projects"]),
        "cline" => home_candidates(&[".cline/data/sessions", ".cline/data/db"]),
        "warp" => orgtrack_core::sources::warp::history::warp_history_candidate_paths(),
        "zcode" => orgtrack_core::sources::zcode::history::zcode_history_candidate_paths(),
        "qoder" => orgtrack_core::sources::qoder::history::qoder_history_candidate_paths(),
        "mimo_code" => {
            orgtrack_core::sources::mimo_code::history::mimo_code_history_candidate_paths()
        }
        "omp" => orgtrack_core::sources::omp::history::omp_history_candidate_paths(),
        "pi" => orgtrack_core::sources::pi::history::pi_history_candidate_paths(),
        "qoder_cli" => {
            orgtrack_core::sources::qoder_cli::history::qoder_cli_history_candidate_paths()
        }
        "qwen_code" => vec![orgtrack_core::sources::qwen_code::history::qwen_code_history_root()],
        "copilot" => home_candidates(&[".copilot/session-state"]),
        "kimi" => orgtrack_core::sources::kimi::history::kimi_history_candidate_paths(),
        _ => Vec::new(),
    }
}

fn home_candidates(relative_paths: &[&str]) -> Vec<PathBuf> {
    relative_paths
        .iter()
        .filter_map(|relative| expand_home_relative(relative))
        .collect()
}

fn platform_data_candidates(relative_paths: &[&str]) -> Vec<PathBuf> {
    data_roots()
        .into_iter()
        .flat_map(|root| {
            relative_paths
                .iter()
                .map(move |relative| root.join(relative))
        })
        .collect()
}

fn expand_home_relative(relative: &str) -> Option<PathBuf> {
    // Keep history discovery aligned with the source-specific importers. The
    // secondary-instance launcher overrides this root so two cloud identities
    // cannot both discover and claim the same system-level transcripts.
    let home = app_paths::external_history_home_dir();
    Some(home.join(relative))
}

fn data_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(data) = dirs::data_dir() {
        roots.push(data);
    }
    if let Some(data_local) = dirs::data_local_dir() {
        roots.push(data_local);
    }
    if let Some(config) = dirs::config_dir() {
        roots.push(config);
    }
    roots.sort();
    roots.dedup();
    roots
}

fn find_command(command: &str) -> Option<PathBuf> {
    if command.contains(std::path::MAIN_SEPARATOR) || Path::new(command).is_absolute() {
        let path = PathBuf::from(command);
        return is_executable_candidate(&path).then_some(path);
    }

    command_search_dirs()
        .into_iter()
        .flat_map(|dir| executable_candidates(&dir, command))
        .find(|path| is_executable_candidate(path))
}

fn command_search_dirs() -> Vec<PathBuf> {
    let mut dirs = BTreeSet::new();
    if let Some(path_env) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&path_env));
    }
    if let Some(home) = dirs::home_dir() {
        dirs.insert(home.join(".local/bin"));
        dirs.insert(home.join(".cargo/bin"));
        dirs.insert(home.join(".npm-global/bin"));
        #[cfg(windows)]
        {
            dirs.insert(home.join("AppData/Roaming/npm"));
            dirs.insert(home.join("AppData/Local/Programs"));
        }
    }
    #[cfg(unix)]
    {
        dirs.insert(PathBuf::from("/opt/homebrew/bin"));
        dirs.insert(PathBuf::from("/usr/local/bin"));
        dirs.insert(PathBuf::from("/usr/bin"));
        dirs.insert(PathBuf::from("/bin"));
    }
    dirs.into_iter().collect()
}

fn executable_candidates(dir: &Path, command: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let has_extension = Path::new(command).extension().is_some();
        if has_extension {
            return vec![dir.join(command)];
        }
        let extensions = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        return extensions
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(|extension| dir.join(format!("{}{}", command, extension.to_ascii_lowercase())))
            .chain(
                extensions
                    .split(';')
                    .filter(|extension| !extension.is_empty())
                    .map(|extension| {
                        dir.join(format!("{}{}", command, extension.to_ascii_uppercase()))
                    }),
            )
            .chain(std::iter::once(dir.join(command)))
            .collect();
    }
    #[cfg(not(windows))]
    {
        vec![dir.join(command)]
    }
}

fn is_executable_candidate(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_contains_existing_importable_sources() {
        for source_id in IMPORTABLE_HISTORY_SOURCE_IDS {
            let source = EXTERNAL_CLI_SOURCES
                .iter()
                .find(|source| source.source_id == *source_id)
                .expect("source exists");
            assert!(source.history_import, "{source_id} should be importable");
        }
    }

    #[test]
    fn every_importable_catalog_source_is_registered_for_history_scans() {
        for source in EXTERNAL_CLI_SOURCES
            .iter()
            .filter(|source| source.history_import)
        {
            assert!(
                IMPORTABLE_HISTORY_SOURCE_IDS.contains(&source.source_id),
                "{} is marked importable but missing from the scan registry",
                source.source_id
            );
        }
    }

    #[test]
    fn catalog_source_ids_are_unique() {
        let mut seen = BTreeSet::new();
        for source in EXTERNAL_CLI_SOURCES {
            assert!(seen.insert(source.source_id), "duplicate source id");
        }
    }

    #[test]
    fn warp_probe_metadata_matches_importer_contract() {
        let source = EXTERNAL_CLI_SOURCES
            .iter()
            .find(|source| source.source_id == "warp")
            .expect("Warp source");
        assert!(source.history_import);
        assert_eq!(store_kind_for("warp"), "sqlite");
        assert_eq!(source.detect_cmd, "oz");
        assert!(source.detect_aliases.contains(&"warp-terminal"));
    }

    #[test]
    fn new_cli_sources_match_import_and_launch_contracts() {
        for (source_id, command, store_kind) in [
            ("mimo_code", "mimo", "sqlite"),
            ("omp", "omp", "jsonl"),
            ("pi", "pi", "jsonl"),
            ("qoder_cli", "qodercli", "jsonl"),
            ("copilot", "copilot", "sqlite"),
        ] {
            let source = EXTERNAL_CLI_SOURCES
                .iter()
                .find(|source| source.source_id == source_id)
                .expect("source entry");
            assert!(source.history_import);
            assert_eq!(source.detect_cmd, command);
            assert_eq!(store_kind_for(source_id), store_kind);
        }

        let pi = EXTERNAL_CLI_SOURCES
            .iter()
            .find(|source| source.source_id == "pi")
            .expect("Pi source entry");
        assert_eq!(pi.history_dirs, &[".pi/agent/sessions"]);
        assert_eq!(
            importable_history_candidates("pi"),
            orgtrack_core::sources::pi::history::pi_history_candidate_paths()
        );

        let trae = EXTERNAL_CLI_SOURCES
            .iter()
            .find(|source| source.source_id == "trae_cli")
            .expect("Trae CLI source");
        assert_eq!(trae.detect_cmd, "trae-cli");
        assert_eq!(trae.launch_cmd, "trae-cli interactive");

        let qwen = EXTERNAL_CLI_SOURCES
            .iter()
            .find(|source| source.source_id == "qwen_code")
            .expect("Qwen Code source");
        assert!(qwen.history_import);
        assert_eq!(qwen.history_dirs, &[".qwen/projects"]);
        assert_eq!(store_kind_for("qwen_code"), "jsonl");

        let kimi = EXTERNAL_CLI_SOURCES
            .iter()
            .find(|source| source.source_id == "kimi")
            .expect("Kimi source");
        assert!(kimi.history_import);
        assert_eq!(
            kimi.history_dirs,
            &[".kimi/sessions", ".kimi-code/sessions"]
        );
        assert_eq!(store_kind_for("kimi"), "jsonl");
        assert_eq!(
            importable_history_candidates("kimi"),
            orgtrack_core::sources::kimi::history::kimi_history_candidate_paths()
        );
    }

    #[test]
    fn probe_unknown_source_returns_none() {
        assert!(probe_source_id("missing-agent").is_none());
    }
}
