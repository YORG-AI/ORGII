//! Source-language detection for semantic chunk payloads.

#[cfg(feature = "semantic-search")]
use std::path::Path;

use crate::commands::helpers::is_supported_extension;

// ── Language Detection ──────────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
pub(super) fn get_lang_from_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?;
    if is_supported_extension(extension) {
        Some(extension.to_string())
    } else {
        None
    }
}
