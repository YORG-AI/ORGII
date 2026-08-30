//! Types for Component Index
//!
//! Data structures for storing and querying component source locations.
//! Includes source-location types for Browser inspector lookups.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

// ============================================
// Component Kind & Location Types
// ============================================

/// The kind of component definition or usage
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComponentKind {
    /// Function component: `function Button() {}`
    FunctionDef,
    /// Arrow function component: `const Button = () => {}`
    ArrowDef,
    /// Class component: `class Button extends Component {}`
    ClassDef,
    /// JSX usage: `<Button />`
    JsxUsage,
    /// Default export: `export default Button`
    DefaultExport,
    /// Named export: `export { Button }`
    NamedExport,
    /// Vue component definition
    VueDef,
    /// Svelte component (filename-based)
    SvelteDef,
}

impl ComponentKind {
    /// Returns true if this is a definition (not a usage)
    pub fn is_definition(&self) -> bool {
        matches!(
            self,
            ComponentKind::FunctionDef
                | ComponentKind::ArrowDef
                | ComponentKind::ClassDef
                | ComponentKind::VueDef
                | ComponentKind::SvelteDef
        )
    }
}

/// A single component location in source code
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentLocation {
    /// Absolute file path
    pub file: PathBuf,
    /// Line number (1-indexed)
    pub line: u32,
    /// Column number (0-indexed)
    pub column: u32,
    /// Type of component reference
    pub kind: ComponentKind,
    /// End line (for range selection, optional)
    pub end_line: Option<u32>,
}

/// Statistics about the component index
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiIndexStats {
    /// Number of files indexed
    pub total_files: usize,
    /// Number of unique components found
    pub total_components: usize,
    /// Number of component locations (definitions + usages)
    pub total_locations: usize,
    /// Time taken to index (milliseconds)
    pub index_time_ms: u64,
}

/// The main component index structure
#[derive(Debug, Clone, Default)]
pub struct UiIndex {
    /// Map: component_name (lowercase) → Vec<ComponentLocation>
    /// Using lowercase for case-insensitive matching
    pub components: HashMap<String, Vec<ComponentLocation>>,

    /// Map: file_path → Vec<component_names>
    /// Used for efficient invalidation when file changes
    pub file_components: HashMap<PathBuf, Vec<String>>,

    /// Last indexed timestamp per file (Unix timestamp in seconds)
    pub file_timestamps: HashMap<PathBuf, u64>,
}

impl UiIndex {
    /// Create a new empty index
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up component by name (case-insensitive)
    pub fn lookup(&self, name: &str) -> Vec<&ComponentLocation> {
        let key = name.to_lowercase();
        self.components
            .get(&key)
            .map(|locs| locs.iter().collect())
            .unwrap_or_default()
    }

    /// Look up with priority: definitions first, then usages
    pub fn lookup_prioritized(&self, name: &str) -> Vec<ComponentLocation> {
        let mut results: Vec<ComponentLocation> = self.lookup(name).into_iter().cloned().collect();

        results.sort_by(|a, b| {
            // Definitions before usages
            let a_is_def = a.kind.is_definition();
            let b_is_def = b.kind.is_definition();
            b_is_def.cmp(&a_is_def)
        });

        results
    }

    /// Remove all entries for a file (before re-indexing)
    pub fn remove_file(&mut self, file: &PathBuf) {
        if let Some(names) = self.file_components.remove(file) {
            for name in names {
                if let Some(locs) = self.components.get_mut(&name) {
                    locs.retain(|loc| &loc.file != file);
                    if locs.is_empty() {
                        self.components.remove(&name);
                    }
                }
            }
        }
        self.file_timestamps.remove(file);
    }

    /// Add a component location
    pub fn add(&mut self, name: String, location: ComponentLocation) {
        let file = location.file.clone();
        let key = name.to_lowercase();

        self.components
            .entry(key.clone())
            .or_default()
            .push(location);

        self.file_components.entry(file).or_default().push(key);
    }

    /// Mark a file as indexed with current timestamp
    pub fn mark_indexed(&mut self, file: PathBuf) {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.file_timestamps.insert(file, timestamp);
    }

    /// Get statistics about the index
    pub fn stats(&self) -> UiIndexStats {
        let total_locations: usize = self.components.values().map(|v| v.len()).sum();
        UiIndexStats {
            total_files: self.file_timestamps.len(),
            total_components: self.components.len(),
            total_locations,
            index_time_ms: 0, // Will be set by caller
        }
    }

    /// Check if a file needs re-indexing based on modification time
    pub fn needs_reindex(&self, file: &PathBuf, mtime: u64) -> bool {
        match self.file_timestamps.get(file) {
            Some(&indexed_time) => mtime > indexed_time,
            None => true,
        }
    }
}

#[cfg(test)]
#[path = "tests/types_tests.rs"]
mod tests;
