//! Full-repository semantic indexing.

#[cfg(feature = "semantic-search")]
use std::path::PathBuf;
#[cfg(feature = "semantic-search")]
use std::sync::atomic::Ordering;
#[cfg(feature = "semantic-search")]
use tauri::Emitter;

#[cfg(feature = "semantic-search")]
use super::cancellation::{is_embedding_active, register_embedding, unregister_embedding};
#[cfg(feature = "semantic-search")]
use super::index_state::{ensure_semantic_index, get_or_create_semantic_index};
#[cfg(feature = "semantic-search")]
use super::lang::get_lang_from_extension;
#[cfg(feature = "semantic-search")]
use crate::commands::helpers::{collect_files, read_file_content};
#[cfg(feature = "semantic-search")]
use crate::commands::types::SearchFilters;
#[cfg(feature = "semantic-search")]
use crate::semantic::SemanticConfig;

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

    let files = collect_files(&path, &filters);
    let total_files = files.len();
    let mut processed_files = 0;
    let mut total_chunks = 0;
    let mut skipped_files = 0;
    let mut error_batches = 0;
    let start_time = std::time::Instant::now();
    let mut was_cancelled = false;

    const BATCH_FILES: usize = 50;
    const MAX_CHUNKS_PER_BATCH: usize = 100;

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
