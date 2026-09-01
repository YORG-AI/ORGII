use crate::providers::cursor::CursorValidator;

/// Auto-detect keys from local config files and environment variables
#[tauri::command]
pub async fn auto_detect_key(
    agent_type: String,
) -> Result<crate::auto_detect::AutoDetectResult, String> {
    Ok(crate::auto_detect::auto_detect_key(&agent_type).await)
}

/// Extract API key and base URL from raw text input using regex.
#[tauri::command]
pub fn extract_keys_from_text(
    input: String,
    agent_type: Option<String>,
) -> crate::key_extractor::ExtractionResult {
    crate::key_extractor::extract_keys(&input, agent_type.as_deref())
}

/// Get available models for Cursor CLI via local CLI command.
/// This calls `cursor agent --list-models` to get the actual models available
/// for the given API key. Used when listing on market to get real model list.
#[tauri::command]
pub async fn get_cursor_cli_models(api_key: String) -> Result<Vec<String>, String> {
    use log::info;
    info!("[get_cursor_cli_models] Fetching models via CLI...");

    let validator = CursorValidator::new();
    let models = validator.get_available_models(&api_key).await?;

    info!(
        "[get_cursor_cli_models] Got {} models from CLI",
        models.len()
    );
    Ok(models)
}

/// Get available models by calling Cursor's native API directly.
///
/// Hits `api2.cursor.sh/aiserver.v1.AiService/GetUsableModels` with the
/// account's session JWT as bearer. Does NOT require the local `cursor` CLI
/// to be installed. Returns the full model catalog the account can see
/// (subscription filtering happens at chat time, not discovery time).
///
/// Preferred over `get_cursor_cli_models` when a session token is available.
#[tauri::command]
pub async fn cursor_list_models_native(
    session_token: String,
) -> Result<Vec<crate::providers::cursor::CursorNativeModel>, String> {
    use log::info;
    info!("[cursor_list_models_native] Fetching models via api2.cursor.sh...");

    let validator = CursorValidator::new();
    let models = validator.get_native_models(&session_token).await?;

    info!(
        "[cursor_list_models_native] Got {} models from native API",
        models.len()
    );
    Ok(models)
}
