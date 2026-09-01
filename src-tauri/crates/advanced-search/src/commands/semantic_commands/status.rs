//! Semantic availability and embedding model status reporting.

#[cfg(feature = "semantic-search")]
use super::model_dir::get_model_dir;
use crate::commands::types::EmbeddingModelStatus;
use crate::semantic::is_semantic_available;

#[tauri::command]
pub fn check_semantic_available() -> bool {
    is_semantic_available()
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
