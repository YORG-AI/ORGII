//! Session-id derivation and on-disk path resolution: mapping session ids to
//! transcript files, deriving stable source ids (incl. subagent parents), and
//! enumerating the WorkBuddy/CodeBuddy history roots per platform.

use super::*;

pub(super) fn workbuddy_file_stem_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(source_session_id) = session_id.strip_prefix(WORKBUDDY_SESSION_PREFIX) else {
        return Err(format!(
            "Invalid WorkBuddy history session id: {session_id}"
        ));
    };
    if source_session_id.is_empty() {
        return Err("WorkBuddy history session id is missing source id".to_string());
    }
    Ok(source_session_id)
}

pub(super) fn resolve_workbuddy_session_path(
    conn: &Connection,
    source_session_id: &str,
) -> Result<PathBuf, String> {
    if let Some(path) =
        imported_cache::get_cached_source_path_from_conn(conn, SOURCE_WORKBUDDY, source_session_id)?
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let mut files = Vec::new();
    for root in workbuddy_history_roots()? {
        if root.is_dir() {
            collect_workbuddy_session_files(&root, &mut files)?;
        } else if root.is_file() {
            push_workbuddy_session_file(&root, &mut files);
        }
    }
    files
        .into_iter()
        .find(|file| workbuddy_source_session_id(&file.file_stem, &file.path) == source_session_id)
        .map(|file| file.path)
        .ok_or_else(|| format!("WorkBuddy history file not found for session: {source_session_id}"))
}

pub(super) fn workbuddy_source_session_id(file_stem: &str, path: &Path) -> String {
    if is_uuid_like(file_stem) {
        return file_stem.to_string();
    }
    if file_stem.starts_with("agent-") {
        if let Some(session_id) = workbuddy_embedded_session_id(path) {
            return session_id;
        }
    }
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in path.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{file_stem}-{hash:016x}")
}

pub(super) fn workbuddy_embedded_session_id(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    BufReader::new(file)
        .lines()
        .take(20)
        .filter_map(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .find_map(|value| {
            value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|session_id| !session_id.is_empty())
                .map(str::to_string)
        })
}

pub(super) fn workbuddy_parent_source_session_id(path: &Path) -> Option<String> {
    let subagents_dir = path.parent()?;
    if subagents_dir.file_name().and_then(|name| name.to_str())? != "subagents" {
        return None;
    }
    let parent_dir = subagents_dir.parent()?;
    let parent_id = parent_dir.file_name()?.to_str()?.trim();
    if parent_id.is_empty() {
        return None;
    }
    let parent_transcript = parent_dir.parent()?.join(format!("{parent_id}.jsonl"));
    if parent_transcript.is_file() {
        Some(workbuddy_source_session_id(parent_id, &parent_transcript))
    } else {
        Some(parent_id.to_string())
    }
}

pub(super) fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        matches!(index, 8 | 13 | 18 | 23) && *byte == b'-'
            || !matches!(index, 8 | 13 | 18 | 23) && byte.is_ascii_hexdigit()
    })
}

pub(super) fn workbuddy_history_roots() -> Result<Vec<PathBuf>, String> {
    let home = app_paths::external_history_home_dir();
    Ok(workbuddy_history_root_candidates(&home))
}

pub(super) fn workbuddy_history_root_candidates(home: &Path) -> Vec<PathBuf> {
    let mut roots = vec![
        home.join(".workbuddy").join("projects"),
        home.join(".workbuddy").join("sessions"),
        home.join(".workbuddy").join("history.jsonl"),
        home.join(".codebuddy").join("projects"),
        home.join(".codebuddy").join("sessions"),
        home.join(".codebuddy").join("history.jsonl"),
    ];

    #[cfg(target_os = "macos")]
    {
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("CodeBuddyExtension"),
        );
    }

    #[cfg(target_os = "windows")]
    {
        roots.push(
            home.join("AppData")
                .join("Roaming")
                .join("CodeBuddyExtension"),
        );
    }

    #[cfg(target_os = "linux")]
    {
        roots.push(home.join(".config").join("CodeBuddyExtension"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(root.clone()))
        .collect()
}
