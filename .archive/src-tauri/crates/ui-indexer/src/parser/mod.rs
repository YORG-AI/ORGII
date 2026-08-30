//! Parser module for extracting component information from source files
//!
//! Supports:
//! - JSX/TSX (React) - via tree-sitter
//! - Vue SFC - via regex-based parsing
//! - Svelte - via regex-based parsing
//!
mod jsx;
mod svelte;
mod token_extractor;
mod vue;

pub use jsx::JsxParser;
pub use svelte::SvelteParser;
pub use token_extractor::{TokenDefinitionExtractor, TokenDefinitionsResult};
pub use vue::VueParser;

use std::path::Path;

/// Determine the parser to use based on file extension
pub fn get_file_type(path: &Path) -> Option<FileType> {
    let ext = path.extension()?.to_str()?;
    match ext {
        "tsx" => Some(FileType::Tsx),
        "jsx" => Some(FileType::Jsx),
        "ts" => Some(FileType::Ts),
        "js" => Some(FileType::Js),
        "vue" => Some(FileType::Vue),
        "svelte" => Some(FileType::Svelte),
        _ => None,
    }
}

/// Supported file types
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileType {
    Tsx,
    Jsx,
    Ts,
    Js,
    Vue,
    Svelte,
}

impl FileType {
    #[allow(dead_code)]
    pub fn has_jsx(&self) -> bool {
        matches!(self, FileType::Tsx | FileType::Jsx)
    }

    #[allow(dead_code)]
    pub fn is_typescript(&self) -> bool {
        matches!(self, FileType::Tsx | FileType::Ts)
    }
}

#[cfg(test)]
#[path = "tests/mod_tests.rs"]
mod tests;
