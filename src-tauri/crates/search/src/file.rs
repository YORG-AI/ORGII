//! File Search Module
//!
//! High-performance fuzzy file search using the ignore crate for directory
//! traversal and nucleo for fuzzy matching (same algorithm as Helix editor).
//!
//! Features:
//! - Fast directory traversal with .gitignore support
//! - Fuzzy matching for filename and path search
//! - Path-aware scoring (filename matches rank higher)
//! - Configurable exclusions
//! - Cached file index for repeated searches

use ignore::WalkBuilder;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

#[path = "file/index_cache.rs"]
mod index_cache;

use index_cache::FilePathIndexCache;

// ============================================
// Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSearchResult {
    pub path: String,
    #[serde(rename = "type")]
    pub file_type: String, // "file" or "folder"
    pub score: i64,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResults {
    pub files: Vec<FileSearchResult>,
    pub folders: Vec<FileSearchResult>,
    pub total_indexed: usize,
    pub search_time_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchOptions {
    pub root_path: String,
    pub query: String,
    pub max_results: Option<usize>,
    pub file_extensions: Option<Vec<String>>,
    pub exclude_dirs: Option<Vec<String>>,
}

// ============================================
// File Index Cache
// ============================================

#[derive(Debug, Clone)]
struct FileEntry {
    path: String,
    filename: String,
    is_dir: bool,
}

/// File changes invalidate indexes through the repository watcher. This slow
/// safety TTL only recovers from a missed watcher event; it is not a polling
/// cadence and does not create background work by itself.
const CACHE_SAFETY_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_CACHED_FILE_INDEXES: usize = 4;

static FILE_INDEX_CACHE: LazyLock<FilePathIndexCache> =
    LazyLock::new(|| FilePathIndexCache::new(CACHE_SAFETY_TTL, MAX_CACHED_FILE_INDEXES));

const DEFAULT_EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "target",
    ".cache",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
];

fn default_excluded_dirs() -> Vec<String> {
    DEFAULT_EXCLUDED_DIRS
        .iter()
        .map(|directory| (*directory).to_string())
        .collect()
}

// ============================================
// Directory Traversal
// ============================================

/// Build a file index for the given root path
fn build_file_index(root_path: &str, exclude_dirs: &[String]) -> Vec<FileEntry> {
    let start = Instant::now();

    // Build a set for O(1) lookups in filter_entry
    let exclude_set: std::collections::HashSet<String> = exclude_dirs.iter().cloned().collect();

    let mut builder = WalkBuilder::new(root_path);

    // Configure the walker
    // For Cmd+P file search, we want to find ALL files including gitignored ones
    // (like .env, build artifacts, etc.) - users should be able to open any file
    builder
        .hidden(false) // Include hidden files (e.g., .env, .eslintrc)
        .git_ignore(false) // Don't respect .gitignore - show all files
        .git_global(false) // Don't respect global gitignore
        .git_exclude(false) // Don't respect .git/info/exclude
        .ignore(false) // Don't respect .ignore files
        .parents(false) // Don't check parent directories for ignore files
        .max_depth(Some(15)) // Limit depth to prevent infinite recursion
        .follow_links(false); // Don't follow symlinks

    // Skip excluded directories at the walker level so we never descend
    // into node_modules, .git, etc. This is orders of magnitude faster
    // than post-filtering.
    let root = std::path::PathBuf::from(root_path);
    let filter_root = root.clone();
    builder.filter_entry(move |entry| {
        if entry.file_type().is_some_and(|ft| ft.is_dir()) {
            let name = entry.file_name().to_string_lossy();
            if exclude_set.contains(name.as_ref()) {
                return false;
            }

            // ORG2 runtime worktrees contain full repository copies and their
            // generated artifacts. They are implementation state, not distinct
            // user files, so descending into them multiplies every index walk.
            if let Ok(relative) = entry.path().strip_prefix(&filter_root) {
                if relative == std::path::Path::new(".worktrees")
                    || relative == std::path::Path::new(".orgii/worktrees")
                {
                    return false;
                }
            }
        }
        true
    });

    let walker = builder.build();

    let entries: Vec<FileEntry> = walker
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            // Skip the root directory itself
            entry.path() != root
        })
        .map(|entry| {
            let path = entry.path();
            let is_dir = path.is_dir();
            let filename = path
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default();

            FileEntry {
                path: path.to_string_lossy().to_string(),
                filename,
                is_dir,
            }
        })
        .collect();

    let duration = start.elapsed();
    info!(
        entries = entries.len(),
        ?duration,
        "search::file: indexed entries"
    );

    entries
}

