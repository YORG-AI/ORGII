//! Vue SFC Parser
//!
//! Extracts component definitions and usages from Vue Single File Components (.vue).
//!
//! ## Detection Strategy
//!
//! ### Component Definition
//! - **Filename-based**: `Button.vue` → component name is `Button`
//! - **Options API**: `export default { name: 'ComponentName' }`
//! - **Script setup**: Component name from filename
//!
//! ### Component Usages
//! - PascalCase tags in `<template>`: `<MyComponent />`, `<MyComponent>...</MyComponent>`
//! - Also detects kebab-case: `<my-component />` → `MyComponent`
//!
//! ### Imports (for reference tracking)
//! - `import MyComponent from './MyComponent.vue'`

use std::path::Path;

use regex::Regex;

use crate::types::{ComponentKind, ComponentLocation};

/// Parser for Vue Single File Components
pub struct VueParser {
    /// Regex to extract template section
    template_regex: Regex,
    /// Regex to extract script section
    script_regex: Regex,
    /// Regex to find PascalCase component usages in template
    component_usage_regex: Regex,
    /// Regex to find kebab-case component usages (converted to PascalCase)
    kebab_component_regex: Regex,
    /// Regex to find component name in Options API
    options_name_regex: Regex,
    /// Regex to find Vue component imports
    import_regex: Regex,
}

impl VueParser {
    /// Create a new Vue parser
    pub fn new() -> Self {
        Self {
            // Match <template>...</template> (non-greedy, dotall)
            template_regex: Regex::new(r"(?s)<template[^>]*>(.*?)</template>").unwrap(),
            // Match <script>...</script> or <script setup>...</script>
            script_regex: Regex::new(r"(?s)<script[^>]*>(.*?)</script>").unwrap(),
            // Match PascalCase component tags: <MyComponent or <MyComponent/> or <MyComponent>
            // Excludes built-in Vue components (transition, keep-alive, etc.)
            component_usage_regex: Regex::new(r"<([A-Z][a-zA-Z0-9]+)[\s/>]").unwrap(),
            // Match kebab-case with at least one hyphen: <my-component
            kebab_component_regex: Regex::new(r"<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]").unwrap(),
            // Match name property in Options API: name: 'ComponentName' or name: "ComponentName"
            options_name_regex: Regex::new(r#"name\s*:\s*['"]([^'"]+)['"]"#).unwrap(),
            // Match Vue component imports: import X from '...vue'
            import_regex: Regex::new(r#"import\s+(\w+)\s+from\s+['"][^'"]*\.vue['"]\s*;?"#)
                .unwrap(),
        }
    }

    /// Parse a Vue file and extract component information
    pub fn parse_file(&self, path: &Path, content: &str) -> Vec<(String, ComponentLocation)> {
        let mut results = Vec::new();

        // 1. Get component name from filename (primary definition)
        let component_name = self.get_component_name_from_path(path);
        if let Some(name) = &component_name {
            results.push((
                name.clone(),
                ComponentLocation {
                    file: path.to_path_buf(),
                    line: 1,
                    column: 0,
                    kind: ComponentKind::VueDef,
                    end_line: None,
                },
            ));
        }

        // 2. Check for explicit name in Options API (may override filename)
        if let Some(script_match) = self.script_regex.captures(content) {
            let script_content = &script_match[1];
            let script_start = script_match.get(1).unwrap().start();

            // Look for name: 'ComponentName'
            if let Some(name_match) = self.options_name_regex.captures(script_content) {
                let explicit_name = name_match[1].to_string();
                // Only add if different from filename-based name
                if component_name.as_ref() != Some(&explicit_name) {
                    let name_pos = name_match.get(0).unwrap().start();
                    let line = content[..script_start + name_pos].matches('\n').count() as u32 + 1;
                    results.push((
                        explicit_name,
                        ComponentLocation {
                            file: path.to_path_buf(),
                            line,
                            column: 0,
                            kind: ComponentKind::VueDef,
                            end_line: None,
                        },
                    ));
                }
            }

            // 3. Find imported components (for tracking)
            for cap in self.import_regex.captures_iter(script_content) {
                let import_name = cap[1].to_string();
                let import_pos = cap.get(0).unwrap().start();
                let line = content[..script_start + import_pos].matches('\n').count() as u32 + 1;

                // Track as usage (import implies it will be used)
                results.push((
                    import_name,
                    ComponentLocation {
                        file: path.to_path_buf(),
                        line,
                        column: 0,
                        kind: ComponentKind::JsxUsage, // Reuse JsxUsage for component references
                        end_line: None,
                    },
                ));
            }
        }

        // 4. Find component usages in template
        if let Some(template_match) = self.template_regex.captures(content) {
            let template_content = &template_match[1];
            let template_start = template_match.get(1).unwrap().start();

            // Find PascalCase components
            for cap in self.component_usage_regex.captures_iter(template_content) {
                let name = cap[1].to_string();

                // Skip Vue built-in components
                if self.is_vue_builtin(&name) {
                    continue;
                }

                let usage_pos = cap.get(0).unwrap().start();
                let line = content[..template_start + usage_pos].matches('\n').count() as u32 + 1;

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

            // Find kebab-case components and convert to PascalCase
            for cap in self.kebab_component_regex.captures_iter(template_content) {
                let kebab_name = &cap[1];
                let pascal_name = self.kebab_to_pascal(kebab_name);

                let usage_pos = cap.get(0).unwrap().start();
                let line = content[..template_start + usage_pos].matches('\n').count() as u32 + 1;

                results.push((
                    pascal_name,
                    ComponentLocation {
                        file: path.to_path_buf(),
                        line,
                        column: 0,
                        kind: ComponentKind::JsxUsage,
                        end_line: None,
                    },
                ));
            }
        }

        results
    }

    /// Extract component name from file path
    /// e.g., /src/components/MyButton.vue → MyButton
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

    /// Convert kebab-case to PascalCase
    /// e.g., my-button → MyButton
    fn kebab_to_pascal(&self, kebab: &str) -> String {
        kebab
            .split('-')
            .map(|part| {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().chain(chars).collect(),
                    None => String::new(),
                }
            })
            .collect()
    }

    /// Check if component name is a Vue built-in
    fn is_vue_builtin(&self, name: &str) -> bool {
        matches!(
            name.to_lowercase().as_str(),
            "transition"
                | "transitiongroup"
                | "keepalive"
                | "teleport"
                | "suspense"
                | "component"
                | "slot"
                | "template"
        )
    }
}

impl Default for VueParser {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "tests/vue_tests.rs"]
mod tests;
