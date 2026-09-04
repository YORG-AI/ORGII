//! JSX/TSX Parser using tree-sitter
//!
//! Extracts React component definitions and usages from JSX/TSX files.
//!
//! ## Patterns Detected
//!
//! ### Definitions
//! - `function Button() {}` - Function declaration
//! - `const Button = () => {}` - Arrow function
//! - `const Button = function() {}` - Function expression
//! - `const Button = memo(() => {})` - Wrapped components
//! - `const Button = forwardRef(() => {})` - ForwardRef
//! - `class Button extends Component {}` - Class component
//!
//! ### Usages
//! - `<Button />` - Self-closing JSX
//! - `<Button>...</Button>` - JSX with children

use std::path::Path;

use crate::types::{ComponentKind, ComponentLocation};

/// Parser for JSX/TSX files using tree-sitter
pub struct JsxParser {
    parser: tree_sitter::Parser,
}

impl JsxParser {
    /// Create a new JSX parser
    pub fn new() -> Result<Self, String> {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_typescript::LANGUAGE_TSX.into())
            .map_err(|e| format!("Failed to set TSX language: {}", e))?;

        Ok(Self { parser })
    }

    /// Parse a file and extract component information
    pub fn parse_file(&mut self, path: &Path, content: &str) -> Vec<(String, ComponentLocation)> {
        let mut results = Vec::new();

        let tree = match self.parser.parse(content, None) {
            Some(tree) => tree,
            None => return results,
        };

        let root = tree.root_node();
        self.walk_node(root, path, content.as_bytes(), &mut results);

        results
    }

    /// Recursively walk the AST and extract components
    fn walk_node(
        &self,
        node: tree_sitter::Node,
        path: &Path,
        source: &[u8],
        results: &mut Vec<(String, ComponentLocation)>,
    ) {
        match node.kind() {
            // Function declaration: function Button() {}
            "function_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = self.node_text(name_node, source);
                    if self.is_component_name(&name) {
                        results.push((
                            name,
                            ComponentLocation {
                                file: path.to_path_buf(),
                                line: node.start_position().row as u32 + 1,
                                column: node.start_position().column as u32,
                                kind: ComponentKind::FunctionDef,
                                end_line: Some(node.end_position().row as u32 + 1),
                            },
                        ));
                    }
                }
            }

            // Export statement: export function Button() {}
            "export_statement" => {
                // Check for default export
                let is_default = node
                    .children(&mut node.walk())
                    .any(|child| child.kind() == "default");

                // Find the declaration inside
                for child in node.children(&mut node.walk()) {
                    match child.kind() {
                        "function_declaration" => {
                            if let Some(name_node) = child.child_by_field_name("name") {
                                let name = self.node_text(name_node, source);
                                if self.is_component_name(&name) {
                                    let kind = if is_default {
                                        ComponentKind::DefaultExport
                                    } else {
                                        ComponentKind::FunctionDef
                                    };
                                    results.push((
                                        name,
                                        ComponentLocation {
                                            file: path.to_path_buf(),
                                            line: child.start_position().row as u32 + 1,
                                            column: child.start_position().column as u32,
                                            kind,
                                            end_line: Some(child.end_position().row as u32 + 1),
                                        },
                                    ));
                                }
                            }
                        }
                        "lexical_declaration" => {
                            self.extract_variable_components(child, path, source, results);
                        }
                        "class_declaration" => {
                            if let Some(name_node) = child.child_by_field_name("name") {
                                let name = self.node_text(name_node, source);
                                if self.is_component_name(&name) {
                                    results.push((
                                        name,
                                        ComponentLocation {
                                            file: path.to_path_buf(),
                                            line: child.start_position().row as u32 + 1,
                                            column: child.start_position().column as u32,
                                            kind: ComponentKind::ClassDef,
                                            end_line: Some(child.end_position().row as u32 + 1),
                                        },
                                    ));
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }

            // Variable declaration: const Button = () => {}
            "lexical_declaration" | "variable_declaration" => {
                self.extract_variable_components(node, path, source, results);
            }

            // JSX element: <Button /> or <Button>...</Button>
            "jsx_element" | "jsx_self_closing_element" => {
                self.extract_jsx_usage(node, path, source, results);
            }

            // Class declaration: class Button extends Component {}
            "class_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = self.node_text(name_node, source);
                    if self.is_component_name(&name) {
                        results.push((
                            name,
                            ComponentLocation {
                                file: path.to_path_buf(),
                                line: node.start_position().row as u32 + 1,
                                column: node.start_position().column as u32,
                                kind: ComponentKind::ClassDef,
                                end_line: Some(node.end_position().row as u32 + 1),
                            },
                        ));
                    }
                }
            }

            _ => {}
        }

        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            // Skip already processed export_statement children to avoid duplicates
            if node.kind() == "export_statement" {
                continue;
            }
            self.walk_node(child, path, source, results);
        }
    }

    /// Extract components from variable declarations
    fn extract_variable_components(
        &self,
        node: tree_sitter::Node,
        path: &Path,
        source: &[u8],
        results: &mut Vec<(String, ComponentLocation)>,
    ) {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "variable_declarator" {
                self.check_variable_declarator(child, path, source, results);
            }
        }
    }

    /// Check if a variable declarator is a component
    fn check_variable_declarator(
        &self,
        node: tree_sitter::Node,
        path: &Path,
        source: &[u8],
        results: &mut Vec<(String, ComponentLocation)>,
    ) {
        let name_node = match node.child_by_field_name("name") {
            Some(n) => n,
            None => return,
        };

        let name = self.node_text(name_node, source);
        if !self.is_component_name(&name) {
            return;
        }

        // Check if value is an arrow function, function expression, or wrapped component
        if let Some(value) = node.child_by_field_name("value") {
            let is_component = match value.kind() {
                "arrow_function" | "function" | "function_expression" => true,
                "call_expression" => {
                    // Check for memo(), forwardRef(), styled(), etc.
                    if let Some(func) = value.child_by_field_name("function") {
                        let func_text = self.node_text(func, source);
                        self.is_component_wrapper(&func_text)
                    } else {
                        false
                    }
                }
                "parenthesized_expression" => {
                    // Check inside parentheses
                    self.contains_function(value, source)
                }
                _ => false,
            };

            if is_component {
                results.push((
                    name,
                    ComponentLocation {
                        file: path.to_path_buf(),
                        line: node.start_position().row as u32 + 1,
                        column: node.start_position().column as u32,
                        kind: ComponentKind::ArrowDef,
                        end_line: Some(node.end_position().row as u32 + 1),
                    },
                ));
            }
        }
    }

    /// Extract JSX component usage
    fn extract_jsx_usage(
        &self,
        node: tree_sitter::Node,
        path: &Path,
        source: &[u8],
        results: &mut Vec<(String, ComponentLocation)>,
    ) {
        // Get the opening element or self-closing element
        let element = if node.kind() == "jsx_self_closing_element" {
            node
        } else {
            // jsx_element has jsx_opening_element as first child
            let mut found_element = None;
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "jsx_opening_element" {
                    found_element = Some(child);
                    break;
                }
            }
            found_element.unwrap_or(node)
        };

        // Get the element name
        let mut cursor = element.walk();
        for child in element.children(&mut cursor) {
            if child.kind() == "identifier" || child.kind() == "member_expression" {
                let name = self.node_text(child, source);
                // Only track PascalCase components or member expressions (like motion.div)
                if self.is_component_name(&name) || name.contains('.') {
                    results.push((
                        name,
                        ComponentLocation {
                            file: path.to_path_buf(),
                            line: node.start_position().row as u32 + 1,
                            column: node.start_position().column as u32,
                            kind: ComponentKind::JsxUsage,
                            end_line: Some(node.end_position().row as u32 + 1),
                        },
                    ));
                }
                break;
            }
        }

        // Don't recurse into JSX children here - let walk_node handle it
    }

    /// Check if a node contains a function (for parenthesized expressions)
    fn contains_function(&self, node: tree_sitter::Node, source: &[u8]) -> bool {
        match node.kind() {
            "arrow_function" | "function" | "function_expression" => true,
            "call_expression" => {
                if let Some(func) = node.child_by_field_name("function") {
                    let func_text = self.node_text(func, source);
                    self.is_component_wrapper(&func_text)
                } else {
                    false
                }
            }
            _ => {
                // Check children
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if self.contains_function(child, source) {
                        return true;
                    }
                }
                false
            }
        }
    }

    /// Get text content of a node
    fn node_text(&self, node: tree_sitter::Node, source: &[u8]) -> String {
        let start = node.start_byte();
        let end = node.end_byte();
        String::from_utf8_lossy(&source[start..end]).to_string()
    }

    /// Check if name looks like a React component (PascalCase)
    fn is_component_name(&self, name: &str) -> bool {
        if name.is_empty() {
            return false;
        }

        let first_char = name.chars().next().unwrap();
        if !first_char.is_uppercase() {
            return false;
        }

        // Skip ALL_CAPS constants (like MAX_COUNT)
        if name.chars().all(|c| c.is_uppercase() || c == '_') {
            return false;
        }

        true
    }

    /// Check if function name is a component wrapper (memo, forwardRef, styled, etc.)
    fn is_component_wrapper(&self, func_name: &str) -> bool {
        let wrappers = [
            "memo",
            "forwardRef",
            "React.memo",
            "React.forwardRef",
            "styled",
            "observer",
            "withRouter",
            "connect",
            "lazy",
            "React.lazy",
        ];
        wrappers
            .iter()
            .any(|w| func_name == *w || func_name.ends_with(w))
    }
}

impl Default for JsxParser {
    fn default() -> Self {
        Self::new().expect("Failed to create JSX parser")
    }
}

#[cfg(test)]
#[path = "tests/jsx_tests.rs"]
mod tests;