/// Get or build file index with caching.
///
/// IMPORTANT: The mutex is only held while reading/writing the HashMap,
/// **never** during the expensive `build_file_index` walk.  This means
/// concurrent searches for different repos proceed in parallel, and a
/// slow index build for repo A won't block a cached lookup for repo B.
fn get_file_index(root_path: &str, exclude_dirs: &[String]) -> Result<Arc<[FileEntry]>, String> {
    // Validate the path before spending time walking it. Protects against bad
    // descriptors after rapid repo switches.
    let root = std::path::Path::new(root_path);
    if !root.exists() || !root.is_dir() {
        warn!(
            root_path = %root_path,
            "search::file: root path invalid or gone; skipping index"
        );
        return Ok(Arc::from(Vec::<FileEntry>::new()));
    }

    FILE_INDEX_CACHE.get_or_build(root_path, exclude_dirs, || {
        build_file_index(root_path, exclude_dirs)
    })
}

// ============================================
// Fuzzy Matching
// ============================================

/// Score a single entry against the query using nucleo fuzzy matching
fn score_entry(
    entry: &FileEntry,
    pattern: &Pattern,
    matcher: &mut Matcher,
    buf: &mut Vec<char>,
) -> Option<i64> {
    buf.clear();

    // Convert filename to Utf32Str for nucleo
    let filename_utf32 = Utf32Str::new(&entry.filename, buf);

    // Try matching against filename first (higher priority)
    if let Some(score) = pattern.score(filename_utf32, matcher) {
        // Boost filename matches significantly
        let boosted_score = (score as i64) * 2;
        return Some(boosted_score);
    }

    // Clear buffer and try matching against full path
    buf.clear();
    let path_utf32 = Utf32Str::new(&entry.path, buf);

    pattern.score(path_utf32, matcher).map(i64::from)
}

/// Perform fuzzy search on the file index
fn fuzzy_search(
    entries: &[FileEntry],
    query: &str,
    max_results: usize,
    file_extensions: Option<&[String]>,
) -> Vec<(FileEntry, i64)> {
    if query.is_empty() {
        // No query — return first N entries, filtered by extension if set
        let iter = entries.iter().filter(|entry| {
            if let Some(extensions) = file_extensions {
                if !entry.is_dir {
                    return extensions.iter().any(|ext| entry.filename.ends_with(ext));
                }
            }
            true
        });
        return iter.take(max_results).map(|e| (e.clone(), 0)).collect();
    }

    // Create nucleo pattern and matcher
    let pattern = Pattern::new(
        query,
        CaseMatching::Smart,  // Case-insensitive unless query has uppercase
        Normalization::Smart, // Normalize unicode
        nucleo_matcher::pattern::AtomKind::Fuzzy,
    );

    // Use parallel processing for large indices
    let mut scored_results: Vec<(usize, i64)> = entries
        .par_iter()
        .enumerate()
        .filter(|entry| {
            let entry = entry.1;
            // Filter by extension if specified
            if let Some(extensions) = file_extensions {
                if !entry.is_dir {
                    let has_ext = extensions.iter().any(|ext| entry.filename.ends_with(ext));
                    if !has_ext {
                        return false;
                    }
                }
            }
            true
        })
        .map_init(
            || (Matcher::new(Config::DEFAULT), Vec::new()),
            |(matcher, buf), (index, entry)| {
                score_entry(entry, &pattern, matcher, buf).map(|score| (index, score))
            },
        )
        .filter_map(|result| result)
        .collect();

    if max_results == 0 {
        return Vec::new();
    }

    // Partition first so only the requested top-K needs a full sort.
    let compare_rank = |left: &(usize, i64), right: &(usize, i64)| {
        right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0))
    };
    if scored_results.len() > max_results {
        scored_results.select_nth_unstable_by(max_results, compare_rank);
        scored_results.truncate(max_results);
    }
    scored_results.sort_unstable_by(compare_rank);

    scored_results
        .into_iter()
        .map(|(index, score)| (entries[index].clone(), score))
        .collect()
}

// ============================================
// Tauri Commands
// ============================================

