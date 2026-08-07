use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::privacy::{PrivacyConfig, ORGTRACK_DIR_NAME};

pub fn orgtrack_root(repo_path: &Path) -> PathBuf {
    repo_path.join(ORGTRACK_DIR_NAME)
}

pub fn metadata_dir(repo_path: &Path) -> PathBuf {
    orgtrack_root(repo_path).join("metadata")
}

pub fn histories_dir(repo_path: &Path) -> PathBuf {
    orgtrack_root(repo_path).join("histories")
}

pub fn config_path(repo_path: &Path) -> PathBuf {
    metadata_dir(repo_path).join("config.json")
}

pub fn manifest_path(repo_path: &Path) -> PathBuf {
    metadata_dir(repo_path).join("manifest.json")
}

pub fn index_path(repo_path: &Path) -> PathBuf {
    metadata_dir(repo_path).join("index.json")
}

pub fn records_dir(repo_path: &Path) -> PathBuf {
    metadata_dir(repo_path).join("records")
}

pub fn derived_dir(repo_path: &Path) -> PathBuf {
    metadata_dir(repo_path).join("derived")
}

pub fn state_dir(repo_path: &Path) -> PathBuf {
    metadata_dir(repo_path).join("state")
}

pub fn scan_progress_path(repo_path: &Path) -> PathBuf {
    state_dir(repo_path).join("scan.json")
}

pub fn scan_checkpoint_path(repo_path: &Path) -> PathBuf {
    state_dir(repo_path).join("checkpoint.json")
}

pub fn files_dir(repo_path: &Path) -> PathBuf {
    derived_dir(repo_path).join("files")
}

pub fn commits_dir(repo_path: &Path) -> PathBuf {
    derived_dir(repo_path).join("commits")
}

pub fn objects_dir(repo_path: &Path) -> PathBuf {
    derived_dir(repo_path).join("objects")
}

pub fn packs_dir(repo_path: &Path) -> PathBuf {
    derived_dir(repo_path).join("packs")
}

pub fn source_sessions_dir(repo_path: &Path) -> PathBuf {
    records_dir(repo_path).join("sessions")
}

pub fn source_provenance_dir(repo_path: &Path) -> PathBuf {
    records_dir(repo_path).join("provenance")
}

pub fn source_commit_links_dir(repo_path: &Path) -> PathBuf {
    records_dir(repo_path).join("commit_links")
}

pub fn history_details_dir(repo_path: &Path) -> PathBuf {
    histories_dir(repo_path).join("details")
}

pub fn history_trajectories_dir(repo_path: &Path) -> PathBuf {
    histories_dir(repo_path).join("trajectories")
}

pub fn history_logs_dir(repo_path: &Path) -> PathBuf {
    histories_dir(repo_path).join("logs")
}

pub fn session_meta_path(repo_path: &Path, session_id: &str) -> PathBuf {
    source_sessions_dir(repo_path).join(format!("{}.meta.json", safe_file_stem(session_id)))
}

pub fn session_details_path(repo_path: &Path, session_id: &str) -> PathBuf {
    history_details_dir(repo_path).join(format!("{}.details.json", safe_file_stem(session_id)))
}

pub fn session_trajectory_path(repo_path: &Path, session_id: &str) -> PathBuf {
    history_trajectories_dir(repo_path)
        .join(format!("{}.trajectory.json", safe_file_stem(session_id)))
}

pub fn provenance_record_path(repo_path: &Path, record_id: &str) -> PathBuf {
    sharded_path(source_provenance_dir(repo_path), record_id, "json")
}

pub fn commit_record_path(repo_path: &Path, record_id: &str) -> PathBuf {
    sharded_path(source_commit_links_dir(repo_path), record_id, "json")
}

pub fn file_timeline_path(repo_path: &Path, repo_relative_path: &str) -> PathBuf {
    sharded_path(
        files_dir(repo_path),
        &path_hash(repo_relative_path),
        "jsonl",
    )
}

pub fn file_timeline_legacy_path(repo_path: &Path, repo_relative_path: &str) -> PathBuf {
    files_dir(repo_path).join(format!("{}.json", path_hash(repo_relative_path)))
}

pub fn file_timeline_index_path(repo_path: &Path, repo_relative_path: &str) -> PathBuf {
    sharded_path(files_dir(repo_path), &path_hash(repo_relative_path), "idx")
}

pub fn commit_path(repo_path: &Path, commit_sha: &str) -> PathBuf {
    sharded_path(commits_dir(repo_path), &safe_file_stem(commit_sha), "json")
}

pub fn ensure_orgtrack_dirs(repo_path: &Path) -> Result<(), String> {
    for dir in [
        orgtrack_root(repo_path),
        metadata_dir(repo_path),
        histories_dir(repo_path),
        records_dir(repo_path),
        source_sessions_dir(repo_path),
        source_provenance_dir(repo_path),
        source_commit_links_dir(repo_path),
        history_details_dir(repo_path),
        history_trajectories_dir(repo_path),
        history_logs_dir(repo_path),
        derived_dir(repo_path),
        state_dir(repo_path),
        files_dir(repo_path),
        commits_dir(repo_path),
        objects_dir(repo_path),
        packs_dir(repo_path),
    ] {
        fs::create_dir_all(&dir)
            .map_err(|err| format!("Failed to create {}: {}", dir.display(), err))?;
    }
    ensure_readme(repo_path)?;
    ensure_gitignore(repo_path)?;
    ensure_gitattributes(repo_path)?;
    Ok(())
}

