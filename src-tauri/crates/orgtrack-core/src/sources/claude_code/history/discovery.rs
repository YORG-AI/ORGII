use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{ImportedHistoryDiscoveredRecord, SOURCE_CLAUDE_CODE},
    paths as imported_paths, scan_snapshot,
};

use super::types::{
    ClaudeCodeSessionFile, ClaudeSessionMetadataFile, ClaudeSessionTitle,
    ClaudeSubagentMetadataFile,
};
use super::{CLAUDE_CODE_METADATA_PARSER_VERSION, CLAUDE_CODE_SESSION_PREFIX};

#[derive(Debug)]
pub(super) struct ClaudeCodeDiscovery {
    pub(super) records: Vec<ImportedHistoryDiscoveredRecord>,
    pub(super) external_titles: HashMap<String, String>,
}

pub(super) fn discover_claude_code_history_records(
    projects_dirs: &[PathBuf],
    walker: &mut scan_snapshot::SnapshotDirWalker<'_>,
) -> Result<ClaudeCodeDiscovery, String> {
    let mut records = Vec::new();
    let mut external_titles = HashMap::new();
    for projects_dir in projects_dirs {
        if !projects_dir.is_dir() {
            continue;
        }
        let title_index = load_claude_session_titles_for_projects_dir(projects_dir)?;
        let mut paths = Vec::new();
        walker.collect_files(projects_dir, &mut paths)?;
        for path in paths {
            if is_claude_workflow_journal_path(&path) {
                continue;
            }
            let Some(file_stem) = path
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            let (source_mtime_ms, source_size_bytes) =
                imported_paths::file_metadata_signature(&path, "Claude")?;
            let subagent_title = claude_subagent_metadata_title(&path);
            if let Some(title) = subagent_title.as_ref() {
                external_titles.insert(file_stem.clone(), title.clone());
            } else if let Some(title) = title_index.get(&file_stem) {
                external_titles.insert(
                    file_stem.clone(),
                    imported_history::truncate_name(&title.name, 200),
                );
            }
            records.push(ImportedHistoryDiscoveredRecord {
                source_session_id: file_stem.clone(),
                source_path: path,
                source_record_key: file_stem.clone(),
                source_mtime_ms,
                source_size_bytes,
                source_fingerprint: claude_source_fingerprint(
                    &file_stem,
                    &title_index,
                    subagent_title.as_deref(),
                ),
                parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
            });
        }
    }
    Ok(ClaudeCodeDiscovery {
        records,
        external_titles,
    })
}

/// `<uuid>/subagents/workflows/wf_*/journal.jsonl` files are workflow event
/// journals, not session transcripts. Their shared `journal` stem collides
/// into one cache row that every sync pass re-upserts, so they are excluded
/// at discovery. Workflow `agent-*.jsonl` files in the same tree ARE real
/// sidechain transcripts and stay included.
pub(super) fn is_claude_workflow_journal_path(path: &Path) -> bool {
    if path.file_stem().and_then(|value| value.to_str()) != Some("journal") {
        return false;
    }
    let components = path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    components
        .windows(2)
        .any(|pair| pair == ["subagents", "workflows"])
}

fn claude_subagent_metadata_title(path: &Path) -> Option<String> {
    if !path
        .ancestors()
        .any(|ancestor| ancestor.file_name().and_then(|name| name.to_str()) == Some("subagents"))
    {
        return None;
    }
    // This file is optional Claude Code metadata. A missing, unreadable, or
    // malformed sidecar must not prevent the transcript itself from loading.
    let metadata_path = path.with_extension("meta.json");
    let contents = fs::read_to_string(metadata_path).ok()?;
    let metadata = serde_json::from_str::<ClaudeSubagentMetadataFile>(&contents).ok()?;
    let description = metadata.description.trim();
    (!description.is_empty()).then(|| imported_history::truncate_name(description, 200))
}

pub(super) fn collect_claude_session_files(
    dir: &Path,
    out: &mut Vec<ClaudeCodeSessionFile>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read Claude dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read Claude dir entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_claude_session_files(&path, out)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            if is_claude_workflow_journal_path(&path) {
                continue;
            }
            let Some(file_stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            out.push(ClaudeCodeSessionFile {
                file_stem: file_stem.to_string(),
                path,
            });
        }
    }
    Ok(())
}

fn load_claude_session_titles_for_projects_dir(
    projects_dir: &Path,
) -> Result<HashMap<String, ClaudeSessionTitle>, String> {
    let Some(root) = projects_dir.parent() else {
        return Ok(HashMap::new());
    };
    load_claude_session_titles(&root.join("sessions"))
}

