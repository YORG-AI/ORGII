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
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tracing::{debug, info, warn};

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

struct FileIndex {
    entries: Arc<Vec<FileEntry>>,
    _root_path: String,
    indexed_at: std::time::SystemTime,
    estimated_bytes: usize,
}

/// Cache TTL — 5 minutes.  The old 30 s TTL caused a cold re-walk every time
/// the user paused for half a minute between @ searches.
const CACHE_TTL_SECS: u64 = 300;
const MAX_CACHED_FILE_INDEXES: usize = 4;
const MAX_FILE_INDEX_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILE_INDEX_CACHE_BYTES: usize = 64 * 1024 * 1024;

static FILE_INDEX_CACHE: std::sync::LazyLock<Arc<Mutex<HashMap<String, FileIndex>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

fn prune_file_index_cache(cache: &mut HashMap<String, FileIndex>) {
    cache.retain(|_, index| {
        index
            .indexed_at
            .elapsed()
            .map(|elapsed| elapsed.as_secs() < CACHE_TTL_SECS)
            .unwrap_or(false)
    });

    let mut total_bytes = cache
        .values()
        .map(|index| index.estimated_bytes)
        .sum::<usize>();
    while cache.len() > MAX_CACHED_FILE_INDEXES || total_bytes > MAX_FILE_INDEX_CACHE_BYTES {
        let Some(oldest_key) = cache
            .iter()
            .min_by_key(|(_, index)| index.indexed_at)
            .map(|(root_path, _)| root_path.clone())
        else {
            break;
        };
        if let Some(removed) = cache.remove(&oldest_key) {
            total_bytes = total_bytes.saturating_sub(removed.estimated_bytes);
        }
    }
}

fn estimate_file_index_bytes(entries: &[FileEntry]) -> usize {
    std::mem::size_of_val(entries)
        + entries
            .iter()
            .map(|entry| entry.path.len() + entry.filename.len())
            .sum::<usize>()
}

