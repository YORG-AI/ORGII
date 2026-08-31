//! Intelligence Module
//!
//! Provides Tree-sitter based code intelligence:
//! - Scope graph construction
//! - Symbol extraction
//! - Go-to-definition and find-references

// Many items are part of the public API but not yet used internally
#[allow(dead_code)]
mod language;
mod namespace;
mod scope_resolution;

pub use language::{Language, TSLanguage, TSLanguageConfig, ALL_LANGUAGES};
pub use namespace::*;
pub use scope_resolution::ScopeGraph;

use scope_resolution::ResolutionMethod;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Parser, Tree};

use super::super::text_range::TextRange;

const MAX_FILE_SIZE_BYTES: usize = 500_000;
const PARSE_TIMEOUT_MICROS: u64 = 1_000_000;

/// A tree-sitter representation of a file
pub struct TreeSitterFile<'a> {
    /// The original source that was used to generate this file.
    src: &'a [u8],

    /// The syntax tree of this file.
    tree: Tree,

    /// The supplied language for this file.
    language: &'static TSLanguageConfig,
}

#[derive(Debug)]
pub enum TreeSitterFileError {
    UnsupportedLanguage,
    ParseTimeout,
    LanguageMismatch,
    QueryError(tree_sitter::QueryError),
    FileTooLarge,
}

impl<'a> TreeSitterFile<'a> {
    /// Create a TreeSitterFile out of a sourcefile
    pub fn try_build(src: &'a [u8], lang_id: &str) -> Result<Self, TreeSitterFileError> {
        Self::try_build_with_language(src, || TSLanguage::from_id(lang_id))
    }

    /// Create a TreeSitterFile from a file extension
    pub fn try_build_from_extension(
        src: &'a [u8],
        extension: &str,
    ) -> Result<Self, TreeSitterFileError> {
        Self::try_build_with_language(src, || TSLanguage::from_extension(extension))
    }

    fn try_build_with_language(
        src: &'a [u8],
        resolve_language: impl FnOnce() -> TSLanguage,
    ) -> Result<Self, TreeSitterFileError> {
        // Reject oversized files before language lookup in either entry point.
        if src.len() > MAX_FILE_SIZE_BYTES {
            return Err(TreeSitterFileError::FileTooLarge);
        }

        let language = match resolve_language() {
            Language::Supported(language) => Ok(language),
            Language::Unsupported => Err(TreeSitterFileError::UnsupportedLanguage),
        }?;

        let mut parser = Parser::new();
        parser
            .set_language(&(language.grammar)())
            .map_err(|_| TreeSitterFileError::LanguageMismatch)?;

        parser.set_timeout_micros(PARSE_TIMEOUT_MICROS);

        let tree = parser
            .parse(src, None)
            .ok_or(TreeSitterFileError::ParseTimeout)?;

        Ok(Self {
            src,
            tree,
            language,
        })
    }

    pub fn hoverable_ranges(self) -> Result<Vec<TextRange>, TreeSitterFileError> {
        let query = self
            .language
            .hoverable_query
            .query(self.language.grammar)
            .map_err(TreeSitterFileError::QueryError)?;
        let root_node = self.tree.root_node();
        let mut cursor = tree_sitter::QueryCursor::new();
        let mut matches = cursor.matches(query, root_node, self.src);
        let mut ranges = Vec::new();
        while let Some(m) = matches.next() {
            for capture in m.captures {
                ranges.push(capture.node.range().into());
            }
        }
        Ok(ranges)
    }

    /// Produce a lexical scope-graph for this TreeSitterFile.
    pub fn scope_graph(self) -> Result<ScopeGraph, TreeSitterFileError> {
        let query = self
            .language
            .scope_query
            .query(self.language.grammar)
            .map_err(TreeSitterFileError::QueryError)?;
        let root_node = self.tree.root_node();

        Ok(ResolutionMethod::Generic.build_scope(query, root_node, self.src, self.language))
    }

    /// Get the language configuration
    pub fn language(&self) -> &'static TSLanguageConfig {
        self.language
    }

    /// Get the source bytes
    pub fn source(&self) -> &[u8] {
        self.src
    }

    /// Get the syntax tree
    pub fn tree(&self) -> &Tree {
        &self.tree
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_id_and_extension_build_the_same_syntax_tree() {
        for (language_id, extension, source) in [
            ("rust", "rs", "fn main() {}"),
            ("javascript", "js", "function main() {}"),
            ("typescript", "ts", "const answer: number = 42;"),
            ("python", "py", "def main():\n    pass\n"),
        ] {
            let source = source.as_bytes();
            let by_id = TreeSitterFile::try_build(source, language_id).expect("language ID");
            let by_extension = TreeSitterFile::try_build_from_extension(source, extension)
                .expect("file extension");

            assert!(std::ptr::eq(by_id.language(), by_extension.language()));
            assert_eq!(by_id.source(), source);
            assert_eq!(by_extension.source(), source);
            assert!(!by_id.tree().root_node().has_error(), "{language_id}");
            assert_eq!(
                by_id.tree().root_node().to_sexp(),
                by_extension.tree().root_node().to_sexp(),
                "{language_id}"
            );
        }
    }

    #[test]
    fn constructors_preserve_size_limit_and_error_precedence() {
        let oversized = vec![b' '; MAX_FILE_SIZE_BYTES + 1];
        for result in [
            TreeSitterFile::try_build(&oversized, "rust"),
            TreeSitterFile::try_build_from_extension(&oversized, "rs"),
            TreeSitterFile::try_build(&oversized, "unsupported"),
            TreeSitterFile::try_build_from_extension(&oversized, "unsupported"),
        ] {
            assert!(matches!(result, Err(TreeSitterFileError::FileTooLarge)));
        }

        // Exactly the byte limit is accepted by the size guard, so language
        // validation must still run and report the unknown language.
        let at_limit = &oversized[..MAX_FILE_SIZE_BYTES];
        for result in [
            TreeSitterFile::try_build(at_limit, "unsupported"),
            TreeSitterFile::try_build_from_extension(at_limit, "unsupported"),
        ] {
            assert!(matches!(
                result,
                Err(TreeSitterFileError::UnsupportedLanguage)
            ));
        }
    }
}
