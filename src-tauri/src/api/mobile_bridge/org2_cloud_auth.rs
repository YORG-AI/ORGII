//! Read ORG2 Cloud session credentials from the shared Tauri auth store.
//!
//! The frontend persists `orgii:org2-cloud-v1:auth` in
//! `shared-service-auth.json` (see `sharedAuthStorage.ts`). Relay and pairing
//! commands consume the access token from here instead of `mobileRemote.desktopToken`.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

pub const ORG2_CLOUD_AUTH_STORAGE_KEY: &str = "orgii:org2-cloud-v1:auth";
const SHARED_AUTH_STORE_FILENAME: &str = "shared-service-auth.json";
const APP_IDENTIFIER: &str = "org2ai.org2";
const REFRESH_SKEW_SECONDS: f64 = 60.0;

pub const NOT_SIGNED_IN_MESSAGE: &str = "Sign in to ORG2 Cloud to use outdoor relay";
pub const SESSION_EXPIRED_MESSAGE: &str = "ORG2 Cloud session expired; refreshing credentials";

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Org2CloudAuthSnapshot {
    pub kind: String,
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    pub expires_at: f64,
}

pub fn shared_auth_store_path() -> PathBuf {
    if let Ok(path) = std::env::var("ORGII_TEST_SHARED_AUTH_STORE") {
        return PathBuf::from(path);
    }
    // Must match `@tauri-apps/plugin-store` LazyStore: files live directly in
    // `app_data_dir`, not a `stores/` subdirectory.
    dirs::data_dir()
        .unwrap_or_else(app_paths::home_dir)
        .join(APP_IDENTIFIER)
        .join(SHARED_AUTH_STORE_FILENAME)
}

pub fn load_snapshot() -> Option<Org2CloudAuthSnapshot> {
    let path = shared_auth_store_path();
    let raw = std::fs::read_to_string(path).ok()?;
    let store: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let auth_raw = store.get(ORG2_CLOUD_AUTH_STORAGE_KEY)?.as_str()?;
    parse_snapshot(auth_raw)
}

pub fn parse_snapshot(raw: &str) -> Option<Org2CloudAuthSnapshot> {
    let snapshot: Org2CloudAuthSnapshot = serde_json::from_str(raw).ok()?;
    if snapshot.kind != "org2_cloud" || snapshot.access_token.trim().is_empty() {
        return None;
    }
    Some(snapshot)
}

pub fn current_access_token() -> Result<String, String> {
    let snapshot = load_snapshot().ok_or_else(|| NOT_SIGNED_IN_MESSAGE.to_string())?;
    validate_access_token(&snapshot)
}

pub fn validate_access_token(snapshot: &Org2CloudAuthSnapshot) -> Result<String, String> {
    let token = snapshot.access_token.trim();
    if token.is_empty() {
        return Err(NOT_SIGNED_IN_MESSAGE.to_string());
    }
    if is_expired(snapshot.expires_at) {
        return Err(SESSION_EXPIRED_MESSAGE.to_string());
    }
    Ok(token.to_string())
}

pub fn is_expired(expires_at: f64) -> bool {
    if !expires_at.is_finite() || expires_at <= 0.0 {
        return false;
    }
    now_epoch_seconds() + REFRESH_SKEW_SECONDS >= expires_at
}

fn now_epoch_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs_f64())
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    const VALID_AUTH: &str = r#"{
        "kind":"org2_cloud",
        "supabaseUrl":"https://example.supabase.co",
        "supabaseAnonKey":"anon",
        "userId":"user-1",
        "accessToken":"cloud-access-token",
        "refreshToken":"refresh",
        "expiresAt":4102444800
    }"#;

    fn write_store(dir: &TempDir, auth: Option<&str>) {
        let store = match auth {
            Some(raw) => serde_json::json!({
                ORG2_CLOUD_AUTH_STORAGE_KEY: raw,
            }),
            None => serde_json::json!({}),
        };
        fs::write(
            dir.path().join("shared-service-auth.json"),
            store.to_string(),
        )
        .expect("write store");
    }

    #[test]
    fn shared_auth_store_path_matches_tauri_plugin_store_layout() {
        let path = shared_auth_store_path();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some(SHARED_AUTH_STORE_FILENAME)
        );
        assert_ne!(
            path.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|name| name.to_str()),
            Some("stores")
        );
    }

    #[test]
    fn parse_snapshot_accepts_valid_org2_cloud_auth() {
        let snapshot = parse_snapshot(VALID_AUTH).expect("snapshot");
        assert_eq!(snapshot.access_token, "cloud-access-token");
        assert!(!is_expired(snapshot.expires_at));
    }

    #[test]
    fn parse_snapshot_rejects_missing_or_invalid_kind() {
        assert!(parse_snapshot(r#"{"kind":"other"}"#).is_none());
        assert!(parse_snapshot(r#"{"kind":"org2_cloud","accessToken":""}"#).is_none());
    }

    #[test]
    fn load_snapshot_reads_shared_store_file() {
        let dir = TempDir::new().expect("tempdir");
        write_store(&dir, Some(VALID_AUTH));
        std::env::set_var(
            "ORGII_TEST_SHARED_AUTH_STORE",
            dir.path().join("shared-service-auth.json"),
        );
        let snapshot = load_snapshot().expect("load");
        assert_eq!(
            validate_access_token(&snapshot).expect("token"),
            "cloud-access-token"
        );
        std::env::remove_var("ORGII_TEST_SHARED_AUTH_STORE");
    }

    #[test]
    fn current_access_token_reports_signed_out_when_store_is_empty() {
        let dir = TempDir::new().expect("tempdir");
        write_store(&dir, None);
        std::env::set_var(
            "ORGII_TEST_SHARED_AUTH_STORE",
            dir.path().join("shared-service-auth.json"),
        );
        assert_eq!(
            current_access_token(),
            Err(NOT_SIGNED_IN_MESSAGE.to_string())
        );
        std::env::remove_var("ORGII_TEST_SHARED_AUTH_STORE");
    }

    #[test]
    fn validate_access_token_detects_expiry_with_skew() {
        let snapshot = Org2CloudAuthSnapshot {
            kind: "org2_cloud".to_string(),
            access_token: "token".to_string(),
            refresh_token: "refresh".to_string(),
            expires_at: now_epoch_seconds() + 30.0,
        };
        assert_eq!(
            validate_access_token(&snapshot),
            Err(SESSION_EXPIRED_MESSAGE.to_string())
        );
    }
}