fn insert_file_index_cache_entry(
    root_path: String,
    entries: Arc<Vec<FileEntry>>,
    indexed_at: std::time::SystemTime,
) {
    let estimated_bytes = estimate_file_index_bytes(&entries);
    if estimated_bytes > MAX_FILE_INDEX_BYTES {
        debug!(
            root_path = %root_path,
            entries = entries.len(),
            estimated_bytes,
            "search::file: index exceeds per-repository cache budget; using it for this request only"
        );
        return;
    }

    let mut cache = FILE_INDEX_CACHE.lock().unwrap();
    prune_file_index_cache(&mut cache);
    cache.insert(
        root_path.clone(),
        FileIndex {
            entries,
            _root_path: root_path,
            indexed_at,
            estimated_bytes,
        },
    );
    prune_file_index_cache(&mut cache);
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
    builder.filter_entry(move |entry| {
        if entry.file_type().is_some_and(|ft| ft.is_dir()) {
            let name = entry.file_name().to_string_lossy();
            if exclude_set.contains(name.as_ref()) {
                return false;
            }
        }
        true
    });

    let root = std::path::Path::new(root_path);
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
fn get_file_index(root_path: &str, exclude_dirs: &[String]) -> Arc<Vec<FileEntry>> {
    // 1. Quick check under the lock — return cached entries if fresh.
    {
        let mut cache = FILE_INDEX_CACHE.lock().unwrap();
        prune_file_index_cache(&mut cache);
        if let Some(index) = cache.get(root_path) {
            if let Ok(elapsed) = index.indexed_at.elapsed() {
                if elapsed.as_secs() < CACHE_TTL_SECS {
                    return Arc::clone(&index.entries);
                }
            }
        }
    } // ← lock released here

    // 2. Validate the path before spending time walking it.
    //    Protects against bad descriptors after rapid repo switches.
    let root = std::path::Path::new(root_path);
    if !root.exists() || !root.is_dir() {
        warn!(
            root_path = %root_path,
            "search::file: root path invalid or gone; skipping index"
        );
        return Arc::new(Vec::new());
    }

    // 3. Build index WITHOUT holding the lock.
    let entries = Arc::new(build_file_index(root_path, exclude_dirs));

    // 4. Re-acquire lock to store.
    insert_file_index_cache_entry(
        root_path.to_string(),
        Arc::clone(&entries),
        std::time::SystemTime::now(),
    );

    entries
}

// ============================================
// Fuzzy Matching
// ============================================

/// Score a single entry against the query using nucleo fuzzy matching
fn score_entry(
    entry: &FileEntry,
    pattern: &Pattern,
    matcher: &mut Matcher,
) -> Option<(FileEntry, i64)> {
    // Buffer for UTF-32 conversion
    let mut buf = Vec::new();

    // Convert filename to Utf32Str for nucleo
    let filename_utf32 = Utf32Str::new(&entry.filename, &mut buf);

    // Try matching against filename first (higher priority)
    if let Some(score) = pattern.score(filename_utf32, matcher) {
        // Boost filename matches significantly
        let boosted_score = (score as i64) * 2;
        return Some((entry.clone(), boosted_score));
    }

    // Clear buffer and try matching against full path
    buf.clear();
    let path_utf32 = Utf32Str::new(&entry.path, &mut buf);

    if let Some(score) = pattern.score(path_utf32, matcher) {
        return Some((entry.clone(), score as i64));
    }

    None
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
    let results: Vec<(FileEntry, i64)> = entries
        .par_iter()
        .filter(|entry| {
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
        .filter_map(|entry| {
            // Each thread gets its own matcher
            let mut matcher = Matcher::new(Config::DEFAULT);
            score_entry(entry, &pattern, &mut matcher)
        })
        .collect();

    // Sort by score descending and take top results
    let mut sorted_results = results;
    sorted_results.sort_by_key(|result| std::cmp::Reverse(result.1));
    sorted_results.truncate(max_results);

    sorted_results
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
        let default_excludes = vec![
            "node_modules".to_string(),
            ".git".to_string(),
            "dist".to_string(),
            "build".to_string(),
            ".next".to_string(),
            "target".to_string(),
            ".cache".to_string(),
            "coverage".to_string(),
            "__pycache__".to_string(),
            ".venv".to_string(),
            "venv".to_string(),
        ];

        let exclude_dirs = options.exclude_dirs.unwrap_or(default_excludes);
        let max_results = options.max_results.unwrap_or(50);

        // Get file index (cached or fresh)
        let entries = get_file_index(&options.root_path, &exclude_dirs);
        let total_indexed = entries.len();

        // Perform fuzzy search
        let file_extensions = options.file_extensions.as_deref();
        let results = fuzzy_search(&entries, &options.query, max_results, file_extensions);

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
        let default_excludes = vec![
            "node_modules".to_string(),
            ".git".to_string(),
            "dist".to_string(),
            "build".to_string(),
            ".next".to_string(),
            "target".to_string(),
        ];

        let exclude_dirs = exclude_dirs.unwrap_or(default_excludes);

        // Clear existing cache for this path
        {
            let mut cache = FILE_INDEX_CACHE.lock().unwrap();
            cache.remove(&root_path);
        }

        // Build fresh index
        let entries = Arc::new(build_file_index(&root_path, &exclude_dirs));
        let count = entries.len();

        insert_file_index_cache_entry(
            root_path,
            Arc::clone(&entries),
            std::time::SystemTime::now(),
        );

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

        // Check if already cached and fresh — skip the walk entirely.
        {
            let mut cache = FILE_INDEX_CACHE.lock().unwrap();
            prune_file_index_cache(&mut cache);
            if let Some(index) = cache.get(&root_path) {
                if let Ok(elapsed) = index.indexed_at.elapsed() {
                    if elapsed.as_secs() < CACHE_TTL_SECS {
                        debug!(
                            entries = index.entries.len(),
                            age_secs = elapsed.as_secs_f64(),
                            "search::file: prewarm skipped; cache still fresh"
                        );
                        return Ok(index.entries.len());
                    }
                }
            }
        }

        debug!(root_path = %root_path, "search::file: prewarming index");

        let default_excludes = vec![
            "node_modules".to_string(),
            ".git".to_string(),
            "dist".to_string(),
            "build".to_string(),
            ".next".to_string(),
            "target".to_string(),
            ".cache".to_string(),
            "coverage".to_string(),
            "__pycache__".to_string(),
            ".venv".to_string(),
            "venv".to_string(),
        ];

        // Build WITHOUT holding the lock.
        let entries = Arc::new(build_file_index(&root_path, &default_excludes));
        let count = entries.len();

        insert_file_index_cache_entry(
            root_path,
            Arc::clone(&entries),
            std::time::SystemTime::now(),
        );

        info!(entries = count, "search::file: prewarm complete");
        Ok(count)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Clear the file index cache
#[tauri::command]
pub fn clear_file_index_cache() {
    let mut cache = FILE_INDEX_CACHE.lock().unwrap();
    cache.clear();
    info!("search::file: cache cleared");
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
        let exclude_set: std::collections::HashSet<String> = [
            "node_modules",
            ".git",
            "dist",
            "build",
            ".next",
            "target",
            ".cache",
            "__pycache__",
            ".venv",
            "venv",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

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
