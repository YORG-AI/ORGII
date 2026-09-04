use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::ws::{CloseFrame, Message};
use mobile_relay_protocol::{PairedDeviceInfo, PermissionTier, RelayWireFrame};
use serde_json::Value;
use tokio::sync::{mpsc, watch, Mutex};
use uuid::Uuid;

use crate::config::RelayConfig;
use crate::store::{hash_token, DeviceStore};

pub const MAX_PENDING_PAIRINGS: usize = 128;
pub const MAX_DESKTOP_CONNECTIONS: usize = 32;
pub const MAX_MOBILE_CONNECTIONS: usize = 256;
pub const OUTBOUND_QUEUE_CAPACITY: usize = 64;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone)]
pub enum SocketCommand {
    Json(Value),
    Relay(RelayWireFrame),
    Pong(Vec<u8>),
    Close { code: u16, reason: String },
}

impl SocketCommand {
    pub fn into_message(self) -> Result<Message, serde_json::Error> {
        match self {
            Self::Json(value) => serde_json::to_string(&value).map(Message::text),
            Self::Relay(frame) => serde_json::to_string(&frame).map(Message::text),
            Self::Pong(payload) => Ok(Message::Pong(payload.into())),
            Self::Close { code, reason } => Ok(Message::Close(Some(CloseFrame {
                code,
                reason: reason.into(),
            }))),
        }
    }
}

#[derive(Debug, Clone)]
pub enum PairingOutcome {
    Pending,
    Approved(PairedDeviceInfo),
}

#[derive(Debug)]
pub struct PendingPairing {
    pub pairing_code: String,
    pub confirmation_phrase: String,
    pub desktop_id: String,
    pub label: String,
    pub requested_tier: PermissionTier,
    pub is_primary: bool,
    pub device_id: String,
    pub device_token: String,
    pub expires_at_ms: i64,
    pub outcome_tx: watch::Sender<PairingOutcome>,
}

impl PendingPairing {
    pub fn token_matches(&self, candidate: &str) -> bool {
        constant_time_eq(
            hash_token(&self.device_token).as_bytes(),
            hash_token(candidate).as_bytes(),
        )
    }
}

#[derive(Debug, Clone)]
pub struct PendingMobileAuth {
    pub pairing_code: String,
    pub desktop_id: String,
    pub expires_at_ms: i64,
    pub outcome_rx: watch::Receiver<PairingOutcome>,
}

#[derive(Debug, Clone)]
pub enum MobileAuth {
    Active(PairedDeviceInfo),
    Pending(PendingMobileAuth),
}

#[derive(Debug, Clone)]
pub struct DesktopPeer {
    pub connection_id: String,
    pub tx: mpsc::Sender<SocketCommand>,
}

#[derive(Debug, Clone)]
pub struct MobilePeer {
    pub connection_id: String,
    pub device: PairedDeviceInfo,
    pub tx: mpsc::Sender<SocketCommand>,
}

#[derive(Debug)]
struct RelayStateInner {
    pending: Mutex<HashMap<String, Arc<PendingPairing>>>,
    desktops: Mutex<HashMap<String, DesktopPeer>>,
    mobiles: Mutex<HashMap<String, MobilePeer>>,
}

#[derive(Debug, Clone)]
pub struct RelayState {
    pub config: Arc<RelayConfig>,
    pub store: DeviceStore,
    inner: Arc<RelayStateInner>,
}

