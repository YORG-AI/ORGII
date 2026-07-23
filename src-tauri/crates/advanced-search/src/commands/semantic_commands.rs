//! Semantic search commands — embedding, indexing, search, model management.

use super::types::{EmbeddingModelStatus, IncrementalResult};
use crate::semantic::{is_semantic_available, SemanticHit};

#[cfg(feature = "semantic-search")]
use std::collections::HashMap;
#[cfg(feature = "semantic-search")]
use std::path::{Path, PathBuf};
#[cfg(feature = "semantic-search")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "semantic-search")]
use std::sync::{Arc, RwLock};
#[cfg(feature = "semantic-search")]
use tauri::Emitter;

#[cfg(feature = "semantic-search")]
use super::helpers::{collect_files, read_file_content, CUSTOM_MODEL_DIR};
#[cfg(feature = "semantic-search")]
use super::types::SearchFilters;
use crate::commands::helpers::is_supported_extension;

// ── Semantic Index Singleton ────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
use std::sync::OnceLock;

#[cfg(feature = "semantic-search")]
use crate::semantic::SemanticConfig;

#[cfg(feature = "semantic-search")]
static GLOBAL_SEMANTIC_INDEX: OnceLock<tokio::sync::Mutex<Option<crate::semantic::SemanticIndex>>> =
    OnceLock::new();

// ── Embedding Cancellation Registry ─────────────────────────────────────

#[cfg(feature = "semantic-search")]
lazy_static::lazy_static! {
    static ref ACTIVE_EMBEDDINGS: RwLock<HashMap<String, Arc<AtomicBool>>> = RwLock::new(HashMap::new());
}

#[cfg(feature = "semantic-search")]
fn register_embedding(repo_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    ACTIVE_EMBEDDINGS
        .write()
        .unwrap()
        .insert(repo_id.to_string(), flag.clone());
    flag
}

#[cfg(feature = "semantic-search")]
fn unregister_embedding(repo_id: &str) {
    ACTIVE_EMBEDDINGS.write().unwrap().remove(repo_id);
}

#[cfg(feature = "semantic-search")]
fn is_embedding_active(repo_id: &str) -> bool {
    ACTIVE_EMBEDDINGS.read().unwrap().contains_key(repo_id)
}

// ── Language Detection ──────────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
fn get_lang_from_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?;
    if is_supported_extension(extension) {
        Some(extension.to_string())
    } else {
        None
    }
}

// ── Model Directory ─────────────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
fn default_model_dir() -> PathBuf {
    app_paths::models_dir()
}

#[cfg(feature = "semantic-search")]
pub(crate) fn get_model_dir() -> PathBuf {
    if let Ok(guard) = CUSTOM_MODEL_DIR.read() {
        if let Some(custom) = guard.as_ref() {
            return custom.clone();
        }
    }
    default_model_dir()
}

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub fn set_model_dir(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create model directory: {}", e))?;
    }
    if let Ok(mut guard) = CUSTOM_MODEL_DIR.write() {
        *guard = if path.is_empty() { None } else { Some(dir) };
    }
    Ok(())
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub fn set_model_dir(_path: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn get_model_dir_path() -> String {
    #[cfg(feature = "semantic-search")]
    {
        get_model_dir().to_string_lossy().to_string()
    }
    #[cfg(not(feature = "semantic-search"))]
    {
        String::new()
    }
}

#[tauri::command]
pub fn check_semantic_available() -> bool {
    is_semantic_available()
}

// ── Index Lifecycle ─────────────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
async fn get_or_create_semantic_index(
) -> Result<&'static tokio::sync::Mutex<Option<crate::semantic::SemanticIndex>>, String> {
    Ok(GLOBAL_SEMANTIC_INDEX.get_or_init(|| tokio::sync::Mutex::new(None)))
}