/// Search files in a directory with fuzzy matching
#[tauri::command]
pub async fn search_files_fuzzy(options: SearchOptions) -> Result<SearchResults, String> {
    tokio::task::spawn_blocking(move || {
        let start = Instant::now();

        // Validate root path exists
        let root = PathBuf::from(&options.root_path);
        if !root.exists() {
            return Err(format!("Path does not exist: {}", options.root_path));
        }

        // Default exclusions
        let default_excludes = default_excluded_dirs();

        let exclude_dirs = options.exclude_dirs.unwrap_or(default_excludes);
        let max_results = options.max_results.unwrap_or(50);

        // Get file index (cached or fresh)
        let entries = get_file_index(&options.root_path, &exclude_dirs)?;
        let total_indexed = entries.len();

        // Perform fuzzy search
        let file_extensions = options.file_extensions.as_deref();
        let results = fuzzy_search(
            entries.as_ref(),
            &options.query,
            max_results,
            file_extensions,
        );

        // Separate files and folders
        let mut files: Vec<FileSearchResult> = Vec::new();
        let mut folders: Vec<FileSearchResult> = Vec::new();

        for (entry, score) in results {
            let result = FileSearchResult {
                path: entry.path,
                file_type: if entry.is_dir {
                    "folder".to_string()
                } else {
                    "file".to_string()
                },
                score,
                filename: entry.filename,
            };

            if entry.is_dir {
                folders.push(result);
            } else {
                files.push(result);
            }
        }

        let search_time_ms = start.elapsed().as_millis() as u64;

        Ok(SearchResults {
            files,
            folders,
            total_indexed,
            search_time_ms,
        })
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Force re-index a workspace directory
#[tauri::command]
pub async fn index_project_files(
    root_path: String,
    exclude_dirs: Option<Vec<String>>,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let start = Instant::now();

        debug!(root_path = %root_path, "search::file: force re-indexing");

        // Validate root path exists
        let root = PathBuf::from(&root_path);
        if !root.exists() {
            return Err(format!("Path does not exist: {}", root_path));
        }

        // Default exclusions
        let default_excludes = default_excluded_dirs();

        let exclude_dirs = exclude_dirs.unwrap_or(default_excludes);

        // Invalidate every exclusion-policy variant for this root. A build
        // that started before this force request cannot repopulate the cache.
        FILE_INDEX_CACHE.invalidate_root(&root_path);
        let entries = get_file_index(&root_path, &exclude_dirs)?;
        let count = entries.len();

        let duration = start.elapsed();
        info!(entries = count, ?duration, "search::file: indexed entries");

        Ok(count)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Pre-warm the file index for a workspace directory.
///
/// Called from the frontend when a project is opened / switched so that
/// the first `@` search is instant instead of triggering a cold walk.
/// If the cache already has a fresh entry, this is a no-op.
#[tauri::command]
pub async fn prewarm_file_index(root_path: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&root_path);
        if !root.exists() || !root.is_dir() {
            return Err(format!(
                "Path does not exist or is not a directory: {}",
                root_path
            ));
        }

        debug!(root_path = %root_path, "search::file: prewarming index");

        let default_excludes = default_excluded_dirs();
        let entries = get_file_index(&root_path, &default_excludes)?;
        let count = entries.len();

        info!(entries = count, "search::file: prewarm complete");
        Ok(count)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Clear the file index cache
#[tauri::command]
pub fn clear_file_index_cache() {
    FILE_INDEX_CACHE.clear();
    info!("search::file: cache cleared");
}

/// Invalidate cached file indexes for one workspace root.
///
/// This command performs no scan. The next foreground prewarm or search builds
/// a fresh index, and any older in-flight generation is discarded.
#[tauri::command]
pub fn invalidate_file_index_cache(root_path: String) {
    FILE_INDEX_CACHE.invalidate_root(&root_path);
    debug!(root_path = %root_path, "search::file: root cache invalidated");
}

/// Find files by extension in a directory
/// Returns list of file paths matching any of the given extensions
#[tauri::command]
pub async fn find_files_by_extension(
    directory: String,
    extensions: Vec<String>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let start = Instant::now();

        debug!(
            ?extensions,
            directory = %directory,
            "search::file: finding files by extension"
        );

        // Validate directory exists
        let root = PathBuf::from(&directory);
        if !root.exists() {
            return Err(format!("Directory does not exist: {}", directory));
        }

        // Directories to skip entirely (the walker will NOT descend into them).
        let exclude_set: std::collections::HashSet<String> =
            default_excluded_dirs().into_iter().collect();

        let mut builder = WalkBuilder::new(&directory);

        builder
            .hidden(true)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .ignore(false)
            .parents(false)
            .max_depth(Some(20))
            .follow_links(false);

        builder.filter_entry(move |entry| {
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                let name = entry.file_name().to_string_lossy();
                if exclude_set.contains(name.as_ref()) {
                    return false;
                }
            }
            true
        });

        let walker = builder.build();

        let lower_extensions: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();

        let results: Vec<String> = walker
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let path = entry.path();

                if path.is_dir() {
                    return false;
                }

                if let Some(ext) = path.extension() {
                    let ext_str = ext.to_string_lossy().to_lowercase();
                    return lower_extensions.contains(&ext_str);
                }

                false
            })
            .map(|entry| entry.path().to_string_lossy().to_string())
            .collect();

        let duration = start.elapsed();
        info!(
            files = results.len(),
            ?extensions,
            ?duration,
            "search::file: found files by extension"
        );

        Ok(results)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

// ============================================
// Tests
// ============================================

#[cfg(test)]
#[path = "tests/file_tests.rs"]
mod tests;