impl RelayState {
    pub fn new(config: RelayConfig, store: DeviceStore) -> Self {
        Self {
            config: Arc::new(config),
            store,
            inner: Arc::new(RelayStateInner {
                pending: Mutex::new(HashMap::new()),
                desktops: Mutex::new(HashMap::new()),
                mobiles: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn create_pairing(
        &self,
        desktop_id: String,
        label: String,
        tier: PermissionTier,
        is_primary: bool,
    ) -> Result<Arc<PendingPairing>, String> {
        let now = now_ms();
        let mut pending = self.inner.pending.lock().await;
        pending.retain(|_, item| item.expires_at_ms > now);
        if pending.len() >= MAX_PENDING_PAIRINGS {
            return Err("too many pending pairings".to_string());
        }

        let pairing_code = loop {
            let candidate = short_code();
            if !pending.contains_key(&candidate) {
                break candidate;
            }
        };
        let device_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let (outcome_tx, _) = watch::channel(PairingOutcome::Pending);
        let item = Arc::new(PendingPairing {
            pairing_code: pairing_code.clone(),
            confirmation_phrase: confirmation_phrase(&pairing_code),
            desktop_id,
            label,
            requested_tier: tier,
            is_primary,
            device_id: Uuid::new_v4().to_string(),
            device_token,
            expires_at_ms: now
                .saturating_add((self.config.pairing_ttl_seconds as i64).saturating_mul(1_000)),
            outcome_tx,
        });
        pending.insert(pairing_code, item.clone());
        Ok(item)
    }

    pub async fn pending_pairing(&self, pairing_code: &str) -> Option<Arc<PendingPairing>> {
        let now = now_ms();
        let mut pending = self.inner.pending.lock().await;
        pending.retain(|_, item| item.expires_at_ms > now);
        pending.get(pairing_code).cloned()
    }

    pub async fn complete_pairing(
        &self,
        pairing_code: &str,
        tier: PermissionTier,
    ) -> Result<PairedDeviceInfo, String> {
        let item = self
            .pending_pairing(pairing_code)
            .await
            .ok_or_else(|| "pairing code is invalid or expired".to_string())?;
        let device = PairedDeviceInfo {
            device_id: item.device_id.clone(),
            desktop_id: item.desktop_id.clone(),
            label: item.label.clone(),
            tier,
            is_primary: item.is_primary,
            paired_at_ms: now_ms(),
            last_seen_ms: None,
        };
        self.store
            .activate_device(device.clone(), item.device_token.clone())
            .await?;
        item.outcome_tx
            .send_replace(PairingOutcome::Approved(device.clone()));
        self.inner.pending.lock().await.remove(pairing_code);
        Ok(device)
    }

    pub async fn authenticate_mobile(
        &self,
        token: String,
        pairing_code: Option<String>,
    ) -> Result<MobileAuth, String> {
        if let Some(device) = self.store.find_active_by_token(token.clone()).await? {
            return Ok(MobileAuth::Active(device));
        }
        let Some(pairing_code) = pairing_code else {
            return Err("invalid or revoked device token".to_string());
        };
        let pending = self
            .pending_pairing(&pairing_code)
            .await
            .filter(|item| item.token_matches(&token))
            .ok_or_else(|| "invalid or expired pairing".to_string())?;
        Ok(MobileAuth::Pending(PendingMobileAuth {
            pairing_code,
            desktop_id: pending.desktop_id.clone(),
            expires_at_ms: pending.expires_at_ms,
            outcome_rx: pending.outcome_tx.subscribe(),
        }))
    }

    pub async fn register_desktop(
        &self,
        desktop_id: String,
        connection_id: String,
        tx: mpsc::Sender<SocketCommand>,
    ) -> Result<Option<DesktopPeer>, String> {
        let mut desktops = self.inner.desktops.lock().await;
        if !desktops.contains_key(&desktop_id) && desktops.len() >= MAX_DESKTOP_CONNECTIONS {
            return Err("desktop connection limit reached".to_string());
        }
        Ok(desktops.insert(desktop_id, DesktopPeer { connection_id, tx }))
    }

    pub async fn remove_desktop_if_current(&self, desktop_id: &str, connection_id: &str) -> bool {
        let mut desktops = self.inner.desktops.lock().await;
        if desktops
            .get(desktop_id)
            .is_some_and(|peer| peer.connection_id == connection_id)
        {
            desktops.remove(desktop_id);
            true
        } else {
            false
        }
    }

    pub async fn desktop_peer(&self, desktop_id: &str) -> Option<DesktopPeer> {
        self.inner.desktops.lock().await.get(desktop_id).cloned()
    }

    pub async fn register_mobile(&self, peer: MobilePeer) -> Result<(), String> {
        let mut mobiles = self.inner.mobiles.lock().await;
        if mobiles.len() >= MAX_MOBILE_CONNECTIONS {
            return Err("mobile connection limit reached".to_string());
        }
        mobiles.insert(peer.connection_id.clone(), peer);
        Ok(())
    }

    pub async fn remove_mobile_if_current(&self, connection_id: &str) -> Option<MobilePeer> {
        self.inner.mobiles.lock().await.remove(connection_id)
    }

    pub async fn mobile_peer(&self, connection_id: &str) -> Option<MobilePeer> {
        self.inner.mobiles.lock().await.get(connection_id).cloned()
    }

    pub async fn mobiles_for_desktop(&self, desktop_id: &str) -> Vec<MobilePeer> {
        self.inner
            .mobiles
            .lock()
            .await
            .values()
            .filter(|peer| peer.device.desktop_id == desktop_id)
            .cloned()
            .collect()
    }

    pub async fn disconnect_device(&self, device_id: &str, reason: &str) {
        let peers = self
            .inner
            .mobiles
            .lock()
            .await
            .values()
            .filter(|peer| peer.device.device_id == device_id)
            .cloned()
            .collect::<Vec<_>>();
        for peer in peers {
            let _ = peer
                .tx
                .send(SocketCommand::Close {
                    code: 1008,
                    reason: reason.to_string(),
                })
                .await;
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn short_code() -> String {
    Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>()
        .to_ascii_uppercase()
}

fn confirmation_phrase(code: &str) -> String {
    const WORDS: [&str; 16] = [
        "amber", "birch", "coral", "delta", "ember", "frost", "grove", "harbor", "iris", "jade",
        "kite", "lunar", "maple", "nova", "ocean", "pine",
    ];
    let bytes = code.as_bytes();
    let a = bytes.first().copied().unwrap_or_default() as usize % WORDS.len();
    let b = bytes.get(3).copied().unwrap_or_default() as usize % WORDS.len();
    let c = bytes.get(6).copied().unwrap_or_default() as usize % WORDS.len();
    format!("{}-{}-{}", WORDS[a], WORDS[b], WORDS[c])
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RelayConfig;

    #[test]
    fn confirmation_phrase_is_stable_for_a_code() {
        assert_eq!(
            confirmation_phrase("ABCDEF12"),
            confirmation_phrase("ABCDEF12")
        );
        assert_eq!(confirmation_phrase("ABCDEF12").split('-').count(), 3);
    }

    #[test]
    fn constant_time_comparison_rejects_wrong_values() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    #[tokio::test]
    async fn device_token_activates_only_after_confirmation_and_revoke_closes_access() {
        let directory = tempfile::tempdir().expect("temp dir");
        let config = RelayConfig {
            listen_addr: "127.0.0.1:0".parse().expect("listen address"),
            database_path: directory.path().join("relay.sqlite3"),
            desktop_token: Some("123456789012345678901234".to_string()),
            desktop_token_fallback: true,
            supabase_url: "https://project.supabase.co".to_string(),
            supabase_anon_key: "anon".to_string(),
            public_ws_url: "ws://127.0.0.1:8787/v1/mobile/ws".to_string(),
            public_app_url: "http://127.0.0.1:8787/orgii/mobile".to_string(),
            pairing_ttl_seconds: 120,
        };
        let store = DeviceStore::open(&config.database_path).expect("store");
        let state = RelayState::new(config, store);
        let pairing = state
            .create_pairing(
                "desktop-a".to_string(),
                "Phone".to_string(),
                PermissionTier::ReadOnly,
                true,
            )
            .await
            .expect("pairing");

        assert!(state
            .store
            .find_active_by_token(pairing.device_token.clone())
            .await
            .expect("pre-confirm lookup")
            .is_none());
        assert!(state
            .authenticate_mobile(
                "wrong-token".to_string(),
                Some(pairing.pairing_code.clone())
            )
            .await
            .is_err());
        assert!(matches!(
            state
                .authenticate_mobile(
                    pairing.device_token.clone(),
                    Some(pairing.pairing_code.clone())
                )
                .await
                .expect("pending auth"),
            MobileAuth::Pending(_)
        ));

        let device = state
            .complete_pairing(&pairing.pairing_code, PermissionTier::Full)
            .await
            .expect("complete pairing");
        assert!(matches!(
            state
                .authenticate_mobile(pairing.device_token.clone(), None)
                .await
                .expect("active auth"),
            MobileAuth::Active(ref active) if active.tier == PermissionTier::Full
        ));

        assert!(state
            .store
            .revoke(device.device_id, now_ms())
            .await
            .expect("revoke"));
        assert!(state
            .authenticate_mobile(pairing.device_token.clone(), None)
            .await
            .is_err());
    }
}
