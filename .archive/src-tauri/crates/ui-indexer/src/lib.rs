//! UI Indexer
//!
//! Static analysis of frontend source code, indexed for instant in-IDE lookup.
//! Powers the embedded browser inspector and design-token scanning.
//!
//! Four sub-pipelines, all keyed by repository path and held in a single
//! [`UiIndexState`]:
//!
//! 1. **Component locator** — React/Vue/Svelte component name → source
//!    file/line. Drives "click an element in the browser → jump to source".
//! 2. **Token extraction** — scans CSS/SCSS files for `var(--token)` usage
//!    and definitions to back the design-token panel.
//!
//! ```text
//! Source files (tsx/jsx/vue/svelte/css) ─┐
//!                                        ├── tree-sitter / regex parsers
//! Repo path                            ──┘
//!                                        │
//!                                        ▼
//!                                 UiIndex  (HashMap, ~1ms lookup)
//! ```
//!
//! All Tauri commands prefixed `ui_index_*` (see [`commands`]). The
//! `scan_global_tokens` command is a stateless file parser that does not
//! touch the shared [`UiIndexState`].

mod commands;
mod indexer;
mod parser;
mod types;

pub use commands::*;
pub use indexer::UiIndexer;
pub use types::*;
