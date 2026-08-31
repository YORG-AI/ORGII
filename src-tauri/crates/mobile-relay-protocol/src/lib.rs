//! Shared, transport-only wire types for the ORGII Mobile Remote relay.
//!
//! This crate intentionally contains no networking, persistence, Tauri, or
//! agent-domain logic. The public relay and the desktop outbound client use
//! the same serialized shapes so the broker can stay payload-opaque.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const RELAY_PROTOCOL_VERSION: u32 = 1;
pub const DESKTOP_WS_PATH: &str = "/v1/desktop/ws";
pub const MOBILE_WS_PATH: &str = "/v1/mobile/ws";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionTier {
    ReadOnly,
    Full,
}

impl PermissionTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::Full => "full",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInitRequest {
    pub desktop_id: String,
    pub label: String,
    pub tier: PermissionTier,
    #[serde(default)]
    pub is_primary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInitResponse {
    pub pairing_code: String,
    pub confirmation_phrase: String,
    pub qr_payload: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCompleteRequest {
    pub pairing_code: String,
    pub tier: PermissionTier,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeDeviceRequest {
    pub device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPrimaryDesktopRequest {
    pub desktop_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceInfo {
    pub device_id: String,
    pub desktop_id: String,
    pub label: String,
    pub tier: PermissionTier,
    pub is_primary: bool,
    pub paired_at_ms: i64,
    pub last_seen_ms: Option<i64>,
}

/// Frames used only between the relay and the desktop outbound connection.
/// `payload` remains the existing OrgiiMobile JSON-RPC envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RelayWireFrame {
    DesktopRegistered {
        desktop_id: String,
        protocol_version: u32,
    },
    MobileConnected {
        connection_id: String,
        device: PairedDeviceInfo,
    },
    MobileDisconnected {
        connection_id: String,
    },
    MobileFrame {
        connection_id: String,
        payload: Value,
    },
    DesktopFrame {
        connection_id: String,
        payload: Value,
    },
    Error {
        code: String,
        message: String,
    },
}

pub fn presence_notification(desktop_id: &str, online: bool) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "relay/presence",
        "params": {
            "desktopId": desktop_id,
            "online": online,
        }
    })
}

pub fn pairing_notification(method: &str, pairing_code: &str) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": { "pairingCode": pairing_code }
    })
}

pub fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_frame_round_trips_without_changing_payload() {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/send",
            "params": { "content": "hello" }
        });
        let frame = RelayWireFrame::MobileFrame {
            connection_id: "mobile-1".to_string(),
            payload: payload.clone(),
        };
        let encoded = serde_json::to_string(&frame).expect("serialize frame");
        let decoded: RelayWireFrame = serde_json::from_str(&encoded).expect("parse frame");
        assert_eq!(decoded, frame);
        assert_eq!(
            serde_json::to_value(decoded)
                .expect("value")
                .pointer("/payload/params/content"),
            Some(&Value::String("hello".to_string()))
        );
    }

    #[test]
    fn permission_tier_wire_values_are_stable() {
        assert_eq!(
            serde_json::to_string(&PermissionTier::ReadOnly).expect("tier"),
            "\"read_only\""
        );
        assert_eq!(PermissionTier::Full.as_str(), "full");
    }
}
