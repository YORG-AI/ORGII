//! Semantic search commands — embedding, indexing, search, model management.
//!
//! Organized into submodules by responsibility:
//! - `model_dir`: embedding model directory resolution and override
//! - `status`: semantic availability and embedding model status reporting
//! - `model_assets`: embedding model download and deletion
//! - `index_state`: semantic index singleton and lazy initialization
//! - `lang`: source-language detection for chunk payloads
//! - `search`: semantic vector search
//! - `indexing`: full-repository semantic indexing
//! - `incremental`: incremental re-indexing of changed files
//! - `repository`: removal of a repository's embeddings
//! - `cancellation`: cancellation registry and embedder shutdown
//! - `debug`: semantic index introspection

mod cancellation;
mod debug;
mod incremental;
mod index_state;
mod indexing;
mod lang;
mod model_assets;
mod model_dir;
mod repository;
mod search;
mod status;

// Re-export all items from the command submodules to ensure Tauri command
// macros work correctly. The #[tauri::command] macro generates `__cmd__`
// prefixed macros that must be reachable from this module for
// `generate_handler!` to resolve `advanced_search::commands::<command>`.
pub use cancellation::*;
pub use debug::*;
pub use incremental::*;
pub use indexing::*;
pub use model_assets::*;
pub use model_dir::*;
pub use repository::*;
pub use search::*;
pub use status::*;

#[cfg(feature = "semantic-search")]
pub(crate) use model_dir::get_model_dir;
