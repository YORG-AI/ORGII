//! Tauri commands for configuring and administering the outdoor relay.

use std::collections::HashSet;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use mobile_relay_protocol::{
    PairedDeviceInfo, PairingCompleteRequest, PairingInitRequest, PairingInitResponse,
    PermissionTier, RevokeDeviceRequest, SetPrimaryDesktopRequest,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::org2_cloud_auth::{self, SESSION_EXPIRED_MESSAGE};
use super::relay::{self, RelaySettings, RelayStatus};

const MAX_MOBILE_SIDEBAR_SESSIONS: usize = 200;
const MAX_MOBILE_SIDEBAR_SESSION_ID_BYTES: usize = 256;
const MAX_MOBILE_SIDEBAR_SESSION_NAME_BYTES: usize = 1_024;

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSidebarSessionSnapshotRow {
    pub id: String,
    pub name: String,
    pub status: String,
}

static MOBILE_SIDEBAR_SESSION_SNAPSHOT: OnceLock<
    RwLock<Option<Vec<MobileSidebarSessionSnapshotRow>>>,
> = OnceLock::new();

fn mobile_sidebar_session_snapshot() -> &'static RwLock<Option<Vec<MobileSidebarSessionSnapshotRow>>>
{
    MOBILE_SIDEBAR_SESSION_SNAPSHOT.get_or_init(|| RwLock::new(None))
}

fn validate_mobile_sidebar_sessions(
    sessions: &[MobileSidebarSessionSnapshotRow],
) -> Result<(), String> {
    if sessions.len() > MAX_MOBILE_SIDEBAR_SESSIONS {
        return Err(format!(
            "mobile sidebar snapshot cannot exceed {MAX_MOBILE_SIDEBAR_SESSIONS} sessions"
        ));
    }

    let mut seen_ids = HashSet::with_capacity(sessions.len());
    for session in sessions {
        if session.id.trim().is_empty() {
            return Err("mobile sidebar session id cannot be empty".to_string());
        }
        if session.id.len() > MAX_MOBILE_SIDEBAR_SESSION_ID_BYTES {
            return Err("mobile sidebar session id is too long".to_string());
        }
        if session.name.trim().is_empty() {
            return Err("mobile sidebar session name cannot be empty".to_string());
        }
        if session.name.len() > MAX_MOBILE_SIDEBAR_SESSION_NAME_BYTES {
            return Err("mobile sidebar session name is too long".to_string());
        }
        if !matches!(session.status.as_str(), "running" | "idle") {
            return Err(format!(
                "mobile sidebar session status must be running or idle: {}",
                session.status
            ));
        }
        if !seen_ids.insert(session.id.as_str()) {
            return Err(format!(
                "mobile sidebar snapshot contains duplicate session id: {}",
                session.id
            ));
        }
    }

    Ok(())
}

pub(crate) fn current_mobile_sidebar_sessions(
) -> Result<Option<Vec<MobileSidebarSessionSnapshotRow>>, String> {
    mobile_sidebar_session_snapshot()
        .read()
        .map(|snapshot| snapshot.clone())
        .map_err(|_| "mobile sidebar snapshot lock poisoned".to_string())
}

/// Publish the exact, ordered rows currently rendered in the desktop
/// Sidebar's local/My Sessions section. Mobile reads this app-lifetime
/// projection instead of independently reconstructing org/filter/pagination
/// policy from the database.
#[tauri::command(rename_all = "camelCase")]
pub fn mobile_remote_sync_sidebar_sessions(
    sessions: Vec<MobileSidebarSessionSnapshotRow>,
) -> Result<bool, String> {
    validate_mobile_sidebar_sessions(&sessions)?;

    let changed = {
        let mut snapshot = mobile_sidebar_session_snapshot()
            .write()
            .map_err(|_| "mobile sidebar snapshot lock poisoned".to_string())?;
        if snapshot.as_ref() == Some(&sessions) {
            false
        } else {
            *snapshot = Some(sessions);
            true
        }
    };

    if changed {
        super::fanout::fanout_all(
            &serde_json::json!({
                "jsonrpc": "2.0",
                "method": "session/list_changed",
            })
            .to_string(),
        );
    }

    Ok(changed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayUrlInfo {
    pub url: String,
    pub is_default: bool,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mobile_remote_pair_init(
    tier: PermissionTier,
    label: String,
    is_primary: bool,
) -> Result<PairingInitResponse, String> {
    let config = ensure_desktop_identity().await?;
    relay_json(
        &config,
        reqwest::Method::POST,
        "/v1/pairings",
        Some(&PairingInitRequest {
            desktop_id: config.desktop_id.clone(),
            label,
            tier,
            is_primary,
        }),
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mobile_remote_pair_complete(
    pairing_code: String,
    tier: PermissionTier,
) -> Result<(), String> {
    let config = RelaySettings::load();
    let _: PairedDeviceInfo = relay_json(
        &config,
        reqwest::Method::POST,
        "/v1/pairings/complete",
        Some(&PairingCompleteRequest { pairing_code, tier }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn mobile_remote_list_devices() -> Result<Vec<PairedDeviceInfo>, String> {
    mobile_remote_sync_devices().await
}

#[tauri::command]
pub async fn mobile_remote_sync_devices() -> Result<Vec<PairedDeviceInfo>, String> {
    let config = RelaySettings::load();
    let query = format!(
        "/v1/devices?desktopId={}",
        url::form_urlencoded::byte_serialize(config.desktop_id.as_bytes()).collect::<String>()
    );
    relay_json::<(), Vec<PairedDeviceInfo>>(&config, reqwest::Method::GET, &query, None).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mobile_remote_revoke_device(device_id: String) -> Result<(), String> {
    let config = RelaySettings::load();
    let _: Value = relay_json(
        &config,
        reqwest::Method::POST,
        "/v1/devices/revoke",
        Some(&RevokeDeviceRequest { device_id }),
    )
    .await?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mobile_remote_set_primary_desktop(desktop_id: String) -> Result<(), String> {
    let config = RelaySettings::load();
    let _: Value = relay_json(
        &config,
        reqwest::Method::POST,
        "/v1/desktops/primary",
        Some(&SetPrimaryDesktopRequest { desktop_id }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn mobile_remote_set_relay_url(url: String) -> Result<(), String> {
    update_setting("mobileRemote.relayUrl", Value::String(url)).await
}

#[tauri::command]
pub async fn mobile_remote_get_relay_url() -> Result<RelayUrlInfo, String> {
    let config = RelaySettings::load();
    Ok(RelayUrlInfo {
        is_default: config.relay_url.is_empty(),
        url: config.relay_url,
    })
}

#[tauri::command]
pub async fn mobile_remote_relay_status() -> Result<RelayStatus, String> {
    Ok(relay::current_status())
}

#[tauri::command]
pub async fn mobile_remote_notify_cloud_auth_changed() -> Result<(), String> {
    relay::notify_cloud_auth_changed();
    Ok(())
}

async fn ensure_desktop_identity() -> Result<RelaySettings, String> {
    let current = RelaySettings::load();
    if !current.desktop_id.is_empty() {
        return Ok(current);
    }
    update_setting(
        "mobileRemote.desktopId",
        Value::String(format!("desktop-{}", uuid::Uuid::new_v4())),
    )
    .await?;
    Ok(RelaySettings::load())
}

async fn update_setting(key: &'static str, value: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut current = settings::file_io::read_settings()?;
        let object = current
            .as_object_mut()
            .ok_or_else(|| "settings root must be an object".to_string())?;
        object.insert(key.to_string(), value);
        settings::file_io::write_settings_json(&current)
    })
    .await
    .map_err(|err| format!("update mobile remote setting: {err}"))?
}

async fn relay_json<B, R>(
    config: &RelaySettings,
    method: reqwest::Method,
    path: &str,
    body: Option<&B>,
) -> Result<R, String>
where
    B: Serialize + ?Sized,
    R: DeserializeOwned,
{
    let endpoint = relay_http_endpoint(config, path)?;
    let access_token = org2_cloud_auth::current_access_token()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|err| format!("create relay client: {err}"))?;
    let mut request = client.request(method, endpoint).bearer_auth(&access_token);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("relay request failed: {err}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("read relay response: {err}"))?;
    if status == reqwest::StatusCode::UNAUTHORIZED {
        relay::request_auth_refresh();
        return Err(SESSION_EXPIRED_MESSAGE.to_string());
    }
    if !status.is_success() {
        let message = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("relay returned HTTP {status}"));
        return Err(message);
    }
    serde_json::from_slice(&bytes).map_err(|err| format!("parse relay response: {err}"))
}

fn relay_http_endpoint(config: &RelaySettings, path: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(config.relay_url.trim())
        .map_err(|err| format!("invalid relay URL: {err}"))?;
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return Err("relay URL must use ws:// or wss://".to_string()),
    };
    url.set_scheme(scheme)
        .map_err(|_| "could not convert relay URL to HTTP".to_string())?;
    let (path_only, query) = path.split_once('?').unwrap_or((path, ""));
    url.set_path(path_only);
    url.set_query((!query.is_empty()).then_some(query));
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(url: &str) -> RelaySettings {
        RelaySettings {
            enabled: true,
            relay_enabled: true,
            relay_url: url.to_string(),
            desktop_id: "desktop-a".to_string(),
        }
    }

    #[test]
    fn websocket_url_converts_to_http_api_without_leaking_old_query() {
        let endpoint = relay_http_endpoint(
            &config("wss://relay.example.com/v1/mobile/ws?token=secret"),
            "/v1/devices?desktopId=desktop-a",
        )
        .expect("endpoint");
        assert_eq!(
            endpoint.as_str(),
            "https://relay.example.com/v1/devices?desktopId=desktop-a"
        );
    }

    #[test]
    fn relay_http_endpoint_rejects_plain_http_setting() {
        assert!(relay_http_endpoint(&config("https://relay.example.com"), "/healthz").is_err());
    }

    #[test]
    fn sidebar_snapshot_validation_accepts_ordered_unique_rows() {
        let rows = vec![
            MobileSidebarSessionSnapshotRow {
                id: "session-b".to_string(),
                name: "Second by storage, first in Sidebar".to_string(),
                status: "running".to_string(),
            },
            MobileSidebarSessionSnapshotRow {
                id: "session-a".to_string(),
                name: "Session A".to_string(),
                status: "idle".to_string(),
            },
        ];

        assert_eq!(validate_mobile_sidebar_sessions(&rows), Ok(()));
    }

    #[test]
    fn sidebar_snapshot_validation_rejects_duplicates_and_unknown_statuses() {
        let duplicate = MobileSidebarSessionSnapshotRow {
            id: "session-a".to_string(),
            name: "Session A".to_string(),
            status: "idle".to_string(),
        };
        assert!(validate_mobile_sidebar_sessions(&[duplicate.clone(), duplicate]).is_err());

        assert!(
            validate_mobile_sidebar_sessions(&[MobileSidebarSessionSnapshotRow {
                id: "session-b".to_string(),
                name: "Session B".to_string(),
                status: "offline".to_string(),
            }])
            .is_err()
        );
    }
}
