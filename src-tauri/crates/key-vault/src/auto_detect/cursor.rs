use super::helpers::create_detected_key;
use super::{DetectedKey, QuotaInfo};

/// Detect Cursor session keys from local state database
///
/// Reads from: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
/// Table: ItemTable
/// Keys: cursorAuth/accessToken
pub(super) async fn detect_cursor_keys() -> Vec<DetectedKey> {
    let mut keys = vec![];

    // Get the Cursor state database path
    let Some(db_path) = get_cursor_state_db_path() else {
        return keys;
    };

    // Read tokens from the database
    match read_cursor_tokens_from_db(&db_path) {
        Ok(Some(CursorDbTokens {
            session_token,
            email,
        })) => {
            let mut cred = create_detected_key("cursor_local", "Cursor (Local)", "oauth");
            cred.session_token = Some(session_token.clone());

            // Try to fetch quota using the session token
            let quota_result = fetch_cursor_quota(&session_token).await;
            match quota_result {
                Ok(quota) => {
                    cred.validated = Some(true);
                    cred.validation_message = Some(format!(
                        "Valid session for {}",
                        email.unwrap_or_else(|| "user".to_string())
                    ));
                    cred.quota_info = Some(QuotaInfo {
                        remaining_percentage: Some(quota.remaining_percentage),
                        used: quota.used,
                        limit: quota.limit,
                        remaining: quota.remaining,
                        reset_time: quota.reset_time.clone(),
                        plan_type: quota.plan_type.clone(),
                        quota_source: quota.quota_source.clone(),
                        is_unlimited: Some(quota.is_unlimited),
                        usage_items: quota.usage_items.clone(),
                        auto_message: quota.auto_message.clone(),
                        named_message: quota.named_message.clone(),
                    });
                }
                Err(msg) => {
                    // Token found but validation failed (might be expired)
                    cred.validated = Some(false);
                    cred.validation_message = Some(msg);
                }
            }

            keys.push(cred);
        }
        Ok(None) => {
            // No tokens found
        }
        Err(e) => {
            eprintln!("Failed to read Cursor tokens: {}", e);
        }
    }

    keys
}

struct CursorDbTokens {
    /// Either the bare JWT or `{userId}%3A%3A{jwt}` (when the JWT's `sub`
    /// claim could be decoded). Stored as the `session_token` on the
    /// detected key.
    session_token: String,
    /// Cached email from `cursorAuth/cachedEmail`, used only for the
    /// validation message.
    email: Option<String>,
}

/// Get the path to Cursor's state database
fn get_cursor_state_db_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir()?;
        let path = home.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb");
        if path.exists() {
            return Some(path);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let home = dirs::home_dir()?;
        let path = home.join("AppData/Roaming/Cursor/User/globalStorage/state.vscdb");
        if path.exists() {
            return Some(path);
        }
    }

    #[cfg(target_os = "linux")]
    {
        let home = dirs::home_dir()?;
        let path = home.join(".config/Cursor/User/globalStorage/state.vscdb");
        if path.exists() {
            return Some(path);
        }
    }

    None
}

/// Read Cursor tokens from the SQLite state database.
///
/// `session_token` is returned in the format `{userId}%3A%3A{jwtToken}`
/// when the JWT's `sub` claim can be decoded, otherwise as the bare JWT.
fn read_cursor_tokens_from_db(db_path: &std::path::Path) -> Result<Option<CursorDbTokens>, String> {
    use rusqlite::Connection;

    let conn =
        Connection::open(db_path).map_err(|e| format!("Failed to open Cursor database: {}", e))?;

    // Read access token (JWT)
    let access_token: Option<String> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
            [],
            |row| row.get(0),
        )
        .ok();

    let Some(jwt_token) = access_token else {
        return Ok(None);
    };

    if jwt_token.is_empty() {
        return Ok(None);
    }

    // Read cached email (optional)
    let email: Option<String> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'cursorAuth/cachedEmail'",
            [],
            |row| row.get(0),
        )
        .ok();

    // Extract user ID from JWT's `sub` claim and construct full session token
    // Format: {userId}%3A%3A{jwtToken}
    let session_token = match extract_user_id_from_jwt(&jwt_token) {
        Some(user_id) => {
            // URL-encode the separator (:: becomes %3A%3A)
            format!("{}%3A%3A{}", user_id, jwt_token)
        }
        None => {
            // Fallback: return just the JWT token if we can't extract user ID
            jwt_token
        }
    };

    Ok(Some(CursorDbTokens {
        session_token,
        email,
    }))
}

/// Extract user ID from JWT token's `sub` claim
///
/// JWT format: header.payload.signature (all base64url encoded)
/// Payload contains: { "sub": "auth0|user_xxx", ... }
fn extract_user_id_from_jwt(jwt_token: &str) -> Option<String> {
    // Split JWT into parts
    let parts: Vec<&str> = jwt_token.split('.').collect();
    if parts.len() < 2 {
        return None;
    }

    // Decode the payload (second part)
    let payload_b64 = parts[1];

    // Base64url decode (add padding if needed)
    let mut payload_padded = payload_b64.to_string();
    let padding_needed = (4 - payload_padded.len() % 4) % 4;
    payload_padded.push_str(&"=".repeat(padding_needed));

    // Replace base64url chars with standard base64
    let payload_standard = payload_padded.replace('-', "+").replace('_', "/");

    // Decode base64
    use base64::{engine::general_purpose::STANDARD, Engine};
    let payload_bytes = STANDARD.decode(&payload_standard).ok()?;
    let payload_str = String::from_utf8(payload_bytes).ok()?;

    // Parse JSON and extract "sub" field
    let payload: serde_json::Value = serde_json::from_str(&payload_str).ok()?;
    let sub = payload.get("sub")?.as_str()?;

    Some(sub.to_string())
}

/// Fetch Cursor quota using the session token
async fn fetch_cursor_quota(session_token: &str) -> Result<crate::types::QuotaInfo, String> {
    use crate::providers::cursor::CursorValidator;

    let validator = CursorValidator::new();
    validator.fetch_quota(session_token).await
}
