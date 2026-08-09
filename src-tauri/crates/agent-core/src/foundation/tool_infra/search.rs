//! Shared search service: code, file, and symbol search.
//!
//! Used by the agent `SearchTool`. Delegates to native `search::` modules
//! which provide parallel regex search (via `grep-searcher` + `rayon`) and
//! fuzzy file search (via `ignore` + `nucleo`).
//!
//! No wrapper types — the native result types are flattened directly in the
//! `*_formatted` functions which produce agent-friendly text.

#[cfg(test)]
#[path = "tests/search_tests.rs"]
mod tests;

use std::path::{Path, PathBuf};

use super::SEARCH_TIMEOUT;

/// A glob's match cap is not a traversal cap: a rare filename can require
/// walking an enormous tree before the first match. Bound the walk itself so a
/// search cannot strand a session on a pathological local filesystem.
const GLOB_MAX_ENTRIES_SCANNED: usize = 20_000;
const GLOB_MAX_DEPTH: usize = 24;

/// Runaway guard on formatted search output. Deliberately far above the
/// `code_search` tool's 20K per-result budget: the turn executor's
/// truncate-or-persist layer stubs oversized results to disk retrievably,
/// so this cap only bounds pathological cases (e.g. matches inside
/// megabyte-long minified lines) before they reach that layer.
const SEARCH_RUNAWAY_GUARD_CHARS: usize = 2_000_000;

// ============================================
// Code Search (regex via grep-searcher)
// ============================================

/// Search code by regex pattern and return formatted results.
///
/// Calls `search::code::commands::search_code_fast_inner` (ripgrep core)
/// and flattens file-grouped results into `path:line:content` lines.
pub async fn code_search_formatted(
    pattern: &str,
    search_path: &Path,
    max_results: usize,
    context_lines: Option<usize>,
) -> Result<String, String> {
    let pattern_owned = pattern.to_string();
    let search_path_owned = search_path.to_path_buf();

    let filters = search::code::commands::SearchFilters {
        file_extensions: None,
        exclude_dirs: None,
        case_sensitive: Some(false),
        whole_word: Some(false),
        use_regex: Some(true),
        max_results: Some(max_results),
    };

    let native_results = tokio::time::timeout(
        SEARCH_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            search::code::commands::search_code_fast_inner(
                &pattern_owned,
                &search_path_owned.to_string_lossy(),
                filters,
                None,
            )
        }),
    )
    .await
    .map_err(|_| format!("Code search timed out after {}s", SEARCH_TIMEOUT.as_secs()))?
    .map_err(|err| format!("Code search task failed: {err}"))?
    .map_err(|err| format!("Code search failed: {err}"))?
    .results;

    if native_results.is_empty() {
        return Ok("No matches found.".to_string());
    }

    let ctx = context_lines.unwrap_or(0);

    let mut lines = Vec::new();
    let mut match_count = 0;
    'outer: for file_result in &native_results {
        if ctx > 0 {
            let file_lines = read_file_lines_cached(&file_result.file_path);
            for m in &file_result.matches {
                let line_idx = m.line.saturating_sub(1);
                let total = file_lines.len();
                let ctx_start = line_idx.saturating_sub(ctx);
                let ctx_end = (line_idx + ctx + 1).min(total);

                if match_count > 0 {
                    lines.push("--".to_string());
                }
                for idx in ctx_start..ctx_end {
                    let sep = if idx == line_idx { ":" } else { "-" };
                    lines.push(
                        format!("{}{}{}{}", file_result.file_path, sep, idx + 1, sep)
                            + file_lines.get(idx).unwrap_or(&String::new()),
                    );
                }
                match_count += 1;
                if match_count >= max_results {
                    break 'outer;
                }
            }
        } else {
            for m in &file_result.matches {
                lines.push(format!("{}:{}:{}", file_result.file_path, m.line, m.text));
                match_count += 1;
                if match_count >= max_results {
                    break 'outer;
                }
            }
        }
    }

    let formatted = lines.join("\n");
    Ok(truncate_output(formatted, SEARCH_RUNAWAY_GUARD_CHARS))
}

