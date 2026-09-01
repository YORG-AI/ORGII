//! Semantic index singleton and lazy initialization.

#[cfg(feature = "semantic-search")]
use super::model_dir::get_model_dir;

// ── Semantic Index Singleton ────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
use std::sync::OnceLock;

#[cfg(feature = "semantic-search")]
use crate::semantic::SemanticConfig;

#[cfg(feature = "semantic-search")]
static GLOBAL_SEMANTIC_INDEX: OnceLock<tokio::sync::Mutex<Option<crate::semantic::SemanticIndex>>> =
    OnceLock::new();

// ── Index Lifecycle ─────────────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
pub(super) async fn get_or_create_semantic_index(
) -> Result<&'static tokio::sync::Mutex<Option<crate::semantic::SemanticIndex>>, String> {
    Ok(GLOBAL_SEMANTIC_INDEX.get_or_init(|| tokio::sync::Mutex::new(None)))
}

#[cfg(feature = "semantic-search")]
pub(super) async fn ensure_semantic_index() -> Result<(), String> {
    use crate::commands::helpers::get_gpu_layers;
    use crate::semantic::SemanticIndex;
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    use crate::semantic::{GgmlEmbedder, SubprocessEmbedder};
    use std::sync::Arc;

    let index_mutex = get_or_create_semantic_index().await?;
    let mut guard = index_mutex.lock().await;

    if guard.is_none() {
        println!("🔧 [Semantic] Initializing USearch index (first time)...");

        let config = SemanticConfig::default();

        let embedder: Arc<dyn crate::semantic::Embedder> = {
            let model_dir = get_model_dir();

            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            {
                let use_subprocess = std::env::var("ORGII_EMBEDDER_INPROCESS").is_err();
                let gpu_layers = get_gpu_layers();

                if use_subprocess {
                    println!("🔒 [Semantic] Using isolated subprocess embedder (crash-safe)");
                    Arc::new(
                        SubprocessEmbedder::new(&model_dir, gpu_layers)
                            .map_err(|e| format!("Failed to start embedder subprocess: {}", e))?,
                    )
                } else {
                    println!(
                        "⚡ [Semantic] Using in-process embedder (faster, crashes affect app)"
                    );
                    Arc::new(
                        GgmlEmbedder::new(&model_dir, gpu_layers).map_err(|e| {
                            format!("Failed to load CodeRankEmbed (Metal GPU): {}", e)
                        })?,
                    )
                }
            }

            #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
            {
                return Err(
                    "Semantic search requires Apple Silicon (M1/M2/M3) with Metal GPU".to_string(),
                );
            }
        };

        let index_path = app_paths::semantic_index_dir();
        let index = SemanticIndex::new(config, embedder, index_path)
            .await
            .map_err(|e| format!("Failed to initialize USearch index: {}", e))?;

        *guard = Some(index);
        println!("✅ [Semantic] USearch index initialized and cached");
    }

    Ok(())
}
