//! Embedding model directory resolution and override.

#[cfg(feature = "semantic-search")]
use std::path::PathBuf;

#[cfg(feature = "semantic-search")]
use crate::commands::helpers::CUSTOM_MODEL_DIR;

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
