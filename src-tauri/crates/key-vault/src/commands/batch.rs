use super::validate::{run_validate_key, validate_token_format};

/// Summary of key validation
#[derive(serde::Serialize)]
pub struct KeyValidationSummary {
    pub id: String,
    pub name: String,
    pub agent_type: String,
    pub format_valid: bool,
    pub format_message: String,
    pub api_valid: Option<bool>,
    pub api_message: Option<String>,
    pub models_count: Option<usize>,
}

/// Validate all keys from the local keys file (~/.orgii/credentials.json)
/// Returns a summary of validation results for each entry
#[tauri::command]
pub async fn validate_keys_from_file() -> Result<Vec<KeyValidationSummary>, String> {
    use serde::Deserialize;
    use std::collections::HashMap;
    use std::fs;

    #[derive(Deserialize)]
    struct KeysFile {
        credentials: HashMap<String, StoredKeyRow>,
    }

    #[derive(Deserialize)]
    struct StoredKeyRow {
        id: String,
        name: String,
        agent_type: String,
        api_key: Option<String>,
        session_token: Option<String>,
        base_url: Option<String>,
    }

    // Read keys file on blocking thread
    let creds_file: KeysFile = tokio::task::spawn_blocking(|| {
        let creds_path = app_paths::keys();

        if !creds_path.exists() {
            return Err("Credentials file not found".to_string());
        }

        let contents = fs::read_to_string(&creds_path)
            .map_err(|e| format!("Failed to read credentials file: {}", e))?;

        serde_json::from_str::<KeysFile>(&contents)
            .map_err(|e| format!("Failed to parse credentials file: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let mut results = Vec::new();

    for (_, cred) in creds_file.credentials {
        let api_key = cred.api_key.clone().unwrap_or_default();

        // Skip if no API key AND no session token (truly empty entries)
        let has_session = cred.session_token.as_ref().is_some_and(|t| !t.is_empty());
        if api_key.is_empty() && !has_session && cred.agent_type != "codex" {
            results.push(KeyValidationSummary {
                id: cred.id.clone(),
                name: cred.name.clone(),
                agent_type: cred.agent_type.clone(),
                format_valid: false,
                format_message: "No API key".to_string(),
                api_valid: None,
                api_message: None,
                models_count: None,
            });
            continue;
        }

        // Format validation
        let (format_valid, format_message) =
            match validate_token_format(cred.agent_type.clone(), api_key.clone()) {
                Ok((v, m)) => (v, m),
                Err(e) => (false, e),
            };

        // API validation (only if format is valid)
        let (api_valid, api_message, models_count) = if format_valid {
            match run_validate_key(
                cred.agent_type.clone(),
                api_key,
                cred.base_url.clone(),
                cred.session_token.clone(),
                None, // No test_model for batch validation
                None,
            )
            .await
            {
                Ok(result) => (
                    Some(result.valid),
                    Some(result.message),
                    Some(result.models_available.len()),
                ),
                Err(e) => (Some(false), Some(e), None),
            }
        } else {
            (None, None, None)
        };

        results.push(KeyValidationSummary {
            id: cred.id,
            name: cred.name,
            agent_type: cred.agent_type,
            format_valid,
            format_message,
            api_valid,
            api_message,
            models_count,
        });
    }

    Ok(results)
}
