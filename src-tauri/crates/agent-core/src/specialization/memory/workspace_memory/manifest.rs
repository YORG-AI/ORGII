//! Scanning + manifest formatting for memory files.
//!
//! Walks the workspace memory directory, parses headers via `frontmatter`,
//! emits the text manifest the prefetch / extract prompts inject, and
//! exposes the `MEMORY.md` index loader plus age-/freshness-text helpers.

use std::fs;
use std::path::Path;
use std::time::SystemTime;

use super::frontmatter::parse_frontmatter;
use super::{
    MemoryHeader, MemoryType, ENTRYPOINT_NAME, FRONTMATTER_MAX_LINES, MAX_ENTRYPOINT_BYTES,
    MAX_ENTRYPOINT_LINES, MAX_MEMORY_FILES,
};

// --- Scanning --------------------------------------------------------

/// Scan the memory directory for `.md` files, parse frontmatter, and return
/// headers sorted newest-first, capped at `MAX_MEMORY_FILES`.
pub fn scan_memory_files(dir: &Path) -> Vec<MemoryHeader> {
    let mut headers = Vec::new();

    if !dir.exists() {
        return headers;
    }

    scan_recursive(dir, dir, &mut headers);

    headers.sort_by_key(|header| std::cmp::Reverse(header.mtime_ms));
    headers.truncate(MAX_MEMORY_FILES);
    headers
}

fn scan_recursive(base_dir: &Path, current_dir: &Path, headers: &mut Vec<MemoryHeader>) {
    // ENOENT here is the legitimate "directory was deleted between
    // exists() and read_dir()" race; quiet. Anything else (permission
    // flip, partial mount) silently drops every memory file under
    // `current_dir` from the manifest the LLM sees — the user wonders
    // why their notes aren't surfacing. Warn so the cause is visible.
    let entries = match fs::read_dir(current_dir) {
        Ok(entries) => entries,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    dir = %current_dir.display(),
                    error = %err,
                    "memory::manifest::scan_recursive: read_dir failed; memory files under this dir will be invisible to the LLM"
                );
            }
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_recursive(base_dir, &path, headers);
            continue;
        }

        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        if !file_name.ends_with(".md") || file_name == ENTRYPOINT_NAME {
            continue;
        }

        let relative = match path.strip_prefix(base_dir) {
            Ok(rel) => rel.to_string_lossy().to_string(),
            Err(_) => continue,
        };

        let mtime_ms = path
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // Per-file read failure silently drops *this* memory file
        // from the manifest. A single corrupt / permission-flipped
        // file shouldn't kill the whole scan, but it should warn so
        // the user can see why their note isn't being surfaced.
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(err) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %err,
                    "memory::manifest::scan_recursive: file read failed; memory will be invisible to the LLM"
                );
                continue;
            }
        };

        let first_lines: String = content
            .lines()
            .take(FRONTMATTER_MAX_LINES)
            .collect::<Vec<_>>()
            .join("\n");

        let (frontmatter, _) = parse_frontmatter(&first_lines);

        headers.push(MemoryHeader {
            filename: relative,
            file_path: path,
            mtime_ms,
            description: frontmatter.get("description").cloned(),
            memory_type: frontmatter.get("type").and_then(|t| MemoryType::parse(t)),
        });
    }
}

// --- Manifest formatting --------------------------------------------

