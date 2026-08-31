//! Token definition extractor
//!
//! Scans CSS and SCSS files for CSS variable definitions used by the design-token panel.

use regex::Regex;
use std::collections::HashSet;
use std::path::Path;

/// A token definition with its value
#[derive(Debug, Clone, serde::Serialize)]
pub struct TokenDefinition {
    /// Token name (without -- prefix)
    pub name: String,
    /// Token value
    pub value: String,
    /// Source file path
    pub source: String,
}

/// Result of extracting token definitions
#[derive(Debug, Clone, serde::Serialize)]
pub struct TokenDefinitionsResult {
    /// List of token definitions
    pub tokens: Vec<TokenDefinition>,
}

/// Extracts CSS variable definitions from CSS files
pub struct TokenDefinitionExtractor {
    /// Regex to match --name: value patterns
    css_var_def: Regex,
}

impl TokenDefinitionExtractor {
    pub fn new() -> Self {
        Self {
            // Match CSS variable definitions: --name: value;
            // Captures: 1=name, 2=value
            css_var_def: Regex::new(r"--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);").unwrap(),
        }
    }

    /// Extract token definitions from a CSS file
    pub fn extract_from_file(&self, path: &Path) -> Result<Vec<TokenDefinition>, String> {
        let content =
            std::fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))?;

        let source = path.to_string_lossy().to_string();
        Ok(self.extract_from_content(&content, &source))
    }

    /// Extract token definitions from CSS content
    pub fn extract_from_content(&self, content: &str, source: &str) -> Vec<TokenDefinition> {
        let mut tokens = Vec::new();

        for cap in self.css_var_def.captures_iter(content) {
            if let (Some(name), Some(value)) = (cap.get(1), cap.get(2)) {
                tokens.push(TokenDefinition {
                    name: name.as_str().to_string(),
                    value: value.as_str().trim().to_string(),
                    source: source.to_string(),
                });
            }
        }

        tokens
    }

    /// Scan a directory for CSS files and extract all token definitions
    pub fn scan_directory(&self, dir: &Path, max_depth: usize) -> TokenDefinitionsResult {
        let mut all_tokens = Vec::new();
        self.scan_dir_recursive(dir, 0, max_depth, &mut all_tokens);

        // Remove duplicates (keep first occurrence)
        let mut seen = HashSet::new();
        all_tokens.retain(|t| seen.insert(t.name.clone()));

        TokenDefinitionsResult { tokens: all_tokens }
    }

    fn scan_dir_recursive(
        &self,
        dir: &Path,
        depth: usize,
        max_depth: usize,
        tokens: &mut Vec<TokenDefinition>,
    ) {
        if depth > max_depth {
            return;
        }

        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                // Skip common non-source directories
                if !matches!(name, "node_modules" | ".git" | "dist" | "build" | "target") {
                    self.scan_dir_recursive(&path, depth + 1, max_depth, tokens);
                }
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                // Only process CSS and SCSS files
                if matches!(ext, "css" | "scss") {
                    if let Ok(file_tokens) = self.extract_from_file(&path) {
                        tokens.extend(file_tokens);
                    }
                }
            }
        }
    }
}

impl Default for TokenDefinitionExtractor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "tests/token_extractor_tests.rs"]
mod tests;
