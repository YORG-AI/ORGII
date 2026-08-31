use std::path::{Path, PathBuf};
use std::sync::Arc;

use mobile_relay_protocol::{PairedDeviceInfo, PermissionTier};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct DeviceStore {
    path: Arc<PathBuf>,
}

impl DeviceStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("create relay database directory: {err}"))?;
        }
        let store = Self {
            path: Arc::new(path),
        };
        store.with_connection(|conn| {
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS paired_devices (
                   device_id TEXT PRIMARY KEY,
                   desktop_id TEXT NOT NULL,
                   token_hash TEXT NOT NULL UNIQUE,
                   label TEXT NOT NULL,
                   tier TEXT NOT NULL CHECK (tier IN ('read_only', 'full')),
                   is_primary INTEGER NOT NULL DEFAULT 0,
                   paired_at_ms INTEGER NOT NULL,
                   last_seen_ms INTEGER,
                   revoked_at_ms INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS idx_paired_devices_desktop
                   ON paired_devices(desktop_id, revoked_at_ms);",
            )?;
            Ok(())
        })?;
        Ok(store)
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        let conn = Connection::open(self.path.as_ref())
            .map_err(|err| format!("open relay database: {err}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(|err| format!("configure relay database: {err}"))?;
        operation(&conn).map_err(|err| format!("relay database operation: {err}"))
    }

    pub async fn activate_device(
        &self,
        device: PairedDeviceInfo,
        raw_token: String,
    ) -> Result<(), String> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let token_hash = hash_token(&raw_token);
            store.with_connection(|conn| {
                let tx = conn.unchecked_transaction()?;
                if device.is_primary {
                    tx.execute("UPDATE paired_devices SET is_primary = 0", [])?;
                }
                tx.execute(
                    "INSERT INTO paired_devices
                       (device_id, desktop_id, token_hash, label, tier, is_primary,
                        paired_at_ms, last_seen_ms, revoked_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)
                     ON CONFLICT(device_id) DO UPDATE SET
                       desktop_id = excluded.desktop_id,
                       token_hash = excluded.token_hash,
                       label = excluded.label,
                       tier = excluded.tier,
                       is_primary = excluded.is_primary,
                       paired_at_ms = excluded.paired_at_ms,
                       revoked_at_ms = NULL",
                    params![
                        device.device_id,
                        device.desktop_id,
                        token_hash,
                        device.label,
                        device.tier.as_str(),
                        device.is_primary as i64,
                        device.paired_at_ms,
                        device.last_seen_ms,
                    ],
                )?;
                tx.commit()
            })
        })
        .await
        .map_err(|err| format!("activate device task: {err}"))?
    }

    pub async fn find_active_by_token(
        &self,
        raw_token: String,
    ) -> Result<Option<PairedDeviceInfo>, String> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let token_hash = hash_token(&raw_token);
            store.with_connection(|conn| {
                conn.query_row(
                    "SELECT device_id, desktop_id, label, tier, is_primary,
                            paired_at_ms, last_seen_ms
                       FROM paired_devices
                      WHERE token_hash = ?1 AND revoked_at_ms IS NULL",
                    [token_hash],
                    row_to_device,
                )
                .optional()
            })
        })
        .await
        .map_err(|err| format!("find device task: {err}"))?
    }

    pub async fn list_active(&self, desktop_id: String) -> Result<Vec<PairedDeviceInfo>, String> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            store.with_connection(|conn| {
                let mut statement = conn.prepare(
                    "SELECT device_id, desktop_id, label, tier, is_primary,
                            paired_at_ms, last_seen_ms
                       FROM paired_devices
                      WHERE desktop_id = ?1 AND revoked_at_ms IS NULL
                      ORDER BY paired_at_ms DESC
                      LIMIT 200",
                )?;
                let devices = statement
                    .query_map([desktop_id], row_to_device)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(devices)
            })
        })
        .await
        .map_err(|err| format!("list devices task: {err}"))?
    }

    pub async fn revoke(&self, device_id: String, now_ms: i64) -> Result<bool, String> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            store.with_connection(|conn| {
                conn.execute(
                    "UPDATE paired_devices
                        SET revoked_at_ms = ?2, is_primary = 0
                      WHERE device_id = ?1 AND revoked_at_ms IS NULL",
                    params![device_id, now_ms],
                )
                .map(|changed| changed > 0)
            })
        })
        .await
        .map_err(|err| format!("revoke device task: {err}"))?
    }

    pub async fn set_primary_desktop(&self, desktop_id: String) -> Result<(), String> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            store.with_connection(|conn| {
                let tx = conn.unchecked_transaction()?;
                tx.execute("UPDATE paired_devices SET is_primary = 0", [])?;
                tx.execute(
                    "UPDATE paired_devices SET is_primary = 1
                      WHERE desktop_id = ?1 AND revoked_at_ms IS NULL",
                    [desktop_id],
                )?;
                tx.commit()
            })
        })
        .await
        .map_err(|err| format!("set primary desktop task: {err}"))?
    }

    pub async fn touch(&self, device_id: String, now_ms: i64) -> Result<(), String> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            store.with_connection(|conn| {
                conn.execute(
                    "UPDATE paired_devices SET last_seen_ms = ?2
                      WHERE device_id = ?1 AND revoked_at_ms IS NULL",
                    params![device_id, now_ms],
                )?;
                Ok(())
            })
        })
        .await
        .map_err(|err| format!("touch device task: {err}"))?
    }
}

pub fn hash_token(raw_token: &str) -> String {
    let digest = Sha256::digest(raw_token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn row_to_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<PairedDeviceInfo> {
    let tier: String = row.get(3)?;
    let tier = match tier.as_str() {
        "read_only" => PermissionTier::ReadOnly,
        "full" => PermissionTier::Full,
        other => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unknown permission tier: {other}"),
                )
                .into(),
            ));
        }
    };
    Ok(PairedDeviceInfo {
        device_id: row.get(0)?,
        desktop_id: row.get(1)?,
        label: row.get(2)?,
        tier,
        is_primary: row.get::<_, i64>(4)? != 0,
        paired_at_ms: row.get(5)?,
        last_seen_ms: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str) -> PairedDeviceInfo {
        PairedDeviceInfo {
            device_id: id.to_string(),
            desktop_id: "desktop-a".to_string(),
            label: "Phone".to_string(),
            tier: PermissionTier::Full,
            is_primary: true,
            paired_at_ms: 100,
            last_seen_ms: None,
        }
    }

    #[tokio::test]
    async fn token_is_hashed_and_revoke_removes_access() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = DeviceStore::open(dir.path().join("relay.sqlite3")).expect("store");
        store
            .activate_device(device("device-1"), "raw-secret".to_string())
            .await
            .expect("activate");

        assert!(store
            .find_active_by_token("raw-secret".to_string())
            .await
            .expect("lookup")
            .is_some());
        assert!(store
            .find_active_by_token("wrong".to_string())
            .await
            .expect("lookup wrong")
            .is_none());

        assert!(store
            .revoke("device-1".to_string(), 200)
            .await
            .expect("revoke"));
        assert!(store
            .find_active_by_token("raw-secret".to_string())
            .await
            .expect("lookup revoked")
            .is_none());
    }

    #[test]
    fn token_hash_never_contains_raw_token() {
        let hash = hash_token("top-secret-device-token");
        assert_eq!(hash.len(), 64);
        assert!(!hash.contains("top-secret"));
    }
}
