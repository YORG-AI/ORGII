//! Svelte Parser
//!
//! Extracts component definitions and usages from Svelte components (.svelte).
//!
//! ## Detection Strategy
//!
//! ### Component Definition
//! - **Filename-based**: `Button.svelte` → component name is `Button`
//! - Svelte uses filename as the component name (no explicit name property)
//!
//! ### Component Usages
//! - PascalCase tags in markup: `<MyComponent />`, `<MyComponent>...</MyComponent>`
//! - Svelte components MUST start with uppercase (convention enforced by Svelte)
//!
//! ### Imports
//! - `import MyComponent from './MyComponent.svelte'`
//!
//! ## Svelte-specific Elements (Skipped)
//! - `<svelte:head>`, `<svelte:body>`, `<svelte:window>`, etc.
//! - `<slot>` (built-in)

use std::path::Path;

use regex::Regex;

use crate::types::{ComponentKind, ComponentLocation};

/// Parser for Svelte components
pub struct SvelteParser {
    /// Regex to extract script section
    script_regex: Regex,
    /// Regex to find PascalCase component usages
    component_usage_regex: Regex,
    /// Regex to find Svelte component imports
    import_regex: Regex,
}

impl SvelteParser {
    /// Create a new Svelte parser
    pub fn new() -> Self {
        Self {
            // Match <script>...</script> or <script context="module">...</script>
            script_regex: Regex::new(r"(?s)<script[^>]*>(.*?)</script>").unwrap(),
            // Match PascalCase component tags: <MyComponent or <MyComponent/>
            // Must start with uppercase (Svelte requirement)
            component_usage_regex: Regex::new(r"<([A-Z][a-zA-Z0-9]+)[\s/>]").unwrap(),
            // Match Svelte component imports: import X from '...svelte'
            import_regex: Regex::new(r#"import\s+(\w+)\s+from\s+['"][^'"]*\.svelte['"]\s*;?"#)
                .unwrap(),
        }
    }

    /// Parse a Svelte file and extract component information
    pub fn parse_file(&self, path: &Path, content: &str) -> Vec<(String, ComponentLocation)> {
        let mut results = Vec::new();

        // 1. Get component name from filename (the definition)
        if let Some(name) = self.get_component_name_from_path(path) {
            results.push((
                name,
                ComponentLocation {
                    file: path.to_path_buf(),
                    line: 1,
                    column: 0,
                    kind: ComponentKind::SvelteDef,
                    end_line: None,
                },
            ));
        }

        // 2. Find imported components in script section
        for script_match in self.script_regex.captures_iter(content) {
            let script_content = &script_match[1];
            let script_start = script_match.get(1).unwrap().start();

            for cap in self.import_regex.captures_iter(script_content) {
                let import_name = cap[1].to_string();
                let import_pos = cap.get(0).unwrap().start();
                let line = content[..script_start + import_pos].matches('\n').count() as u32 + 1;

                results.push((
                    import_name,
                    ComponentLocation {
                        file: path.to_path_buf(),
                        line,
                        column: 0,
                        kind: ComponentKind::JsxUsage, // Reuse for component references
                        end_line: None,
                    },
                ));
            }
        }

        // 3. Find component usages in markup
        // In Svelte, everything outside <script> and <style> is markup
        let markup = self.extract_markup(content);
        let mut current_pos = 0;

        for cap in self.component_usage_regex.captures_iter(&markup) {
            let name = cap[1].to_string();

            // Skip Svelte special elements
            if self.is_svelte_special(&name) {
                continue;
            }

            // Calculate line number in original content
            // This is approximate since we stripped script/style
            let usage_pos = cap.get(0).unwrap().start();

            // Find the actual position in original content
            let line = self.find_line_in_original(content, &name, current_pos);
            current_pos = usage_pos;

            results.push((
                name,
                ComponentLocation {
                    file: path.to_path_buf(),
                    line,
                    column: 0,
                    kind: ComponentKind::JsxUsage,
                    end_line: None,
                },
            ));
        }

        results
    }

    /// Extract component name from file path
    /// e.g., /src/components/MyButton.svelte → MyButton
    fn get_component_name_from_path(&self, path: &Path) -> Option<String> {
        let stem = path.file_stem()?.to_str()?;

        // Skip index files - use parent folder name instead
        if stem.eq_ignore_ascii_case("index") {
            let parent = path.parent()?.file_name()?.to_str()?;
            if self.is_component_name(parent) {
                return Some(parent.to_string());
            }
        }

        if self.is_component_name(stem) {
            Some(stem.to_string())
        } else {
            None
        }
    }

    /// Check if name looks like a component (PascalCase, not all caps)
    fn is_component_name(&self, name: &str) -> bool {
        if name.is_empty() {
            return false;
        }
        let first_char = name.chars().next().unwrap();
        if !first_char.is_uppercase() {
            return false;
        }
        // Skip ALL_CAPS constants
        !name.chars().all(|c| c.is_uppercase() || c == '_')
    }

    /// Check if element name is a Svelte special element
    fn is_svelte_special(&self, name: &str) -> bool {
        // Svelte special elements start with lowercase but we're checking PascalCase
        // These are component-like but built-in
        matches!(name, "Slot" | "Fragment")
    }

    /// Extract markup content (everything outside script and style tags)
    fn extract_markup(&self, content: &str) -> String {
        let mut result = content.to_string();

        // Remove script sections
        let script_regex = Regex::new(r"(?s)<script[^>]*>.*?</script>").unwrap();
        result = script_regex.replace_all(&result, "").to_string();

        // Remove style sections
        let style_regex = Regex::new(r"(?s)<style[^>]*>.*?</style>").unwrap();
        result = style_regex.replace_all(&result, "").to_string();

        result
    }

    /// Find the line number of a component usage in original content
    fn find_line_in_original(&self, content: &str, component_name: &str, _hint: usize) -> u32 {
        // Search for the component tag in the original content
        let pattern = format!(r"<{}", regex::escape(component_name));
        if let Ok(re) = Regex::new(&pattern) {
            if let Some(m) = re.find(content) {
                return content[..m.start()].matches('\n').count() as u32 + 1;
            }
        }
        1 // Fallback to line 1
    }
}

impl Default for SvelteParser {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "tests/svelte_tests.rs"]
mod tests;