fn ensure_readme(repo_path: &Path) -> Result<(), String> {
    let path = orgtrack_root(repo_path).join("README.md");
    if path.exists() {
        return Ok(());
    }
    fs::write(
        &path,
        "# .orgtrack\n\nThis folder stores repo-shareable ORGII file/session/commit lineage.\n\n- `metadata/` is designed to be safe to publish. It contains session/file/commit metadata, branch context, agent category labels, content-addressed records, and rebuildable indexes.\n- `histories/` is private by default. It can contain richer agent working history, detailed normalized events, trajectories, prompts, tool payloads, file contents, and secrets.\n- `metadata/records/` is the canonical merge-safe source of truth. Records are immutable and deduplicated by deterministic IDs.\n- `metadata/derived/` contains rebuildable indexes for fast UI reads. If these files conflict, run ORGII orgtrack repair or initialize again.\n\nCommit `metadata/` when you want open-source provenance without publishing full agent workings. Keep `histories/` local unless you intentionally opt in.\n",
    )
    .map_err(|err| format!("Failed to write {}: {}", path.display(), err))
}

fn ensure_gitignore(repo_path: &Path) -> Result<(), String> {
    let path = orgtrack_root(repo_path).join(".gitignore");
    if path.exists() {
        return Ok(());
    }
    fs::write(
        &path,
        "histories/\nmetadata/derived/objects/\nmetadata/derived/packs/\n*.trajectory.json\n",
    )
    .map_err(|err| format!("Failed to write {}: {}", path.display(), err))
}

fn ensure_gitattributes(repo_path: &Path) -> Result<(), String> {
    let path = orgtrack_root(repo_path).join(".gitattributes");
    if path.exists() {
        return Ok(());
    }
    fs::write(
        &path,
        "metadata/records/**/*.json merge=union\nmetadata/derived/files/**/*.jsonl merge=union\nmetadata/manifest.json merge=union\nmetadata/index.json merge=union\nhistories/** -merge\n",
    )
    .map_err(|err| format!("Failed to write {}: {}", path.display(), err))
}

pub fn load_config(repo_path: &Path) -> Result<PrivacyConfig, String> {
    let path = config_path(repo_path);
    if !path.exists() {
        return Ok(PrivacyConfig::default());
    }
    read_json(&path)
}

pub fn write_json_pretty<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {}", parent.display(), err))?;
    }
    let json = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Failed to serialize {}: {}", path.display(), err))?;
    fs::write(path, json).map_err(|err| format!("Failed to write {}: {}", path.display(), err))
}

pub fn append_json_line<T: serde::Serialize>(path: &Path, value: &T) -> Result<u64, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {}", parent.display(), err))?;
    }
    let offset = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let mut json = serde_json::to_string(value)
        .map_err(|err| format!("Failed to serialize {}: {}", path.display(), err))?;
    json.push('\n');
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("Failed to open {}: {}", path.display(), err))?;
    file.write_all(json.as_bytes())
        .map_err(|err| format!("Failed to append {}: {}", path.display(), err))?;
    Ok(offset)
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes =
        fs::read(path).map_err(|err| format!("Failed to read {}: {}", path.display(), err))?;
    serde_json::from_slice(&bytes)
        .map_err(|err| format!("Failed to parse {}: {}", path.display(), err))
}

pub fn read_json_lines<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Vec<T>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read {}: {}", path.display(), err))?;
    contents
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .map_err(|err| format!("Failed to parse {}: {}", path.display(), err))
        })
        .collect()
}

pub fn sharded_path(root: PathBuf, id: &str, extension: &str) -> PathBuf {
    let stem = safe_file_stem(id);
    let prefix = stem.get(0..2).unwrap_or("00");
    root.join(prefix).join(format!("{}.{}", stem, extension))
}

pub fn safe_file_stem(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

pub fn path_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn record_id(parts: &[&str]) -> String {
    path_hash(&parts.join("\u{1f}"))
}

pub fn repo_relative_path(repo_path: &Path, file_path: &str) -> String {
    let path = Path::new(file_path);
    if let Ok(relative) = path.strip_prefix(repo_path) {
        return relative
            .to_string_lossy()
            .trim_start_matches('/')
            .to_string();
    }
    file_path.trim_start_matches('/').to_string()
}

pub fn clear_derived_outputs(repo_path: &Path) -> Result<(), String> {
    for dir in [
        derived_dir(repo_path),
        files_dir(repo_path),
        commits_dir(repo_path),
        objects_dir(repo_path),
        packs_dir(repo_path),
    ] {
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|err| format!("Failed to remove {}: {}", dir.display(), err))?;
        }
    }
    ensure_orgtrack_dirs(repo_path)
}