fn load_claude_session_titles(
    sessions_dir: &Path,
) -> Result<HashMap<String, ClaudeSessionTitle>, String> {
    let mut entries = HashMap::new();
    if !sessions_dir.is_dir() {
        return Ok(entries);
    }

    for entry in fs::read_dir(sessions_dir)
        .map_err(|err| format!("Failed to read Claude sessions dir: {err}"))?
    {
        let entry = entry.map_err(|err| format!("Failed to read Claude session entry: {err}"))?;
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let contents = fs::read_to_string(&path).map_err(|err| {
            format!(
                "Failed to read Claude session metadata {}: {err}",
                path.display()
            )
        })?;
        let parsed: ClaudeSessionMetadataFile = match serde_json::from_str(&contents) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let session_id = parsed.session_id.trim();
        let name = parsed.name.trim();
        if session_id.is_empty() || name.is_empty() {
            continue;
        }
        entries.insert(
            session_id.to_string(),
            ClaudeSessionTitle {
                name: name.to_string(),
                name_source: parsed.name_source,
            },
        );
    }

    Ok(entries)
}

fn claude_source_fingerprint(
    file_stem: &str,
    title_index: &HashMap<String, ClaudeSessionTitle>,
    subagent_title: Option<&str>,
) -> String {
    if let Some(title) = subagent_title {
        return format!("subagent-meta:{title}");
    }
    title_index
        .get(file_stem)
        .map(|title| {
            format!(
                "session-meta:{}:{}",
                title.name_source.as_deref().unwrap_or_default(),
                title.name
            )
        })
        .unwrap_or_default()
}

#[cfg(test)]
pub(super) fn claude_session_title_for_record(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<String, String> {
    let Some(sessions_dir) = claude_sessions_dir_for_session_path(&record.source_path) else {
        return Ok(String::new());
    };
    let title_index = load_claude_session_titles(&sessions_dir)?;
    Ok(title_index
        .get(&record.source_record_key)
        .map(|title| imported_history::truncate_name(&title.name, 200))
        .unwrap_or_default())
}

#[cfg(test)]
pub(super) fn claude_sessions_dir_for_session_path(session_path: &Path) -> Option<PathBuf> {
    session_path.ancestors().find_map(|ancestor| {
        if ancestor.file_name().and_then(|name| name.to_str()) == Some("projects") {
            return ancestor.parent().map(|root| root.join("sessions"));
        }
        None
    })
}

pub(super) fn claude_file_stem_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(file_stem) = session_id.strip_prefix(CLAUDE_CODE_SESSION_PREFIX) else {
        return Err(format!(
            "Invalid Claude Code history session id: {session_id}"
        ));
    };
    if file_stem.is_empty() {
        return Err("Claude Code history session id is missing file stem".to_string());
    }
    Ok(file_stem)
}

pub(super) fn resolve_claude_session_path(
    conn: &Connection,
    file_stem: &str,
) -> Result<PathBuf, String> {
    if let Some(path) =
        imported_cache::get_cached_source_path_from_conn(conn, SOURCE_CLAUDE_CODE, file_stem)?
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let mut files = Vec::new();
    for projects_dir in claude_projects_dirs()? {
        if projects_dir.is_dir() {
            collect_claude_session_files(&projects_dir, &mut files)?;
        }
    }
    files
        .into_iter()
        .find(|file| file.file_stem == file_stem)
        .map(|file| file.path)
        .ok_or_else(|| format!("Claude Code history file not found for session: {file_stem}"))
}

pub(super) fn claude_projects_dirs() -> Result<Vec<PathBuf>, String> {
    let home = app_paths::external_history_home_dir();
    let mut dirs = claude_projects_dir_candidates(&home);
    // ORGII-managed sessions run with CLAUDE_CONFIG_DIR redirected into
    // per-account (own-key) or per-session (hosted-key) profile dirs; in
    // native-transcript mode those stores are the transcript of record.
    dirs.extend(
        crate::sources::imported_history::managed_roots::profile_root_children(
            &app_paths::claude_code_cli_profile_root(),
            &["projects"],
        ),
    );
    Ok(dirs)
}

pub(super) fn claude_projects_dir_candidates(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(home.join(".claude"));

    #[cfg(target_os = "macos")]
    {
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude Code"),
        );
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("claude-code"),
        );
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude"),
        );
    }

    #[cfg(target_os = "windows")]
    {
        roots.push(home.join("AppData").join("Roaming").join("Claude Code"));
        roots.push(home.join("AppData").join("Roaming").join("claude-code"));
        roots.push(home.join("AppData").join("Roaming").join("Claude"));
        roots.push(home.join("AppData").join("Local").join("Claude Code"));
        roots.push(home.join("AppData").join("Local").join("claude-code"));
        roots.push(home.join("AppData").join("Local").join("Claude"));
    }

    #[cfg(target_os = "linux")]
    {
        roots.push(home.join(".config").join("claude-code"));
        roots.push(home.join(".local").join("share").join("claude-code"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(root.clone()))
        .map(|root| root.join("projects"))
        .collect()
}
