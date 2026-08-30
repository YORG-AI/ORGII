//! Component Indexer
//!
//! Handles directory traversal and index management.
//! Uses the `ignore` crate for fast traversal with .gitignore support.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use ignore::WalkBuilder;
use rayon::prelude::*;

use super::parser::{get_file_type, FileType, JsxParser, SvelteParser, VueParser};
use super::types::{ComponentLocation, UiIndex, UiIndexStats};

/// Component indexer for a repository
pub struct UiIndexer {
    /// Extensions to index
    extensions: Vec<&'static str>,
}

impl UiIndexer {
    /// Create a new indexer
    pub fn new() -> Self {
        Self {
            extensions: vec!["tsx", "jsx", "ts", "js", "vue", "svelte"],
        }
    }

    /// Index an entire directory
    pub fn index_directory(&self, root: &Path) -> Result<UiIndex, String> {
        let start = Instant::now();
        let mut index = UiIndex::new();

        // Collect all files to index
        let files: Vec<PathBuf> = WalkBuilder::new(root)
            .hidden(true) // Skip hidden files
            .git_ignore(true) // Respect .gitignore
            .git_global(false)
            .git_exclude(true)
            .build()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|ft| ft.is_file()).unwrap_or(false))
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| self.extensions.contains(&ext))
                    .unwrap_or(false)
            })
            .map(|entry| entry.into_path())
            .collect();

        log::info!(
            "[UiIndexer] Found {} files to index in {:?}",
            files.len(),
            root
        );

        // Parse files in parallel and collect results
        let results: Vec<Vec<(String, ComponentLocation)>> = files
            .par_iter()
            .filter_map(|path| {
                let content = fs::read_to_string(path).ok()?;
                let file_type = get_file_type(path)?;

                match file_type {
                    FileType::Tsx | FileType::Jsx => {
                        // Create parser per thread (not Send)
                        let mut parser = JsxParser::new().ok()?;
                        Some(parser.parse_file(path, &content))
                    }
                    FileType::Ts | FileType::Js => {
                        // TS/JS without JSX - still parse for component definitions
                        let mut parser = JsxParser::new().ok()?;
                        Some(parser.parse_file(path, &content))
                    }
                    FileType::Vue => {
                        let parser = VueParser::new();
                        Some(parser.parse_file(path, &content))
                    }
                    FileType::Svelte => {
                        let parser = SvelteParser::new();
                        Some(parser.parse_file(path, &content))
                    }
                }
            })
            .collect();

        // Merge results into index
        for file_results in results {
            for (name, location) in file_results {
                let file = location.file.clone();
                index.add(name, location);
                index.mark_indexed(file);
            }
        }

        let elapsed = start.elapsed();
        log::info!(
            "[UiIndexer] Indexed {} components in {} files ({:?})",
            index.components.len(),
            index.file_timestamps.len(),
            elapsed
        );

        Ok(index)
    }

    /// Index a single file (for incremental updates)
    pub fn index_file(&self, index: &mut UiIndex, path: &Path) -> Result<(), String> {
        // Remove old entries for this file
        index.remove_file(&path.to_path_buf());

        // Read and parse the file
        let content =
            fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))?;

        let file_type = get_file_type(path).ok_or("Unsupported file type")?;

        let results = match file_type {
            FileType::Tsx | FileType::Jsx | FileType::Ts | FileType::Js => {
                let mut parser = JsxParser::new()?;
                parser.parse_file(path, &content)
            }
            FileType::Vue => {
                let parser = VueParser::new();
                parser.parse_file(path, &content)
            }
            FileType::Svelte => {
                let parser = SvelteParser::new();
                parser.parse_file(path, &content)
            }
        };

        // Add results to index
        for (name, location) in results {
            index.add(name, location);
        }
        index.mark_indexed(path.to_path_buf());

        Ok(())
    }

    /// Get index statistics
    pub fn get_stats(index: &UiIndex, elapsed_ms: u64) -> UiIndexStats {
        let mut stats = index.stats();
        stats.index_time_ms = elapsed_ms;
        stats
    }
}

impl Default for UiIndexer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "tests/indexer_tests.rs"]
mod tests;