/// Format memory headers as a text manifest (one line per file).
pub fn format_memory_manifest(memories: &[MemoryHeader]) -> String {
    memories
        .iter()
        .map(|mem| {
            let tag = match mem.memory_type {
                Some(ref mt) => format!("[{}] ", mt),
                None => String::new(),
            };
            let ts = format_timestamp_iso(mem.mtime_ms);
            match &mem.description {
                Some(desc) => format!("- {}{} ({}): {}", tag, mem.filename, ts, desc),
                None => format!("- {}{} ({})", tag, mem.filename, ts),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_timestamp_iso(mtime_ms: u64) -> String {
    let secs = (mtime_ms / 1000) as i64;
    let nanos = ((mtime_ms % 1000) * 1_000_000) as u32;

    // Simple ISO 8601 formatting without chrono dependency
    let epoch = SystemTime::UNIX_EPOCH + std::time::Duration::new(secs as u64, nanos);
    let datetime: SystemTime = epoch;
    let duration = datetime
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = duration.as_secs();

    let days = total_secs / 86400;
    let time_of_day = total_secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Days since epoch to Y-M-D (simplified)
    let mut year = 1970i32;
    let mut remaining_days = days as i32;
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        year += 1;
    }
    let mut month = 1u32;
    let days_in_months = if is_leap_year(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    for &dim in &days_in_months {
        if remaining_days < dim {
            break;
        }
        remaining_days -= dim;
        month += 1;
    }
    let day = remaining_days as u32 + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

// --- MEMORY.md index ------------------------------------------------

/// Load and optionally truncate the MEMORY.md index file.
pub fn load_memory_index(dir: &Path) -> String {
    let path = dir.join(ENTRYPOINT_NAME);
    // Missing MEMORY.md is the legitimate "no index yet" case and
    // stays quiet. Anything else (permission flip, partial mount)
    // silently produces "no index" — the LLM then loses the user's
    // curated entrypoint without warning. Warn so the cause is
    // visible; still return empty so the rest of memory loading
    // can proceed.
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %path.display(),
                    error = %err,
                    "memory::manifest::load_memory_index: read failed; MEMORY.md will be invisible to the LLM"
                );
            }
            return String::new();
        }
    };

    truncate_entrypoint(&content)
}

/// Truncate content to fit within line and byte limits.
fn truncate_entrypoint(content: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();

    let (truncated_lines, was_line_truncated) = if lines.len() > MAX_ENTRYPOINT_LINES {
        (&lines[..MAX_ENTRYPOINT_LINES], true)
    } else {
        (&lines[..], false)
    };

    let mut result = truncated_lines.join("\n");

    let was_byte_truncated = if result.len() > MAX_ENTRYPOINT_BYTES {
        // MAX_ENTRYPOINT_BYTES can land inside a multi-byte UTF-8 char (em-dash,
        // CJK, emoji). Snap the budget down to the nearest char boundary first;
        // both `result[..limit]` and `String::truncate(limit)` panic otherwise.
        let safe_limit = crate::utils::safe_truncate_utf8(&result, MAX_ENTRYPOINT_BYTES).len();
        // `rfind('\n')` yields an ASCII '\n' index, always a valid boundary.
        if let Some(last_nl) = result[..safe_limit].rfind('\n') {
            result.truncate(last_nl);
        } else {
            result.truncate(safe_limit);
        }
        true
    } else {
        false
    };

    if was_line_truncated || was_byte_truncated {
        let reason = if was_line_truncated && was_byte_truncated {
            format!(
                "both {} line and {} byte limits",
                MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES
            )
        } else if was_line_truncated {
            format!("{} line limit", MAX_ENTRYPOINT_LINES)
        } else {
            format!("{} byte limit", MAX_ENTRYPOINT_BYTES)
        };
        result.push_str(&format!(
            "\n\n[MEMORY.md truncated — exceeded {}. Keep the index concise: one line per memory, under ~150 chars.]",
            reason
        ));
    }

    result
}

// --- Memory age / freshness -----------------------------------------

/// Days elapsed since mtime. Floor-rounded — 0 for today, 1 for yesterday.
fn memory_age_days(mtime_ms: u64) -> u64 {
    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    if mtime_ms >= now_ms {
        return 0;
    }

    (now_ms - mtime_ms) / 86_400_000
}

/// Human-readable age string.
pub fn memory_age(mtime_ms: u64) -> String {
    let days = memory_age_days(mtime_ms);
    match days {
        0 => "today".to_string(),
        1 => "yesterday".to_string(),
        n => format!("{} days ago", n),
    }
}

/// Staleness caveat for memories older than a week, bucketed coarsely.
///
/// Buckets ("over a week old" / "over a month old") instead of exact day
/// counts keep the injected prompt section byte-stable day over day, so
/// provider prompt caches are not busted by a daily one-character diff.
pub fn memory_freshness_text(mtime_ms: u64) -> String {
    let days = memory_age_days(mtime_ms);
    if days < 7 {
        return String::new();
    }

    let age_bucket = if days > 30 {
        "over a month old"
    } else {
        "over a week old"
    };

    format!(
        "This memory is {}. \
         Memories are point-in-time observations, not live state — \
         claims about code behavior or file:line citations may be outdated. \
         Verify against current code before asserting as fact.",
        age_bucket
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[test]
    fn test_scan_memory_files() {
        let tmp = TempDir::new().unwrap();
        let mem_dir = tmp.path();

        fs::write(
            mem_dir.join("user_prefs.md"),
            "---\nname: User Prefs\ndescription: User preferences\ntype: user\n---\nContent",
        )
        .unwrap();
        fs::write(
            mem_dir.join("workspace_arch.md"),
            "---\nname: Architecture\ndescription: Arch decisions\ntype: workspace\n---\nContent",
        )
        .unwrap();
        fs::write(mem_dir.join("no_frontmatter.md"), "Just plain markdown").unwrap();
        fs::write(mem_dir.join("MEMORY.md"), "- [Prefs](user_prefs.md)").unwrap();
        fs::write(mem_dir.join("notes.txt"), "not a memory").unwrap();

        let headers = scan_memory_files(mem_dir);
        assert_eq!(headers.len(), 3);

        let filenames: Vec<&str> = headers.iter().map(|h| h.filename.as_str()).collect();
        assert!(filenames.contains(&"user_prefs.md"));
        assert!(filenames.contains(&"workspace_arch.md"));
        assert!(filenames.contains(&"no_frontmatter.md"));
        assert!(!filenames.contains(&"MEMORY.md"));

        let user_mem = headers
            .iter()
            .find(|h| h.filename == "user_prefs.md")
            .unwrap();
        assert_eq!(user_mem.description.as_deref(), Some("User preferences"));
        assert_eq!(user_mem.memory_type, Some(MemoryType::User));

        let plain_mem = headers
            .iter()
            .find(|h| h.filename == "no_frontmatter.md")
            .unwrap();
        assert!(plain_mem.description.is_none());
        assert!(plain_mem.memory_type.is_none());
    }

    #[test]
    fn test_scan_memory_files_nonexistent_dir() {
        let headers = scan_memory_files(Path::new("/nonexistent/path"));
        assert!(headers.is_empty());
    }

    #[test]
    fn test_scan_recursive_subdir() {
        let tmp = TempDir::new().unwrap();
        let mem_dir = tmp.path();

        fs::create_dir_all(mem_dir.join("topics")).unwrap();
        fs::write(
            mem_dir.join("topics/api_patterns.md"),
            "---\nname: API Patterns\ndescription: REST patterns\ntype: reference\n---\nContent",
        )
        .unwrap();
        fs::write(
            mem_dir.join("top_level.md"),
            "---\nname: Top\ndescription: Top level\ntype: workspace\n---\nContent",
        )
        .unwrap();

        let headers = scan_memory_files(mem_dir);
        assert_eq!(headers.len(), 2);

        let filenames: Vec<&str> = headers.iter().map(|h| h.filename.as_str()).collect();
        assert!(filenames.iter().any(|f| f.contains("api_patterns.md")));
        assert!(filenames.contains(&"top_level.md"));
    }

    #[test]
    fn test_format_memory_manifest() {
        let headers = vec![
            MemoryHeader {
                filename: "user_prefs.md".to_string(),
                file_path: PathBuf::from("/tmp/user_prefs.md"),
                mtime_ms: 1712448000000, // 2024-04-07T00:00:00Z
                description: Some("User preferences".to_string()),
                memory_type: Some(MemoryType::User),
            },
            MemoryHeader {
                filename: "notes.md".to_string(),
                file_path: PathBuf::from("/tmp/notes.md"),
                mtime_ms: 1712448000000,
                description: None,
                memory_type: None,
            },
        ];

        let manifest = format_memory_manifest(&headers);
        assert!(manifest.contains("[user] user_prefs.md"));
        assert!(manifest.contains("User preferences"));
        assert!(manifest.contains("notes.md"));
    }

    #[test]
    fn test_load_memory_index_truncation() {
        let tmp = TempDir::new().unwrap();
        let mem_dir = tmp.path();

        let lines: Vec<String> = (1..=250)
            .map(|i| format!("- [Memory {}](memory_{}.md) — description {}", i, i, i))
            .collect();
        fs::write(mem_dir.join("MEMORY.md"), lines.join("\n")).unwrap();

        let result = load_memory_index(mem_dir);
        let result_lines: Vec<&str> = result.lines().collect();

        assert!(result_lines.len() > 200);
        assert!(result.contains("[MEMORY.md truncated"));
        assert!(result.contains("200 line limit"));
    }

    #[test]
    fn test_truncate_entrypoint_no_truncation() {
        let content = "- [A](a.md)\n- [B](b.md)\n- [C](c.md)";
        let result = truncate_entrypoint(content);
        assert_eq!(result, content);
        assert!(!result.contains("truncated"));
    }

    #[test]
    fn test_truncate_entrypoint_line_limit() {
        let content: String = (1..=MAX_ENTRYPOINT_LINES + 50)
            .map(|i| format!("line {}", i))
            .collect::<Vec<_>>()
            .join("\n");
        let result = truncate_entrypoint(&content);
        assert!(result.contains("[MEMORY.md truncated"));
        assert!(result.contains("line limit"));
    }

    // Regression: MAX_ENTRYPOINT_BYTES landing inside a multi-byte UTF-8 char
    // used to panic ("byte index 25000 is not a char boundary; it is inside
    // '—'") via both `result[..MAX_ENTRYPOINT_BYTES]` and `String::truncate`.
    #[test]
    fn test_truncate_entrypoint_byte_limit_mid_char_no_panic() {
        // Em-dash '—' is 3 bytes; no string of them lands a boundary exactly on
        // 25_000, so the byte limit always falls inside a char. No newlines, so
        // the rfind('\n') branch falls through to truncate(safe_limit).
        let content = "—".repeat(MAX_ENTRYPOINT_BYTES / 3 + 100);
        assert!(content.len() > MAX_ENTRYPOINT_BYTES);
        assert!(!content.is_char_boundary(MAX_ENTRYPOINT_BYTES));

        let result = truncate_entrypoint(&content);

        // Must not panic, must be valid UTF-8, and the truncated body (before
        // the appended notice) must be at or under the byte budget.
        assert!(std::str::from_utf8(result.as_bytes()).is_ok());
        assert!(result.contains("[MEMORY.md truncated"));
        assert!(result.contains("byte limit"));
        let body = result.split("\n\n[MEMORY.md truncated").next().unwrap();
        assert!(body.len() <= MAX_ENTRYPOINT_BYTES);
        assert!(body.is_char_boundary(body.len()));
    }

    // Same panic class but with CJK content and embedded newlines so the
    // rfind('\n') branch (slice of a non-boundary budget) is exercised. Uses
    // few, long lines to stay under the line cap and trip the byte cap instead.
    #[test]
    fn test_truncate_entrypoint_byte_limit_cjk_with_newlines_no_panic() {
        // 300-byte CJK lines (100 chars * 3 bytes), well under the 200-line cap
        // but together far over the 25_000-byte budget.
        let line = "你".repeat(100);
        let content: String = std::iter::repeat_n(line.as_str(), 100)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(content.lines().count() <= MAX_ENTRYPOINT_LINES);
        assert!(content.len() > MAX_ENTRYPOINT_BYTES);
        assert!(!content.is_char_boundary(MAX_ENTRYPOINT_BYTES));

        let result = truncate_entrypoint(&content);

        assert!(std::str::from_utf8(result.as_bytes()).is_ok());
        assert!(result.contains("[MEMORY.md truncated"));
        assert!(result.contains("byte limit"));
        let body = result.split("\n\n[MEMORY.md truncated").next().unwrap();
        assert!(body.len() <= MAX_ENTRYPOINT_BYTES);
        assert!(body.is_char_boundary(body.len()));
    }

    #[test]
    fn test_load_memory_index_missing() {
        let tmp = TempDir::new().unwrap();
        let result = load_memory_index(tmp.path());
        assert!(result.is_empty());
    }

    #[test]
    fn test_memory_age() {
        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        assert_eq!(memory_age(now_ms), "today");
        assert_eq!(memory_age(now_ms - 86_400_000), "yesterday");
        assert_eq!(memory_age(now_ms - 3 * 86_400_000), "3 days ago");
    }

    #[test]
    fn test_memory_freshness_text_buckets() {
        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        // Under a week: no caveat at all (byte-stable — no daily diff).
        assert!(memory_freshness_text(now_ms).is_empty());
        assert!(memory_freshness_text(now_ms - 86_400_000).is_empty());
        assert!(memory_freshness_text(now_ms - 6 * 86_400_000).is_empty());

        // 7–30 days: coarse "over a week old" bucket, no exact day count.
        let week_old = memory_freshness_text(now_ms - 10 * 86_400_000);
        assert!(week_old.contains("over a week old"));
        assert!(!week_old.contains("10"));
        assert!(week_old.contains("Verify against current code"));
        assert_eq!(week_old, memory_freshness_text(now_ms - 29 * 86_400_000));

        // Over 30 days: "over a month old" bucket.
        let month_old = memory_freshness_text(now_ms - 45 * 86_400_000);
        assert!(month_old.contains("over a month old"));
        assert!(!month_old.contains("45"));
        assert_eq!(month_old, memory_freshness_text(now_ms - 400 * 86_400_000));
    }
}
