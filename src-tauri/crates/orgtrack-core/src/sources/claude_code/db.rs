//! Claude Code Session Scanner
//!
//! Reads Claude Code's local session data from `~/.claude/projects/*/` to extract
//! AI session history — session name, model, token usage, message counts, etc.
//!
//! Data sources:
//! - `~/.claude/projects/*/sessions-index.json` — fast session metadata index
//! - `~/.claude/projects/*/*.jsonl` — full session transcripts (parsed for model/tokens)
//!
//! ## Caching
//!
//! Parsed sessions are cached in our own `sessions.db` (`claude_session_cache`
//! table). On each query we delta-sync: only parse JSONL files for sessions
//! whose `fileMtime` has changed since last cache write.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::TimeZone;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

static LAST_SYNC: Mutex<Option<Instant>> = Mutex::new(None);
const SYNC_COOLDOWN: Duration = Duration::from_secs(60);

// ============================================
// Deserialization types (Claude Code JSONL)
// ============================================

/// Entry from `sessions-index.json`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    session_id: String,
    #[serde(default)]
    full_path: String,
    #[serde(default)]
    file_mtime: i64,
    #[serde(default)]
    first_prompt: String,
    #[serde(default)]
    message_count: i32,
    #[serde(default)]
    created: String,
    #[serde(default)]
    modified: String,
    #[serde(default)]
    git_branch: String,
    #[serde(default)]
    workspace_path: String,
}

/// Wrapper for `sessions-index.json`
#[derive(Debug, Deserialize)]
struct SessionsIndex {
    #[serde(default)]
    entries: Vec<IndexEntry>,
}

/// A single line from a session JSONL file (only assistant messages parsed)
#[derive(Debug, Deserialize)]
struct JournalLine {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    message: Option<AssistantMessage>,
}

#[derive(Debug, Deserialize)]
struct AssistantMessage {
    #[serde(default)]
    model: String,
    #[serde(default)]
    usage: Option<TokenUsage>,
}

#[derive(Debug, Deserialize)]
struct TokenUsage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cache_read_input_tokens: i64,
    #[serde(default)]
    cache_creation_input_tokens: i64,
}

// ============================================
// Public type returned to frontend
// ============================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeSession {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_active_at: i64,
    pub message_count: i32,
    pub model: String,
    pub workspace_path: String,
    pub git_branch: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// List-price estimate in USD, priced from `input_tokens`/`output_tokens`
    /// via the shared pricing catalog. Filled at the command boundary (this
    /// crate has no pricing dependency); `0.0` until then.
    #[serde(rename = "estimatedCost", default)]
    pub estimated_cost: f64,
    /// Metered spend recorded by the source. Always `0.0` for Claude Code
    /// subscription sessions — they record no dollar figures.
    #[serde(rename = "recordedCost", default)]
    pub recorded_cost: f64,
}

// ============================================
// Public API
// ============================================