#[cfg(feature = "semantic-search")]
async fn ensure_semantic_index() -> Result<(), String> {
    use super::helpers::get_gpu_layers;
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

// ── Model Status & Download ─────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub fn check_embedding_model_status() -> EmbeddingModelStatus {
    let model_dir = get_model_dir();
    let ggml_dir = model_dir.join("coderank_ggml");
    let gguf_file = ggml_dir.join("coderankembed-q8_0.gguf");
    let tokenizer_file = ggml_dir.join("tokenizer.json");

    let installed = gguf_file.exists() && tokenizer_file.exists();
    let model_size_bytes = if gguf_file.exists() {
        std::fs::metadata(&gguf_file).ok().map(|m| m.len())
    } else {
        None
    };

    EmbeddingModelStatus {
        installed,
        model_size_bytes,
        model_dir: model_dir.to_string_lossy().to_string(),
    }
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub fn check_embedding_model_status() -> EmbeddingModelStatus {
    EmbeddingModelStatus {
        installed: false,
        model_size_bytes: None,
        model_dir: String::new(),
    }
}

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub fn delete_embedding_model() -> Result<(), String> {
    let model_dir = get_model_dir();
    let ggml_dir = model_dir.join("coderank_ggml");

    let gguf_file = ggml_dir.join("coderankembed-q8_0.gguf");
    let tokenizer_file = ggml_dir.join("tokenizer.json");

    if gguf_file.exists() {
        std::fs::remove_file(&gguf_file)
            .map_err(|e| format!("Failed to delete model file: {}", e))?;
    }
    if tokenizer_file.exists() {
        std::fs::remove_file(&tokenizer_file)
            .map_err(|e| format!("Failed to delete tokenizer: {}", e))?;
    }

    Ok(())
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub fn delete_embedding_model() -> Result<(), String> {
    Ok(())
}

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn download_embedding_model(window: tauri::Window) -> Result<(), String> {
    use std::io::{Read, Write};

    const GGUF_URL: &str = "https://huggingface.co/awhiteside/CodeRankEmbed-Q8_0-GGUF/resolve/main/coderankembed-q8_0.gguf";
    const TOKENIZER_URL: &str =
        "https://huggingface.co/nomic-ai/CodeRankEmbed/resolve/main/tokenizer.json";

    let model_dir = get_model_dir();
    let ggml_dir = model_dir.join("coderank_ggml");

    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&ggml_dir)
            .map_err(|e| format!("Failed to create model directory: {}", e))?;

        let files: Vec<(&str, &str, &str)> = vec![
            ("coderankembed-q8_0.gguf", GGUF_URL, "gguf"),
            ("tokenizer.json", TOKENIZER_URL, "tokenizer"),
        ];

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let mut cumulative_downloaded: u64 = 0;
        let mut grand_total: u64 = 0;
        let mut cumulative_base: u64 = 0;

        for (_idx, (file_name, url, file_id)) in files.iter().enumerate() {
            let dest = ggml_dir.join(file_name);
            if dest.exists() {
                println!("[ModelDownload] {} already exists, skipping", file_name);
                continue;
            }

            println!("[ModelDownload] Downloading {} from {}", file_name, url);
            let tmp_dest = ggml_dir.join(format!("{}.tmp", file_name));

            let mut response = client
                .get(*url)
                .send()
                .map_err(|e| format!("Failed to download {}: {}", file_name, e))?;

            if !response.status().is_success() {
                return Err(format!(
                    "Download failed for {}: HTTP {}",
                    file_name,
                    response.status()
                ));
            }

            let file_total = response.content_length().unwrap_or(0);
            grand_total += file_total;

            let _ = window.emit(
                "embedding-model-download-progress",
                serde_json::json!({
                    "file_name": file_name,
                    "file_id": file_id,
                    "downloaded_bytes": cumulative_downloaded,
                    "total_bytes": grand_total,
                    "status": "downloading",
                }),
            );

            let mut file = std::fs::File::create(&tmp_dest)
                .map_err(|e| format!("Failed to create temp file: {}", e))?;

            let mut file_downloaded: u64 = 0;
            let mut last_emit: u64 = 0;
            let mut buf = vec![0u8; 256 * 1024];

            loop {
                let bytes_read = response
                    .read(&mut buf)
                    .map_err(|e| format!("Download read error for {}: {}", file_name, e))?;
                if bytes_read == 0 {
                    break;
                }
                file.write_all(&buf[..bytes_read])
                    .map_err(|e| format!("Failed to write {}: {}", file_name, e))?;
                file_downloaded += bytes_read as u64;
                cumulative_downloaded = cumulative_base + file_downloaded;

                if file_downloaded - last_emit >= 256 * 1024 {
                    last_emit = file_downloaded;
                    let _ = window.emit(
                        "embedding-model-download-progress",
                        serde_json::json!({
                            "file_name": file_name,
                            "file_id": file_id,
                            "downloaded_bytes": cumulative_downloaded,
                            "total_bytes": grand_total,
                            "status": "downloading",
                        }),
                    );
                }
            }

            file.flush()
                .map_err(|e| format!("Failed to flush {}: {}", file_name, e))?;
            drop(file);

            std::fs::rename(&tmp_dest, &dest)
                .map_err(|e| format!("Failed to finalize {}: {}", file_name, e))?;

            cumulative_base += file_downloaded;
            cumulative_downloaded = cumulative_base;

            println!(
                "[ModelDownload] {} complete ({} bytes)",
                file_name, file_downloaded
            );

            let _ = window.emit(
                "embedding-model-download-progress",
                serde_json::json!({
                    "file_name": file_name,
                    "file_id": file_id,
                    "downloaded_bytes": cumulative_downloaded,
                    "total_bytes": grand_total,
                    "status": "complete",
                }),
            );
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Download task panicked: {}", e))?
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn download_embedding_model(window: tauri::Window) -> Result<(), String> {
    let _ = window;
    Err("Semantic search feature is not enabled".to_string())
}

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub fn get_model_info() -> Result<String, String> {
    let model_dir = get_model_dir();
    let mut info = format!("Model directory: {:?}\n", model_dir);
    info.push_str(&format!("Exists: {}\n", model_dir.exists()));

    if model_dir.exists() {
        let coderank_dir = model_dir.join("coderank");
        info.push_str(&format!("\nCodeRank directory: {:?}\n", coderank_dir));
        info.push_str(&format!("Exists: {}\n", coderank_dir.exists()));
        if coderank_dir.exists() {
            let config = coderank_dir.join("config.json");
            let model_file = coderank_dir.join("model.safetensors");
            let tokenizer = coderank_dir.join("tokenizer.json");
            info.push_str(&format!("  - config.json: {}\n", config.exists()));
            info.push_str(&format!("  - model.safetensors: {}\n", model_file.exists()));
            info.push_str(&format!("  - tokenizer.json: {}\n", tokenizer.exists()));
        }

        let jina_dir = model_dir.join("jina");
        info.push_str(&format!("\nJina directory: {:?}\n", jina_dir));
        info.push_str(&format!("Exists: {}\n", jina_dir.exists()));
        if jina_dir.exists() {
            let config = jina_dir.join("config.json");
            let model_file = jina_dir.join("model.safetensors");
            let tokenizer = jina_dir.join("tokenizer.json");
            info.push_str(&format!("  - config.json: {}\n", config.exists()));
            info.push_str(&format!("  - model.safetensors: {}\n", model_file.exists()));
            info.push_str(&format!("  - tokenizer.json: {}\n", tokenizer.exists()));
        }
    }

    Ok(info)
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub fn get_model_info() -> Result<String, String> {
    Ok("Semantic search feature is not enabled".to_string())
}

// ── Semantic Search ─────────────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn search_semantic(
    query: String,
    repo_filter: Option<String>,
    limit: Option<usize>,
    _model_id: Option<String>,
    offset: Option<usize>,
) -> Result<Vec<SemanticHit>, String> {
    println!("🔍 [Command] search_semantic called:");
    println!("   query: '{}'", query);
    println!("   repo_filter: {:?}", repo_filter);
    println!("   limit: {:?}", limit);

    ensure_semantic_index().await?;

    let index_mutex = get_or_create_semantic_index().await?;
    let guard = index_mutex.lock().await;

    let index = guard
        .as_ref()
        .ok_or_else(|| "Semantic index not initialized".to_string())?;

    let limit = limit.unwrap_or(20);
    let offset = offset.unwrap_or(0);

    let results = index
        .search(&query, repo_filter.as_deref(), limit + offset + 1)
        .await
        .map_err(|e| format!("Semantic search failed: {}", e))?;

    let paginated_results: Vec<_> = results.into_iter().skip(offset).take(limit).collect();

    println!(
        "   ✅ Returning {} results (offset: {})",
        paginated_results.len(),
        offset
    );

    Ok(paginated_results)
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn search_semantic(
    _query: String,
    _repo_filter: Option<String>,
    _limit: Option<usize>,
    _model_id: Option<String>,
    _offset: Option<usize>,
) -> Result<Vec<SemanticHit>, String> {
    Err("Semantic search is not enabled. Build with --features semantic-search".to_string())
}

// ── Semantic Indexing ───────────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn index_repository_semantic(
    repo_id: String,
    repo_path: String,
    _model_id: Option<String>,
    window: tauri::Window,
) -> Result<usize, String> {
    let path = PathBuf::from(&repo_path);
    if !path.exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    if is_embedding_active(&repo_id) {
        return Err(format!(
            "Embedding already in progress for repo_id: {}",
            repo_id
        ));
    }

    let cancelled = register_embedding(&repo_id);

    let repo_id_for_cleanup = repo_id.clone();
    scopeguard::defer! {
        unregister_embedding(&repo_id_for_cleanup);
    }

    ensure_semantic_index().await?;

    let index_mutex = get_or_create_semantic_index().await?;
    let guard = index_mutex.lock().await;

    let index = guard
        .as_ref()
        .ok_or_else(|| "Semantic index not initialized".to_string())?;

    println!(
        "🧹 [Embedding] Auto-clearing existing embeddings for repo_id: '{}'",
        repo_id
    );
    match index.delete_repo(&repo_id).await {
        Ok(_) => println!(
            "✅ [Embedding] Cleared existing embeddings for repo_id: '{}'",
            repo_id
        ),
        Err(e) => println!("⚠️ [Embedding] No existing embeddings to clear ({})", e),
    }

    let config = SemanticConfig::default();

    let chunk_size = config.chunk_size;
    let chunk_overlap = config.chunk_overlap;

    let filters = SearchFilters {
        file_extensions: None,
        exclude_dirs: None,
        case_sensitive: None,
        whole_word: None,
        use_regex: None,
        max_results: None,
    };

    use crate::semantic::{chunk_code, CodeChunkPayload};

    let mut files = collect_files(&path, &filters);
    let max_files = std::env::var("ORGII_EMBED_MAX_FILES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(100_000)
        .clamp(1_000, 1_000_000);
    if files.len() > max_files {
        files.truncate(max_files);
        println!("⚠️ [Embedding] File cap reached: {}", max_files);
    }
    let total_files = files.len();
    let mut processed_files = 0;
    let mut total_chunks = 0;
    let mut skipped_files = 0;
    let mut error_batches = 0;
    let start_time = std::time::Instant::now();
    let mut was_cancelled = false;

    const BATCH_FILES: usize = 20;
    const MAX_CHUNKS_PER_BATCH: usize = 64;

    println!(
        "🧠 [Embedding] Starting: {} files (USearch, batch={} files, max {} chunks/batch)",
        total_files, BATCH_FILES, MAX_CHUNKS_PER_BATCH
    );
    println!("   📂 repo_id being stored: '{}'", repo_id);
    println!("   📂 repo_path: '{}'", repo_path);

    println!("📡 [Embedding] Emitting initial progress event to frontend...");
    match window.emit(
        "embedding-progress",
        serde_json::json!({
            "repo_path": repo_path,
            "current": 0,
            "total": total_files,
            "chunks": 0,
            "errors": 0,
        }),
    ) {
        Ok(_) => println!("✅ [Embedding] Initial progress event emitted successfully"),
        Err(e) => println!("❌ [Embedding] Failed to emit initial progress: {}", e),
    }

    'batch_loop: for file_batch in files.chunks(BATCH_FILES) {
        if cancelled.load(Ordering::SeqCst) {
            println!(
                "🛑 [Embedding] Cancellation detected, stopping after {} files...",
                processed_files
            );
            was_cancelled = true;
            break 'batch_loop;
        }

        let mut batch_chunks: Vec<CodeChunkPayload> = Vec::new();

        for file_path in file_batch {
            if cancelled.load(Ordering::SeqCst) {
                was_cancelled = true;
                break;
            }

            if let Some(content) = read_file_content(file_path) {
                let relative_path = file_path
                    .strip_prefix(&path)
                    .unwrap_or(file_path)
                    .to_string_lossy()
                    .to_string();
                let language =
                    get_lang_from_extension(file_path).unwrap_or_else(|| "unknown".to_string());

                let chunks = chunk_code(&content, chunk_size, chunk_overlap);
                for chunk in chunks {
                    batch_chunks.push(CodeChunkPayload {
                        repo_id: repo_id.clone(),
                        repo_path: repo_path.clone(),
                        relative_path: relative_path.clone(),
                        language: language.to_string(),
                        content: chunk.content,
                        start_line: chunk.start_line as u64,
                        end_line: chunk.end_line as u64,
                        content_hash: chunk.hash,
                    });
                }
                processed_files += 1;
            } else {
                skipped_files += 1;
                processed_files += 1;
            }
        }

        if was_cancelled {
            break 'batch_loop;
        }

        const MAX_RETRIES: usize = 3;
        const INITIAL_RETRY_DELAY_MS: u64 = 100;

        if !batch_chunks.is_empty() {
            for chunk_batch in batch_chunks.chunks(MAX_CHUNKS_PER_BATCH) {
                if cancelled.load(Ordering::SeqCst) {
                    println!("🛑 [Embedding] Cancellation detected during batch processing");
                    was_cancelled = true;
                    break;
                }

                let chunk_count = chunk_batch.len();
                let chunk_vec = chunk_batch.to_vec();

                let mut retry_count = 0;
                let mut last_error: Option<String> = None;
                let mut success = false;

                while retry_count < MAX_RETRIES && !success {
                    if cancelled.load(Ordering::SeqCst) {
                        was_cancelled = true;
                        break;
                    }

                    match index.batch_index_chunks(chunk_vec.clone()).await {
                        Ok(indexed) => {
                            total_chunks += indexed;
                            success = true;
                            if retry_count > 0 {
                                println!("   ✅ Batch succeeded after {} retries", retry_count);
                            }
                        }
                        Err(e) => {
                            retry_count += 1;
                            let error_msg = e.to_string();
                            last_error = Some(error_msg.clone());

                            let is_fatal = error_msg.contains("giving up");

                            if retry_count < MAX_RETRIES && !is_fatal {
                                let delay_ms = INITIAL_RETRY_DELAY_MS * (1 << (retry_count - 1));
                                println!(
                                    "   ⚠️ Batch failed (attempt {}/{}), retrying in {}ms: {}",
                                    retry_count, MAX_RETRIES, delay_ms, e
                                );
                                tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms))
                                    .await;
                            } else if is_fatal {
                                println!("   ❌ Fatal embedder error, not retrying: {}", e);
                                break;
                            }
                        }
                    }
                }

                if !success && !was_cancelled {
                    error_batches += 1;
                    if error_batches <= 5 {
                        println!(
                            "   ❌ Batch failed after {} retries ({} chunks): {}",
                            MAX_RETRIES,
                            chunk_count,
                            last_error.unwrap_or_default()
                        );
                    }
                }
            }
        }

        if was_cancelled {
            break 'batch_loop;
        }

        let elapsed = start_time.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 {
            (total_chunks as f64 / elapsed) as u32
        } else {
            0
        };
        let percent = (processed_files * 100) / total_files.max(1);

        let status_icon = if processed_files >= total_files {
            "✅"
        } else {
            "📊"
        };
        let error_info = if error_batches > 0 {
            format!(" • {} batch errors", error_batches)
        } else {
            String::new()
        };

        println!(
            "   {} {}/{} files ({}%) • {} chunks • {} chunks/s{}",
            status_icon, processed_files, total_files, percent, total_chunks, speed, error_info
        );

        use std::io::Write;
        let _ = std::io::stdout().flush();

        if let Err(e) = window.emit(
            "embedding-progress",
            serde_json::json!({
                    "repo_path": repo_path,
                    "current": processed_files,
                    "total": total_files,
                    "chunks": total_chunks,
            "errors": error_batches,
                }),
        ) {
            println!("   ⚠️ Failed to emit progress event: {}", e);
        }
    }

    let elapsed = start_time.elapsed().as_secs_f64();
    let speed = if elapsed > 0.0 {
        (total_chunks as f64 / elapsed) as u32
    } else {
        0
    };

    if was_cancelled {
        println!("🧹 [Embedding] Cleaning up partial data after cancellation...");

        match index.delete_repo(&repo_id).await {
            Ok(_) => println!(
                "✅ [Embedding] Cleaned up {} partial chunks for repo_id: '{}'",
                total_chunks, repo_id
            ),
            Err(e) => println!("⚠️ [Embedding] Failed to clean up partial data: {}", e),
        }

        if let Err(e) = index.save() {
            println!("⚠️ [Embedding] Failed to save index after cleanup: {}", e);
        }

        let _ = window.emit(
            "semantic-indexing-cancelled",
            serde_json::json!({
                "repo_id": repo_id,
                "repo_path": repo_path,
                "status": "cancelled",
                "files_processed": processed_files,
                "total_files": total_files,
                "chunks_before_cleanup": total_chunks,
            }),
        );

        println!(
            "🛑 [Embedding] Cancelled: {} files processed, {} chunks cleaned up in {:.1}s",
            processed_files, total_chunks, elapsed
        );

        return Err(format!("Embedding cancelled for repo_id: {}", repo_id));
    }

    if let Err(e) = index.save() {
        println!("⚠️ [Embedding] Failed to save index: {}", e);
    }

    let is_complete_failure = total_chunks == 0 && processed_files > 0 && error_batches > 0;
    let is_partial_failure = error_batches > 0 && total_chunks > 0;

    if is_complete_failure {
        println!(
            "❌ [Embedding] FAILED: 0 chunks from {} files ({} batch errors) in {:.1}s",
            processed_files, error_batches, elapsed
        );

        let _ = window.emit("embedding-failed", serde_json::json!({
            "repo_id": repo_id,
            "repo_path": repo_path,
            "status": "failed",
            "error": format!("Embedding failed: all {} batches encountered errors", error_batches),
            "files_processed": processed_files,
            "total_files": total_files,
            "error_batches": error_batches,
            "chunks": 0,
        }));

        return Err(format!(
            "Embedding failed for repo_id: {} ({} batch errors, 0 chunks indexed)",
            repo_id, error_batches
        ));
    } else if is_partial_failure {
        println!("⚠️ [Embedding] Complete with errors: {} chunks from {} files ({} batch errors, {} skipped) in {:.1}s ({} chunks/s)",
            total_chunks, processed_files - skipped_files, error_batches, skipped_files, elapsed, speed);

        let _ = window.emit(
            "embedding-complete",
            serde_json::json!({
                "repo_id": repo_id,
                "repo_path": repo_path,
                "chunks": total_chunks,
                "files": processed_files,
                "error_batches": error_batches,
                "has_errors": true,
                "status": "partial",
            }),
        );
    } else {
        println!(
            "✅ [Embedding] Complete: {} chunks from {} files in {:.1}s ({} chunks/s)",
            total_chunks,
            processed_files - skipped_files,
            elapsed,
            speed
        );

        let _ = window.emit(
            "embedding-complete",
            serde_json::json!({
                    "repo_id": repo_id,
                "repo_path": repo_path,
                "chunks": total_chunks,
                "files": processed_files,
                    "error_batches": 0,
                    "has_errors": false,
                    "status": "success",
            }),
        );
    }

    Ok(total_chunks)
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn index_repository_semantic(
    _repo_id: String,
    _repo_path: String,
    _model_id: Option<String>,
    _window: tauri::Window,
) -> Result<usize, String> {
    Err("Semantic search is not enabled. Build with --features semantic-search".to_string())
}

// ── Semantic Repository Management ──────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn remove_repository_semantic(repo_id: String) -> Result<(), String> {
    if !is_semantic_available() {
        return Err("Semantic search is not available".to_string());
    }

    ensure_semantic_index().await?;

    let index_mutex = get_or_create_semantic_index().await?;
    let guard = index_mutex.lock().await;

    let index = guard
        .as_ref()
        .ok_or_else(|| "Semantic index not initialized".to_string())?;

    index
        .delete_repo(&repo_id)
        .await
        .map_err(|e| format!("Failed to delete repo vectors: {}", e))?;

    if let Err(e) = index.save() {
        println!("⚠️ [Semantic] Failed to save index after deletion: {}", e);
    }

    println!("🗑️ [Semantic] Removed embeddings for repo_id: {}", repo_id);

    Ok(())
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn remove_repository_semantic(_repo_id: String) -> Result<(), String> {
    Err("Semantic search is not enabled. Build with --features semantic-search".to_string())
}

// ── Incremental Semantic Indexing ────────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn incremental_index_semantic(
    repo_id: String,
    repo_path: String,
    file_paths: Vec<String>,
    _model_id: Option<String>,
) -> Result<IncrementalResult, String> {
    use crate::semantic::{chunk_code, CodeChunkPayload, SemanticConfig};

    if !is_semantic_available() {
        return Err("Semantic search is not available".to_string());
    }

    ensure_semantic_index().await?;

    let index_mutex = get_or_create_semantic_index().await?;
    let guard = index_mutex.lock().await;
    let index = guard
        .as_ref()
        .ok_or_else(|| "Semantic index not initialized".to_string())?;

    let config = SemanticConfig::default();
    let path = PathBuf::from(&repo_path);
    let mut files_updated = 0;
    let mut files_failed = 0;
    let mut failed_paths = Vec::new();

    index
        .delete_file_chunks(&repo_id, &file_paths)
        .await
        .map_err(|e| format!("Failed to delete old chunks: {}", e))?;

    for rel_path in &file_paths {
        let file_path = path.join(rel_path);
        let content = match std::fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(_) => {
                files_failed += 1;
                failed_paths.push(rel_path.clone());
                continue;
            }
        };

        let lang = get_lang_from_extension(&file_path).unwrap_or_else(|| "unknown".to_string());
        let chunks = chunk_code(&content, config.chunk_size, config.chunk_overlap);

        let payloads: Vec<CodeChunkPayload> = chunks
            .into_iter()
            .map(|chunk| CodeChunkPayload {
                repo_id: repo_id.clone(),
                repo_path: repo_path.clone(),
                relative_path: rel_path.clone(),
                language: lang.to_string(),
                content: chunk.content,
                start_line: chunk.start_line as u64,
                end_line: chunk.end_line as u64,
                content_hash: chunk.hash,
            })
            .collect();

        if payloads.is_empty() {
            files_updated += 1;
            continue;
        }

        match index.batch_index_chunks(payloads).await {
            Ok(_) => files_updated += 1,
            Err(err) => {
                tracing::warn!("Failed to embed {}: {}", rel_path, err);
                files_failed += 1;
                failed_paths.push(rel_path.clone());
            }
        }
    }

    if let Err(e) = index.save() {
        tracing::warn!(
            "Failed to save semantic index after incremental update: {}",
            e
        );
    }

    println!(
        "🔄 [Semantic] Incremental: {} updated, {} failed out of {} files",
        files_updated,
        files_failed,
        file_paths.len()
    );

    Ok(IncrementalResult {
        files_updated,
        files_failed,
        failed_paths,
    })
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn incremental_index_semantic(
    _repo_id: String,
    _repo_path: String,
    _file_paths: Vec<String>,
    _model_id: Option<String>,
) -> Result<IncrementalResult, String> {
    Err("Semantic search is not enabled. Build with --features semantic-search".to_string())
}

// ── Cancellation & Embedder Control ─────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn cancel_semantic_indexing(
    repo_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    println!("🛑 [Semantic] Cancel requested for repo_id: {}", repo_id);

    let cancelled = {
        let embeddings = ACTIVE_EMBEDDINGS.read().unwrap();
        if let Some(flag) = embeddings.get(&repo_id) {
            flag.store(true, Ordering::SeqCst);
            println!(
                "🛑 [Semantic] Cancellation flag set for repo_id: {}",
                repo_id
            );
            true
        } else {
            println!(
                "⚠️ [Semantic] No active embedding job found for repo_id: {}",
                repo_id
            );
            false
        }
    };

    if cancelled {
        let _ = window.emit(
            "semantic-indexing-cancelled",
            serde_json::json!({
                "repo_id": repo_id,
                "status": "cancellation_requested",
            }),
        );
    }

    Ok(cancelled)
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn cancel_semantic_indexing(
    _repo_id: String,
    _window: tauri::Window,
) -> Result<bool, String> {
    Err("Semantic search is not enabled. Build with --features semantic-search".to_string())
}

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn stop_embedder() -> Result<(), String> {
    println!("🛑 [Embedder] Stop requested - releasing semantic index to terminate subprocess");

    let index_mutex = get_or_create_semantic_index().await?;
    let mut guard = index_mutex.lock().await;

    if guard.is_some() {
        *guard = None;
        println!("✅ [Embedder] Semantic index released, subprocess will terminate");
    } else {
        println!("ℹ️ [Embedder] No active embedder to stop");
    }

    Ok(())
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn stop_embedder() -> Result<(), String> {
    Ok(())
}

// ── Debug ───────────────────────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn debug_qdrant_collection_info() -> Result<String, String> {
    ensure_semantic_index().await?;

    let index_mutex = get_or_create_semantic_index().await?;
    let guard = index_mutex.lock().await;

    let index = guard
        .as_ref()
        .ok_or_else(|| "Semantic index not initialized".to_string())?;

    let info_map = index.get_info();

    let mut info = String::new();
    info.push_str("📊 USearch Index Info:\n");
    info.push_str(&format!(
        "   Vector count: {}\n",
        info_map
            .get("vector_count")
            .unwrap_or(&serde_json::json!(0))
    ));
    info.push_str(&format!(
        "   Capacity: {}\n",
        info_map.get("capacity").unwrap_or(&serde_json::json!(0))
    ));
    info.push_str(&format!(
        "   Dimensions: {}\n",
        info_map
            .get("dimensions")
            .unwrap_or(&serde_json::json!(768))
    ));
    info.push_str(&format!(
        "   Index path: {}\n",
        info_map
            .get("index_path")
            .unwrap_or(&serde_json::json!("unknown"))
    ));
    info.push_str(&format!(
        "   Idle seconds: {}\n",
        info_map
            .get("idle_seconds")
            .unwrap_or(&serde_json::json!(0))
    ));

    println!("{}", info);
    Ok(info)
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn debug_qdrant_collection_info() -> Result<String, String> {
    Err("Semantic search is not enabled".to_string())
}
