//! Gateway session binding.
//!
//! Pins an external chat (telegram/feishu/wecom/...) to a specific agent
//! session so that follow-up messages route directly to the bound OS
//! agent session.
//! decision tree in `GatewayInboundHandler`.
//!
//! The binding key is a pure function of
//! `(channel, chat_id, sender_id?)`, persisted in SQLite so bindings
//! survive restarts.
//!
//! # Key shape
//!
//! `{channel}:{chat_id}[:{sender_id}]`
//!
//! `sender_id` is appended only when `ChannelsConfig::group_sessions_per_user`
//! is enabled. `chat_type` (dm vs group) is not tracked because `chat_id`
//! alone is globally unique within a channel.
//!
//! # Lifecycle
//!
//! - `BindingStore::load_from_db` at gateway startup → hydrate in-memory map
//! - `BindingStore::set(key, session_id)` — written both in-memory and to DB
//! - `BindingStore::get(key)` — in-memory lookup only (hot path)
//! - `BindingStore::clear(key)` — invalidate on `/new` / `/reset` commands

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::bus::InboundMessage;
use crate::channels::config::ChannelsConfig;

/// Deterministic key identifying an external chat for binding lookup.
///
/// Two inbound messages from the same chat produce the same key, letting
/// the gateway route follow-up messages directly to the bound session
/// without re-consulting the LLM.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionKey(pub String);