/// Query Claude Code sessions within a date range.
///
/// 1. Delta-syncs from `~/.claude/` into our cache
/// 2. Queries the cache for the requested date range
pub fn get_claude_sessions(
    cache_conn: &Connection,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<ClaudeCodeSession>, String> {
    delta_sync(cache_conn)?;
    query_cache(cache_conn, start_date, end_date)
}

// ============================================
// Delta sync
// ============================================

/// Sync new/changed sessions from Claude Code's local files into our cache.
///
/// Strategy:
/// 1. Read all `sessions-index.json` files from `~/.claude/projects/*/`
/// 2. Compare `file_mtime` against cached `last_active_at` — skip unchanged
/// 3. For new/changed sessions, parse the JSONL for model + token data
/// 4. Upsert into cache
fn delta_sync(cache_conn: &Connection) -> Result<(), String> {
    let now = Instant::now();
    if let Ok(guard) = LAST_SYNC.lock() {
        if let Some(last) = *guard {
            if now.duration_since(last) < SYNC_COOLDOWN {
                return Ok(());
            }
        }
    }

    let claude_dir = match claude_home_dir() {
        Some(dir) => dir,
        None => return Ok(()),
    };

    let projects_dir = claude_dir.join("projects");
    if !projects_dir.is_dir() {
        return Ok(());
    }

    // Collect all index entries across all workspace directories
    let mut all_entries: Vec<IndexEntry> = Vec::new();
    if let Ok(read_dir) = fs::read_dir(&projects_dir) {
        for dir_entry in read_dir.flatten() {
            if !dir_entry.path().is_dir() {
                continue;
            }
            let index_path = dir_entry.path().join("sessions-index.json");
            if index_path.is_file() {
                if let Ok(content) = fs::read_to_string(&index_path) {
                    if let Ok(index) = serde_json::from_str::<SessionsIndex>(&content) {
                        all_entries.extend(index.entries);
                    }
                }
            }
        }
    }

    if all_entries.is_empty() {
        if let Ok(mut guard) = LAST_SYNC.lock() {
            *guard = Some(now);
        }
        return Ok(());
    }

    // Get cached mtimes to skip unchanged sessions
    let cached_mtimes = get_cached_mtimes(cache_conn)?;

    let entries_to_sync: Vec<&IndexEntry> = all_entries
        .iter()
        .filter(|entry| {
            match cached_mtimes.get(&entry.session_id) {
                Some(&cached_mtime) => entry.file_mtime > cached_mtime,
                None => true, // new session
            }
        })
        .collect();

    if !entries_to_sync.is_empty() {
        let sessions: Vec<ClaudeCodeSession> = entries_to_sync
            .iter()
            .filter_map(|entry| build_session(entry))
            .collect();

        upsert_cache(cache_conn, &sessions)?;
    }

    if let Ok(mut guard) = LAST_SYNC.lock() {
        *guard = Some(now);
    }

    Ok(())
}

/// Get cached session IDs mapped to their last_active_at (used as mtime proxy).
fn get_cached_mtimes(conn: &Connection) -> Result<HashMap<String, i64>, String> {
    let mut stmt = conn
        .prepare("SELECT id, last_active_at FROM claude_session_cache")
        .map_err(|err| format!("Failed to query claude cache: {}", err))?;

    let map = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|err| format!("Failed to read claude cache: {}", err))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(map)
}

/// Build a `ClaudeCodeSession` from an index entry, parsing the JSONL for model/tokens.
fn build_session(entry: &IndexEntry) -> Option<ClaudeCodeSession> {
    let created_at = parse_iso_to_epoch_ms(&entry.created);
    let last_active_at = if entry.file_mtime > 0 {
        entry.file_mtime
    } else {
        parse_iso_to_epoch_ms(&entry.modified)
    };

    if created_at == 0 {
        return None;
    }

    // Parse JSONL for model + token usage
    let (model, input_tokens, output_tokens) = parse_session_jsonl(&entry.full_path);

    let name = truncate_name(&entry.first_prompt, 200);

    Some(ClaudeCodeSession {
        id: entry.session_id.clone(),
        name,
        created_at,
        last_active_at,
        message_count: entry.message_count,
        model,
        workspace_path: entry.workspace_path.clone(),
        git_branch: entry.git_branch.clone(),
        input_tokens,
        output_tokens,
        estimated_cost: 0.0,
        recorded_cost: 0.0,
    })
}

/// Parse a session JSONL file to extract the primary model and total token usage.
///
/// Scans all assistant messages, accumulates tokens, and picks the most-used model.
fn parse_session_jsonl(path: &str) -> (String, i64, i64) {
    let default = (String::new(), 0i64, 0i64);

    if path.is_empty() {
        return default;
    }

    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return default,
    };

    let reader = BufReader::new(file);
    let mut total_input: i64 = 0;
    let mut total_output: i64 = 0;
    let mut model_counts: HashMap<String, usize> = HashMap::new();

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };

        if !line.contains("\"assistant\"") {
            continue;
        }

        let parsed: JournalLine = match serde_json::from_str(&line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };

        if parsed.r#type != "assistant" {
            continue;
        }

        if let Some(msg) = &parsed.message {
            if !msg.model.is_empty() && !msg.model.starts_with('<') {
                *model_counts.entry(msg.model.clone()).or_insert(0) += 1;
            }

            if let Some(usage) = &msg.usage {
                total_input += usage.input_tokens
                    + usage.cache_read_input_tokens
                    + usage.cache_creation_input_tokens;
                total_output += usage.output_tokens;
            }
        }
    }

    let primary_model = model_counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(model, _)| model)
        .unwrap_or_default();

    (primary_model, total_input, total_output)
}