pub async fn code_search_multi_formatted(
    pattern: &str,
    search_paths: &[PathBuf],
    max_results: usize,
    context_lines: Option<usize>,
) -> Result<String, String> {
    let mut sections = Vec::new();
    let mut remaining = max_results;

    for search_path in search_paths {
        if remaining == 0 {
            break;
        }
        let result = code_search_formatted(pattern, search_path, remaining, context_lines).await?;
        if result == "No matches found." {
            continue;
        }
        sections.push(format!("## {}\n{}", search_path.display(), result));
        remaining = remaining.saturating_sub(count_grep_matches(&result));
    }

    if sections.is_empty() {
        return Ok("No matches found.".to_string());
    }

    Ok(truncate_output(
        sections.join("\n\n"),
        SEARCH_RUNAWAY_GUARD_CHARS,
    ))
}

fn read_file_lines_cached(path: &str) -> Vec<String> {
    // If a file showed up in the native search index but disappeared
    // (or became unreadable) before we render context lines, the
    // search result row is still meaningful — just without context.
    // Warn so a transient FS issue or stale index is visible
    // instead of silently producing context-less search hits.
    match std::fs::read_to_string(path) {
        Ok(content) => content.lines().map(String::from).collect(),
        Err(err) => {
            tracing::warn!(
                path = %path,
                error = %err,
                "search::read_file_lines_cached: file read failed; rendering match without context"
            );
            Vec::new()
        }
    }
}

// ============================================
// File Search (fuzzy via nucleo)
// ============================================

/// Detect glob-style extension patterns like `*.ts`, `**/*.tsx`, `*.{ts,tsx}`.
/// Returns `(query_for_fuzzy, Option<file_extensions>)`.
fn parse_glob_extensions(pattern: &str) -> (String, Option<Vec<String>>) {
    let trimmed = pattern.trim();

    // Strip leading path globs: "**/*.ts" → "*.ts"
    let stem = trimmed.rsplit('/').next().unwrap_or(trimmed);

    // Match `*.ext` or `*.{ext1,ext2,...}`
    if let Some(rest) = stem.strip_prefix("*.") {
        // Brace expansion: `*.{ts,tsx}`
        if rest.starts_with('{') && rest.ends_with('}') {
            let inner = &rest[1..rest.len() - 1];
            let exts: Vec<String> = inner
                .split(',')
                .map(|ext| format!(".{}", ext.trim()))
                .collect();
            if !exts.is_empty() {
                return (String::new(), Some(exts));
            }
        }
        // Simple: `*.ts`
        if !rest.is_empty() && rest.chars().all(|ch| ch.is_alphanumeric() || ch == '_') {
            return (String::new(), Some(vec![format!(".{rest}")]));
        }
    }

    (pattern.to_string(), None)
}

/// Search for files by name pattern and return formatted results.
///
/// Calls `search::file::search_files_fuzzy` (ignore + nucleo matcher).
/// Glob patterns like `*.ts` or `**/*.{ts,tsx}` are automatically
/// converted to extension filters so the fuzzy engine returns matches.
pub async fn file_search_formatted(
    pattern: &str,
    search_path: &Path,
    max_results: usize,
) -> Result<String, String> {
    let (query, file_extensions) = parse_glob_extensions(pattern);
    let search_path_owned = search_path.to_path_buf();

    let options = search::file::SearchOptions {
        root_path: search_path_owned.to_string_lossy().to_string(),
        query,
        max_results: Some(max_results),
        file_extensions,
        exclude_dirs: None,
    };

    let native_results =
        tokio::time::timeout(SEARCH_TIMEOUT, search::file::search_files_fuzzy(options))
            .await
            .map_err(|_| format!("File search timed out after {}s", SEARCH_TIMEOUT.as_secs()))?
            .map_err(|err| format!("File search failed: {err}"))?;

    if native_results.files.is_empty() {
        return Ok("No files found.".to_string());
    }

    Ok(native_results
        .files
        .iter()
        .map(|entry| entry.path.as_str())
        .collect::<Vec<_>>()
        .join("\n"))
}

pub async fn file_search_multi_formatted(
    pattern: &str,
    search_paths: &[PathBuf],
    max_results: usize,
) -> Result<String, String> {
    let mut sections = Vec::new();
    let mut remaining = max_results;

    for search_path in search_paths {
        if remaining == 0 {
            break;
        }
        let result = file_search_formatted(pattern, search_path, remaining).await?;
        if result == "No files found." {
            continue;
        }
        sections.push(format!("## {}\n{}", search_path.display(), result));
        remaining = remaining.saturating_sub(count_non_empty_lines(&result));
    }

    if sections.is_empty() {
        return Ok("No files found.".to_string());
    }

    Ok(truncate_output(
        sections.join("\n\n"),
        SEARCH_RUNAWAY_GUARD_CHARS,
    ))
}

// ============================================
// Glob Search (true glob pattern matching)
// ============================================