impl SessionKey {
    /// Derive the session key from an inbound message.
    ///
    /// Re-injected messages carry an existing `session_key_override`
    /// and do not participate in binding — callers short-circuit those before
    /// calling this function.
    pub fn from_inbound(msg: &InboundMessage, config: &ChannelsConfig) -> Self {
        let mut key = format!("{}:{}", msg.channel, msg.chat_id);
        if config.group_sessions_per_user && !msg.sender_id.is_empty() {
            key.push(':');
            key.push_str(&msg.sender_id);
        }
        SessionKey(key)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A single binding row (`session_key` → `target_session_id`).
///
/// Two timestamps serve different purposes (idle-reset policy, aligned
/// with hermes `SessionEntry.updated_at` in `gateway/session.py:341`):
/// - `updated_at` — last time the binding was (re)written. Durable in DB,
///   survives restarts. Used for restart-side staleness checks.
/// - `last_activity_at` — touched on every inbound message that hits an existing binding from
///   messages so idle-reset policy uses the true "recent conversation"
///   timestamp, not just "last rebind". Touch is in-memory only (hot
///   path); a periodic debounce flush could sync to DB but is not
///   required for correctness because the worst outcome on restart is
///   an overly cautious reset (falls back to `updated_at`).
#[derive(Debug, Clone)]
pub struct SessionBinding {
    pub session_key: SessionKey,
    pub target_session_id: String,
    pub updated_at: String,
    pub last_activity_at: String,
}

/// In-memory binding cache backed by SQLite `gateway_bindings`.
///
/// Writes go to both memory and SQLite; reads hit memory only. Missing
/// keys return `None` — callers create a new OS session.
#[derive(Debug, Default)]
pub struct BindingStore {
    inner: Arc<RwLock<HashMap<String, SessionBinding>>>,
}

impl BindingStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hydrate the in-memory map from the `gateway_bindings` SQLite table.
    /// Idempotent — call once during gateway startup.
    pub async fn load_from_db(&self) -> SqliteResult<usize> {
        let rows = tokio::task::spawn_blocking(|| -> SqliteResult<Vec<SessionBinding>> {
            let conn = database::db::get_connection()?;
            ensure_table(&conn)?;
            let mut stmt = conn.prepare(
                "SELECT session_key, target_session_id, updated_at, last_activity_at
                   FROM gateway_bindings",
            )?;
            let iter = stmt.query_map([], |row| {
                let updated_at: String = row.get(2)?;
                let last_activity_at: Option<String> = row.get(3)?;
                Ok(SessionBinding {
                    session_key: SessionKey(row.get::<_, String>(0)?),
                    target_session_id: row.get::<_, String>(1)?,
                    last_activity_at: last_activity_at.unwrap_or_else(|| updated_at.clone()),
                    updated_at,
                })
            })?;
            iter.collect()
        })
        .await
        .map_err(|err| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                err.to_string(),
            )))
        })??;

        let count = rows.len();
        let mut guard = self.inner.write().await;
        guard.clear();
        for b in rows {
            guard.insert(b.session_key.0.clone(), b);
        }
        info!("[gateway] Loaded {} binding(s) from db", count);
        Ok(count)
    }

    /// Look up the target session for a chat. Hot path — read-only memory.
    pub async fn get(&self, key: &SessionKey) -> Option<SessionBinding> {
        let guard = self.inner.read().await;
        guard.get(&key.0).cloned()
    }

    /// Pin `session_key` to `target_session_id`. Writes both in memory and
    /// to SQLite synchronously. Errors from the DB tier are logged but do
    /// not fail the call — in-memory cache still serves follow-up reads
    /// until process restart.
    pub async fn set(&self, key: SessionKey, target_session_id: String) {
        self.set_with_activity(key, target_session_id, chrono::Utc::now().to_rfc3339())
            .await;
    }

    /// Pin `session_key` to `target_session_id` while preserving a caller-provided
    /// activity timestamp. Used by channel session switching so rebinding to an
    /// older session does not pretend a new message was sent in that target.
    pub async fn set_with_activity(
        &self,
        key: SessionKey,
        target_session_id: String,
        last_activity_at: String,
    ) {
        let now = chrono::Utc::now().to_rfc3339();
        let binding = SessionBinding {
            session_key: key.clone(),
            target_session_id: target_session_id.clone(),
            updated_at: now.clone(),
            last_activity_at: last_activity_at.clone(),
        };
        {
            let mut guard = self.inner.write().await;
            guard.insert(key.0.clone(), binding);
        }
        let key_str = key.0.clone();
        let ts = now;
        if let Err(err) = tokio::task::spawn_blocking(move || -> SqliteResult<()> {
            let conn = database::db::get_connection()?;
            ensure_table(&conn)?;
            conn.execute(
                "INSERT INTO gateway_bindings
                    (session_key, target_session_id, updated_at, last_activity_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(session_key) DO UPDATE SET
                     target_session_id = excluded.target_session_id,
                     updated_at        = excluded.updated_at,
                     last_activity_at  = excluded.last_activity_at",
                params![key_str, target_session_id, ts, last_activity_at],
            )?;
            Ok(())
        })
        .await
        {
            warn!("[gateway] Binding DB write task join failed: {}", err);
        }
    }

    /// Debug-only: backdate `last_activity_at` for `session_key_str` to
    /// an explicit ISO-8601 timestamp so E2E can trip the idle-reset
    /// threshold without sleeping `idle_minutes`. Returns
    /// `true` when the key existed and the write landed. Production
    /// code must not call this — only the `/test/gateway/...` debug
    /// endpoint does.
    #[cfg(debug_assertions)]
    pub async fn test_backdate(&self, session_key_str: &str, timestamp_iso: &str) -> bool {
        let mut guard = self.inner.write().await;
        if let Some(binding) = guard.get_mut(session_key_str) {
            binding.last_activity_at = timestamp_iso.to_string();
            true
        } else {
            false
        }
    }

    /// Refresh `last_activity_at` on binding hits. In-memory only — callers
    /// invoke this on every inbound message that hits an existing binding.
    /// Hermes parallel: `SessionStore.touch_session` in
    /// `gateway/session.py:502-515` which updates `updated_at` on every
    /// read of `get_or_create_session`.
    pub async fn touch(&self, key: &SessionKey) {
        let now = chrono::Utc::now().to_rfc3339();
        let mut guard = self.inner.write().await;
        if let Some(binding) = guard.get_mut(&key.0) {
            binding.last_activity_at = now;
        }
    }

    /// Return every binding whose `last_activity_at` is older than
    /// `now - idle_minutes`. Hermes parallel: `_is_session_expired` in
    /// `gateway/session.py:582`.
    pub async fn list_expired(
        &self,
        now: chrono::DateTime<chrono::Utc>,
        idle_minutes: u64,
    ) -> Vec<SessionBinding> {
        let cutoff = now - chrono::Duration::minutes(idle_minutes as i64);
        let guard = self.inner.read().await;
        guard
            .values()
            .filter(|b| {
                chrono::DateTime::parse_from_rfc3339(&b.last_activity_at)
                    .map(|ts| ts.with_timezone(&chrono::Utc) < cutoff)
                    .unwrap_or(false)
            })
            .cloned()
            .collect()
    }

    /// Reverse lookup: find the binding (if any) whose `target_session_id`
    /// equals `session_id`. Used by the compact-fork detector in
    /// `UnifiedProcessor` to decide whether an in-place compact must be
    /// upgraded to a compact-fork.
    ///
    /// O(n) in number of bindings — acceptable because active gateway
    /// bindings per host are small (dozens, not millions).
    pub async fn find_by_target(&self, session_id: &str) -> Option<SessionBinding> {
        let guard = self.inner.read().await;
        guard
            .values()
            .find(|b| b.target_session_id == session_id)
            .cloned()
    }

    /// Remove the binding for `key` (both memory and DB). Used by `/new`
    /// and `/reset` commands so the next message re-routes via the LLM.
    pub async fn clear(&self, key: &SessionKey) {
        {
            let mut guard = self.inner.write().await;
            guard.remove(&key.0);
        }
        let key_str = key.0.clone();
        if let Err(err) = tokio::task::spawn_blocking(move || -> SqliteResult<()> {
            let conn = database::db::get_connection()?;
            ensure_table(&conn)?;
            conn.execute(
                "DELETE FROM gateway_bindings WHERE session_key = ?1",
                params![key_str],
            )?;
            Ok(())
        })
        .await
        {
            warn!("[gateway] Binding DB delete task join failed: {}", err);
        }
    }

    /// Snapshot of all active bindings (for debug endpoints + observability).
    pub async fn snapshot(&self) -> Vec<SessionBinding> {
        let guard = self.inner.read().await;
        guard.values().cloned().collect()
    }
}