/// Truncate a string to `max_len` characters, appending "…" if truncated.
fn truncate_name(name: &str, max_len: usize) -> String {
    let trimmed = name.trim();
    if trimmed.len() <= max_len {
        trimmed.to_string()
    } else {
        let mut result: String = trimmed.chars().take(max_len - 1).collect();
        result.push('…');
        result
    }
}

/// Upsert sessions into the cache table.
fn upsert_cache(conn: &Connection, sessions: &[ClaudeCodeSession]) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "INSERT INTO claude_session_cache
                (id, name, created_at, last_active_at, message_count, model,
                 workspace_path, git_branch, input_tokens, output_tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                last_active_at = excluded.last_active_at,
                message_count = excluded.message_count,
                model = excluded.model,
                workspace_path = excluded.workspace_path,
                git_branch = excluded.git_branch,
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens",
        )
        .map_err(|err| format!("Failed to prepare claude upsert: {}", err))?;

    for session in sessions {
        stmt.execute(params![
            session.id,
            session.name,
            session.created_at,
            session.last_active_at,
            session.message_count,
            session.model,
            session.workspace_path,
            session.git_branch,
            session.input_tokens,
            session.output_tokens,
        ])
        .map_err(|err| format!("Failed to upsert claude session {}: {}", session.id, err))?;
    }

    Ok(())
}

// ============================================
// Cache query
// ============================================

/// Query the local cache for sessions within a date range.
fn query_cache(
    conn: &Connection,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<ClaudeCodeSession>, String> {
    let start_epoch = date_str_to_epoch_ms(start_date);
    let end_epoch = date_str_to_epoch_ms_end(end_date);

    let mut stmt = conn
        .prepare(
            "SELECT id, name, created_at, last_active_at, message_count,
                    model, workspace_path, git_branch, input_tokens, output_tokens
             FROM claude_session_cache
             WHERE created_at >= ?1 AND created_at <= ?2
             ORDER BY created_at DESC",
        )
        .map_err(|err| format!("Failed to query claude cache: {}", err))?;

    let sessions = stmt
        .query_map(params![start_epoch, end_epoch], |row| {
            Ok(ClaudeCodeSession {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                last_active_at: row.get(3)?,
                message_count: row.get(4)?,
                model: row.get(5)?,
                workspace_path: row.get(6)?,
                git_branch: row.get(7)?,
                input_tokens: row.get(8)?,
                output_tokens: row.get(9)?,
                estimated_cost: 0.0,
                recorded_cost: 0.0,
            })
        })
        .map_err(|err| format!("Failed to read claude cache results: {}", err))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(sessions)
}

// ============================================
// Path helpers
// ============================================

fn claude_home_dir() -> Option<PathBuf> {
    let home = app_paths::external_history_home_dir();
    let path = home.join(".claude");
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

// ============================================
// Date / time helpers
// ============================================

fn date_str_to_epoch_ms(date_str: &str) -> i64 {
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() != 3 {
        return 0;
    }
    let year: i32 = parts[0].parse().unwrap_or(2025);
    let month: u32 = parts[1].parse().unwrap_or(1);
    let day: u32 = parts[2].parse().unwrap_or(1);

    match chrono::NaiveDate::from_ymd_opt(year, month, day) {
        Some(date) => {
            let dt = date.and_hms_opt(0, 0, 0).unwrap_or_default();
            let local = chrono::Local
                .from_local_datetime(&dt)
                .single()
                .unwrap_or_else(chrono::Local::now);
            local.timestamp_millis()
        }
        None => 0,
    }
}

fn date_str_to_epoch_ms_end(date_str: &str) -> i64 {
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() != 3 {
        return i64::MAX;
    }
    let year: i32 = parts[0].parse().unwrap_or(2025);
    let month: u32 = parts[1].parse().unwrap_or(1);
    let day: u32 = parts[2].parse().unwrap_or(1);

    match chrono::NaiveDate::from_ymd_opt(year, month, day) {
        Some(date) => {
            let dt = date.and_hms_opt(23, 59, 59).unwrap_or_default();
            let local = chrono::Local
                .from_local_datetime(&dt)
                .single()
                .unwrap_or_else(chrono::Local::now);
            local.timestamp_millis()
        }
        None => i64::MAX,
    }
}

fn parse_iso_to_epoch_ms(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}