/// Match files by glob pattern (e.g. `src/**/*.ts`, `*.{rs,toml}`).
/// Uses the `ignore` crate walker (respects .gitignore) with `globset` matching.
///
/// Recursive globbing on a remote mount is rejected before a walker starts:
/// a wall-clock wrapper around `spawn_blocking` cannot interrupt an NFS
/// directory RPC stuck in kernel D-state. Local walks are additionally bounded
/// by entry count and depth, because `max_results` only limits matches.
pub async fn glob_search_formatted(
    pattern: &str,
    search_path: &std::path::Path,
    max_results: usize,
) -> Result<String, String> {
    ensure_glob_scope_is_safe(pattern, search_path)?;

    let pattern_owned = pattern.to_string();
    let search_path_owned = search_path.to_path_buf();

    tokio::task::spawn_blocking(move || {
        let glob = ignore::overrides::OverrideBuilder::new(&search_path_owned)
            .add(&pattern_owned)
            .map_err(|err| format!("Invalid glob pattern '{}': {err}", pattern_owned))?
            .build()
            .map_err(|err| format!("Failed to compile glob: {err}"))?;

        let walker = ignore::WalkBuilder::new(&search_path_owned)
            .hidden(false)
            .git_ignore(true)
            .max_depth(Some(GLOB_MAX_DEPTH))
            .overrides(glob)
            .build();

        collect_bounded_glob_matches(
            walker,
            &search_path_owned,
            max_results,
            GLOB_MAX_ENTRIES_SCANNED,
            GLOB_MAX_DEPTH,
        )
    })
    .await
    .map_err(|err| format!("Glob search task failed: {err}"))?
}

fn collect_bounded_glob_matches(
    walker: ignore::Walk,
    search_path: &Path,
    max_results: usize,
    max_entries_scanned: usize,
    max_depth: usize,
) -> Result<String, String> {
    let prefix = search_path.to_string_lossy();
    let mut scanned_entries = 0usize;
    let mut reached_depth_limit = false;
    let mut matches: Vec<String> = Vec::new();
    for entry in walker {
        let entry = entry.map_err(|err| {
                format!(
                    "Glob traversal failed under '{}': {err}. Narrow repo_path to an accessible subdirectory.",
                    search_path.display()
                )
            })?;
        scanned_entries += 1;
        if scanned_entries > max_entries_scanned {
            return Err(format!(
                "Glob traversal stopped after scanning {max_entries_scanned} entries under '{}'. Narrow repo_path to a known subdirectory or use a non-recursive pattern.",
                search_path.display()
            ));
        }
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            reached_depth_limit |= entry.depth() == max_depth;
            continue;
        }
        let path_str = entry.path().to_string_lossy();
        let relative = path_str
            .strip_prefix(prefix.as_ref())
            .unwrap_or(&path_str)
            .trim_start_matches('/');
        matches.push(relative.to_string());
        if matches.len() >= max_results {
            break;
        }
    }

    if matches.is_empty() {
        if reached_depth_limit {
            return Err(format!(
                    "Glob traversal reached the maximum depth of {max_depth} under '{}' before finding a match. Narrow repo_path to a known subdirectory.",
                    search_path.display()
                ));
        }
        return Ok("No files matched.".to_string());
    }
    matches.sort();
    if reached_depth_limit && matches.len() < max_results {
        return Err(format!(
            "Glob traversal reached the maximum depth of {max_depth} under '{}' after finding {} match(es); results may be incomplete. Narrow repo_path to a known subdirectory.",
            search_path.display(),
            matches.len()
        ));
    }
    Ok(matches.join("\n"))
}

fn ensure_glob_scope_is_safe(pattern: &str, search_path: &Path) -> Result<(), String> {
    let filesystem = filesystem_type_for_path(search_path);
    ensure_glob_scope_is_safe_on_filesystem(pattern, search_path, filesystem.as_deref())
}

fn ensure_glob_scope_is_safe_on_filesystem(
    pattern: &str,
    search_path: &Path,
    filesystem: Option<&str>,
) -> Result<(), String> {
    let recursive = pattern.contains("**");
    let remote = filesystem.is_some_and(is_remote_filesystem_type);
    if recursive && remote {
        return Err(format!(
            "Recursive glob '{}' is blocked for network filesystem '{}' at '{}': it can stall the active session while traversing a remote tree. Use a known narrower subdirectory as repo_path, or a non-recursive filename pattern.",
            pattern,
            filesystem.unwrap_or("unknown"),
            search_path.display(),
        ));
    }
    Ok(())
}