/// Create the `gateway_bindings` table if it does not exist.
///
/// Schema is append-only — additional columns added later are ALTERed in
/// place. Existing rows get `last_activity_at = updated_at` via the
/// hydration path (`load_from_db` COALESCE), not via a DEFAULT clause,
/// because SQLite rejects non-constant DEFAULTs.
fn ensure_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS gateway_bindings (
            session_key        TEXT PRIMARY KEY,
            target_session_id  TEXT NOT NULL,
            updated_at         TEXT NOT NULL
        )",
        [],
    )?;
    // Add `last_activity_at` column on existing databases.
    // `ALTER TABLE ADD COLUMN` is idempotent via the error check below.
    if let Err(err) = conn.execute(
        "ALTER TABLE gateway_bindings ADD COLUMN last_activity_at TEXT",
        [],
    ) {
        let msg = err.to_string();
        if !msg.contains("duplicate column name") {
            return Err(err);
        }
    }
    Ok(())
}

// ============================================
// Unit tests (session key derivation only — store tests live in E2E)
// ============================================

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(channel: &str, chat_id: &str, sender_id: &str) -> InboundMessage {
        InboundMessage::new(channel, sender_id, chat_id, "hi")
    }

    #[test]
    fn session_key_shared_chat_default() {
        let cfg = ChannelsConfig::default();
        assert!(!cfg.group_sessions_per_user);
        let key = SessionKey::from_inbound(&msg("telegram", "-1001234", "user-42"), &cfg);
        assert_eq!(key.as_str(), "telegram:-1001234");
    }

    #[test]
    fn session_key_per_user_when_configured() {
        let cfg = ChannelsConfig {
            group_sessions_per_user: true,
            ..Default::default()
        };
        let key = SessionKey::from_inbound(&msg("feishu", "chat-xyz", "user-99"), &cfg);
        assert_eq!(key.as_str(), "feishu:chat-xyz:user-99");
    }

    #[test]
    fn session_key_ignores_empty_sender_even_when_per_user() {
        let cfg = ChannelsConfig {
            group_sessions_per_user: true,
            ..Default::default()
        };
        let key = SessionKey::from_inbound(&msg("wecom", "chatroom-1", ""), &cfg);
        assert_eq!(key.as_str(), "wecom:chatroom-1");
    }

    #[tokio::test]
    async fn touch_updates_last_activity_only() {
        let store = BindingStore::new();
        let key = SessionKey("telegram:42".into());
        store.inner.write().await.insert(
            key.0.clone(),
            SessionBinding {
                session_key: key.clone(),
                target_session_id: "osagent-telegram-42".into(),
                updated_at: "2020-01-01T00:00:00Z".into(),
                last_activity_at: "2020-01-01T00:00:00Z".into(),
            },
        );
        store.touch(&key).await;
        let after = store.get(&key).await.unwrap();
        assert_eq!(after.updated_at, "2020-01-01T00:00:00Z");
        assert_ne!(after.last_activity_at, "2020-01-01T00:00:00Z");
    }

    #[tokio::test]
    async fn list_expired_filters_by_last_activity() {
        let store = BindingStore::new();
        let now = chrono::Utc::now();
        let fresh_key = SessionKey("telegram:fresh".into());
        let stale_key = SessionKey("telegram:stale".into());
        {
            let mut g = store.inner.write().await;
            g.insert(
                fresh_key.0.clone(),
                SessionBinding {
                    session_key: fresh_key.clone(),
                    target_session_id: "osagent-fresh".into(),
                    updated_at: now.to_rfc3339(),
                    last_activity_at: now.to_rfc3339(),
                },
            );
            g.insert(
                stale_key.0.clone(),
                SessionBinding {
                    session_key: stale_key.clone(),
                    target_session_id: "osagent-stale".into(),
                    updated_at: now.to_rfc3339(),
                    last_activity_at: (now - chrono::Duration::hours(2)).to_rfc3339(),
                },
            );
        }
        let expired = store.list_expired(now, 60).await;
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].session_key.as_str(), "telegram:stale");
    }

    #[tokio::test]
    async fn find_by_target_returns_owner_binding() {
        let store = BindingStore::new();
        let key = SessionKey("discord:1".into());
        store.inner.write().await.insert(
            key.0.clone(),
            SessionBinding {
                session_key: key.clone(),
                target_session_id: "osagent-discord-1".into(),
                updated_at: "x".into(),
                last_activity_at: "x".into(),
            },
        );
        let hit = store.find_by_target("osagent-discord-1").await.unwrap();
        assert_eq!(hit.session_key.as_str(), "discord:1");
        assert!(store.find_by_target("osagent-nope").await.is_none());
    }

    #[test]
    fn session_key_dm_unchanged_across_configs() {
        let mut cfg = ChannelsConfig::default();
        let msg_a = msg("telegram", "123456", "123456");
        let k1 = SessionKey::from_inbound(&msg_a, &cfg);
        cfg.group_sessions_per_user = true;
        let k2 = SessionKey::from_inbound(&msg_a, &cfg);
        assert_eq!(k1.as_str(), "telegram:123456");
        // Even with per-user enabled, a DM chat where chat_id and sender_id
        // happen to match still collapses to a unique session naturally; the
        // appended sender just makes it redundantly explicit but still
        // deterministic.
        assert_eq!(k2.as_str(), "telegram:123456:123456");
    }
}
