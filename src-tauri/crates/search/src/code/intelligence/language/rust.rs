//! Rust language configuration

use super::{MemoizedQuery, TSLanguageConfig};

pub static RUST: TSLanguageConfig = TSLanguageConfig {
    language_ids: &["Rust"],
    file_extensions: &["rs"],
    grammar: || tree_sitter_rust::LANGUAGE.into(),
    scope_query: MemoizedQuery::new(RUST_SCOPES),
    hoverable_query: MemoizedQuery::new(
        r#"
        [(identifier)
         (shorthand_field_identifier)
         (field_identifier)
         (type_identifier)] @hoverable
        "#,
    ),
    namespaces: &[&[
        // variables
        "const",
        "function",
        "variable",
        // types
        "struct",
        "enum",
        "union",
        "typedef",
        "interface",
        // fields
        "field",
        "enumerator",
        // namespacing
        "module",
        // misc
        "label",
        "lifetime",
    ]],
};

const RUST_SCOPES: &str = r#"
;; Scopes

[
 (function_item)
 (closure_expression)
 (block)
 (if_expression)
 (match_arm)
 (match_expression)
 (for_expression)
 (while_expression)
 (loop_expression)
 (impl_item)
 (struct_item)
 (enum_item)
] @local.scope

;; Definitions

(function_item name: (identifier) @local.definition.function)
(struct_item name: (type_identifier) @local.definition.struct)
(enum_item name: (type_identifier) @local.definition.enum)
(union_item name: (type_identifier) @local.definition.union)
(type_item name: (type_identifier) @local.definition.typedef)
(trait_item name: (type_identifier) @local.definition.interface)
(mod_item name: (identifier) @local.definition.module)

(const_item name: (identifier) @local.definition.const)
(static_item name: (identifier) @local.definition.const)

(let_declaration pattern: (identifier) @local.definition.variable)
(let_declaration pattern: (tuple_pattern (identifier) @local.definition.variable))
(parameter pattern: (identifier) @local.definition.variable)
(closure_parameters (identifier) @local.definition.variable)
(self_parameter (self) @local.definition.variable)

(field_declaration name: (field_identifier) @local.definition.field)
(enum_variant name: (identifier) @local.definition.enumerator)

(label (identifier) @local.definition.label)
(lifetime (identifier) @local.definition.lifetime)
(type_parameters
  (lifetime_parameter
    name: (lifetime (identifier) @local.definition.lifetime)))

;; Imports

(use_declaration argument: (scoped_identifier name: (identifier) @local.import))
(use_declaration argument: (identifier) @local.import)
(use_as_clause alias: (identifier) @local.import)
(use_list (identifier) @local.import)

;; References

(identifier) @local.reference
(type_identifier) @local.reference
(field_identifier) @local.reference
(shorthand_field_identifier) @local.reference
(lifetime (identifier) @local.reference)
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::code::intelligence::TreeSitterFile;

    #[test]
    fn rust_scope_query_compiles_against_the_bundled_grammar() {
        RUST.scope_query
            .query(RUST.grammar)
            .expect("Rust scope query must match the bundled tree-sitter grammar");
    }

    #[test]
    fn rust_scope_graph_extracts_symbols_with_lifetime_parameters() {
        let source = b"fn borrow<'a>(value: &'a str) -> &'a str { value }\nstruct Widget;\n";
        let graph = TreeSitterFile::try_build_from_extension(source, "rs")
            .expect("parse Rust source")
            .scope_graph()
            .expect("build Rust scope graph");
        let symbols = graph.symbols();

        assert!(symbols.iter().any(|symbol| {
            symbol.kind == "function"
                && &source[symbol.range.start.byte..symbol.range.end.byte] == b"borrow"
        }));
        assert!(symbols.iter().any(|symbol| {
            symbol.kind == "struct"
                && &source[symbol.range.start.byte..symbol.range.end.byte] == b"Widget"
        }));
    }
}