fn is_remote_filesystem_type(filesystem: &str) -> bool {
    matches!(
        filesystem.to_ascii_lowercase().as_str(),
        "nfs" | "nfs4" | "cifs" | "smbfs" | "sshfs" | "fuse.sshfs" | "9p" | "ceph" | "glusterfs"
    )
}

/// Resolve the deepest matching Linux mountpoint without touching the target
/// tree. `/proc/mounts` is kernel-provided and local, so this guard runs before
/// any potentially blocking remote-directory traversal.
fn filesystem_type_for_path(path: &Path) -> Option<String> {
    let mounts = std::fs::read_to_string("/proc/mounts").ok()?;
    filesystem_type_for_path_from_mounts(path, &mounts)
}

fn filesystem_type_for_path_from_mounts(path: &Path, mounts: &str) -> Option<String> {
    mounts
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let _source = fields.next()?;
            let mountpoint = unescape_proc_mount_path(fields.next()?);
            let filesystem = fields.next()?.to_string();
            Some((PathBuf::from(mountpoint), filesystem))
        })
        .filter(|(mountpoint, _)| path.starts_with(mountpoint))
        .max_by_key(|(mountpoint, _)| mountpoint.components().count())
        .map(|(_, filesystem)| filesystem)
}

fn unescape_proc_mount_path(value: &str) -> String {
    value
        .replace(r"\040", " ")
        .replace(r"\011", "\t")
        .replace(r"\012", "\n")
        .replace(r"\134", "\\")
}

pub async fn glob_search_multi_formatted(
    pattern: &str,
    search_paths: &[PathBuf],
    max_results: usize,
) -> Result<String, String> {
    let mut sections = Vec::new();
    let mut remaining = max_results;

    for search_path in search_paths {
        if remaining == 0 {
            break;
        }
        let result = glob_search_formatted(pattern, search_path, remaining).await?;
        if result == "No files matched." {
            continue;
        }
        sections.push(format!("## {}\n{}", search_path.display(), result));
        remaining = remaining.saturating_sub(count_non_empty_lines(&result));
    }

    if sections.is_empty() {
        return Ok("No files matched.".to_string());
    }

    Ok(truncate_output(
        sections.join("\n\n"),
        SEARCH_RUNAWAY_GUARD_CHARS,
    ))
}

// ============================================
// Symbol Search (tree-sitter)
// ============================================

/// Search for symbols (functions, classes, etc.) and return formatted results.
pub async fn symbol_search_formatted(
    query: &str,
    repo_paths: Vec<String>,
    max_results: usize,
) -> Result<String, String> {
    let query_owned = query.to_string();

    let native_results = tokio::time::timeout(
        SEARCH_TIMEOUT,
        search::code::commands::search_symbols(query_owned, repo_paths, None),
    )
    .await
    .map_err(|_| {
        format!(
            "Symbol search timed out after {}s",
            SEARCH_TIMEOUT.as_secs()
        )
    })?
    .map_err(|err| format!("Symbol search failed: {err}"))?;

    if native_results.is_empty() {
        return Ok("No symbols found.".to_string());
    }

    let mut lines = Vec::new();
    'outer: for file_result in &native_results {
        for sym in &file_result.symbols {
            lines.push(format!(
                "{}:{}  {} ({})",
                file_result.file_path, sym.line, sym.name, sym.kind
            ));
            if lines.len() >= max_results {
                break 'outer;
            }
        }
    }

    Ok(lines.join("\n"))
}

pub async fn index_status_formatted() -> Result<String, String> {
    Ok(
        "Code indexing is archived in this build. Use grep, glob, find_files, or symbols."
            .to_string(),
    )
}

// ============================================
// Helpers
// ============================================

fn count_non_empty_lines(text: &str) -> usize {
    text.lines().filter(|line| !line.trim().is_empty()).count()
}

fn count_grep_matches(text: &str) -> usize {
    text.lines()
        .filter(|line| {
            line.split_once(':')
                .and_then(|(_, rest)| rest.split_once(':'))
                .is_some_and(|(line_number, _)| line_number.chars().all(|ch| ch.is_ascii_digit()))
        })
        .count()
}

fn truncate_output(text: String, max_chars: usize) -> String {
    if text.len() > max_chars {
        let truncated: String = crate::utils::safe_truncate_chars_to_string(&text, max_chars);
        format!(
            "{}\n\n[...truncated, {} total chars]",
            truncated,
            text.len()
        )
    } else {
        text
    }
}
