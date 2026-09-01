//! Embedding model asset lifecycle — download and deletion.

#[cfg(feature = "semantic-search")]
use tauri::Emitter;

#[cfg(feature = "semantic-search")]
use super::model_dir::get_model_dir;

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
