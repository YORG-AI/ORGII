//! Global CSS token scanning for the browser design tools.

use regex::Regex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// A CSS variable definition and its source file.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TokenDefinition {
    pub name: String,
    pub value: String,
    pub source: String,
}

/// Result returned to the browser design-token panel.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TokenDefinitionsResult {
    pub tokens: Vec<TokenDefinition>,
}

struct TokenDefinitionExtractor {
    css_var_definition: Regex,
}

impl TokenDefinitionExtractor {
    fn new() -> Self {
        Self {
            css_var_definition: Regex::new(r"--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);").unwrap(),
        }
    }

    fn extract_from_file(&self, path: &Path) -> Result<Vec<TokenDefinition>, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|error| format!("Failed to read file: {error}"))?;
        Ok(self.extract_from_content(&content, &path.to_string_lossy()))
    }

    fn extract_from_content(&self, content: &str, source: &str) -> Vec<TokenDefinition> {
        self.css_var_definition
            .captures_iter(content)
            .filter_map(|capture| {
                let name = capture.get(1)?;
                let value = capture.get(2)?;
                Some(TokenDefinition {
                    name: name.as_str().to_string(),
                    value: value.as_str().trim().to_string(),
                    source: source.to_string(),
                })
            })
            .collect()
    }

    fn scan_directory(&self, directory: &Path, max_depth: usize) -> TokenDefinitionsResult {
        let mut tokens = Vec::new();
        self.scan_directory_recursive(directory, 0, max_depth, &mut tokens);

        let mut seen = HashSet::new();
        tokens.retain(|token| seen.insert(token.name.clone()));
        TokenDefinitionsResult { tokens }
    }

    fn scan_directory_recursive(
        &self,
        directory: &Path,
        depth: usize,
        max_depth: usize,
        tokens: &mut Vec<TokenDefinition>,
    ) {
        if depth > max_depth {
            return;
        }

        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if !matches!(name, "node_modules" | ".git" | "dist" | "build" | "target") {
                    self.scan_directory_recursive(&path, depth + 1, max_depth, tokens);
                }
            } else if matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("css" | "scss")
            ) {
                if let Ok(file_tokens) = self.extract_from_file(&path) {
                    tokens.extend(file_tokens);
                }
            }
        }
    }
}

/// Scan a repository for CSS variable definitions used by the design tools.
#[tauri::command]
pub async fn scan_global_tokens(
    repo_path: String,
    max_depth: Option<usize>,
) -> Result<TokenDefinitionsResult, String> {
    let path = PathBuf::from(&repo_path);
    if !path.exists() {
        return Err(format!("Repository path not found: {repo_path}"));
    }

    let depth = max_depth.unwrap_or(5);
    let result = tokio::task::spawn_blocking(move || {
        TokenDefinitionExtractor::new().scan_directory(&path, depth)
    })
    .await
    .map_err(|error| format!("Global token scan task failed: {error}"))?;

    tracing::info!(
        repo_path,
        depth,
        token_count = result.tokens.len(),
        "scanned global CSS tokens"
    );

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_css_variable_definitions() {
        let extractor = TokenDefinitionExtractor::new();
        let content = r#"
            :root {
                --color-text-1: #111827;
                --primary-6: 37 99 235;
            }
        "#;

        let result = extractor.extract_from_content(content, "tokens.css");

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "color-text-1");
        assert_eq!(result[0].value, "#111827");
        assert_eq!(result[0].source, "tokens.css");
        assert_eq!(result[1].name, "primary-6");
        assert_eq!(result[1].value, "37 99 235");
    }

    #[test]
    fn scans_css_and_scss_without_descending_into_dependency_trees() {
        let directory = tempfile::tempdir().expect("create temp directory");
        std::fs::write(
            directory.path().join("tokens.css"),
            ":root { --primary-6: blue; }",
        )
        .expect("write CSS fixture");
        std::fs::create_dir(directory.path().join("styles")).expect("create styles directory");
        std::fs::write(
            directory.path().join("styles/theme.scss"),
            "$ignored: red; :root { --surface: white; --primary-6: navy; }",
        )
        .expect("write SCSS fixture");
        std::fs::create_dir(directory.path().join("node_modules"))
            .expect("create dependency directory");
        std::fs::write(
            directory.path().join("node_modules/vendor.css"),
            ":root { --vendor-only: red; }",
        )
        .expect("write ignored fixture");

        let result = TokenDefinitionExtractor::new().scan_directory(directory.path(), 5);

        assert_eq!(result.tokens.len(), 2);
        assert_eq!(result.tokens[0].name, "primary-6");
        assert_eq!(result.tokens[0].value, "blue");
        assert_eq!(result.tokens[1].name, "surface");
        assert_eq!(result.tokens[1].value, "white");
    }
}
